/**
 * Golden scenarios for the prompt eval harness.
 *
 * Each scenario is a hand-built CommentaryDraftInput plus metadata
 * the evaluator needs (momentContext, availableSources). They cover
 * the major code paths in commentaryPrompts.ts + the persona / kind
 * branches in openAICommentaryProvider so a prompt change can't
 * regress one path while improving another invisibly.
 *
 * Adding a scenario: keep it minimal — only set the input fields
 * that exercise the code path you care about. Reuse demoLeagueState
 * + demoPlays for realistic shape; build small overrides for the
 * variations (cue, swing, fantasy impact, etc.) so prompts see the
 * fields that drive each branch.
 */

import { demoLeagueState, demoPlays } from "../src/providers/demoData";
import type { CommentaryDraftInput } from "../src/providers/commentaryPrompts";
import type {
  FantasyRoster,
  GroupSettings,
  ListenerCue,
  MarketSnapshot,
  SportsPlay,
  VideoObservation
} from "../src/shared/contracts";

const baseObservation: VideoObservation = {
  id: "obs-baseline",
  source: "stream-url",
  summary: "Validated sports frame.",
  confidence: 0.9,
  observedAt: "2026-05-19T20:00:00Z",
  latencyMs: 50,
  usedFrame: false
};

const baseGroup: GroupSettings = {
  listener: { name: "Marc", rosterId: "roster-alex" },
  tone: "pg",
  homeTeamBias: "fantasy-first",
  friends: [
    { id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" },
    { id: "sam", name: "Sam", favoriteTeam: "DET", rosterId: "roster-maya" }
  ]
};

// Listener's roster — pulled from demoLeagueState for a realistic
// starter list. The opener + listener-cue scenarios cite these.
const listenerRoster: FantasyRoster | undefined =
  demoLeagueState.matchups[0]?.rosters.find((r) => r.id === "roster-alex");

const listenerCue = (text: string): ListenerCue => ({
  id: `cue-${text.slice(0, 6).replace(/\s+/g, "-")}`,
  text,
  capturedAt: "2026-05-19T20:00:30Z"
});

const market = (overrides: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  source: "kalshi",
  externalId: "kalshi-kc-win",
  sport: "nfl",
  marketKind: "moneyline",
  title: "Chiefs win at home",
  outcomeLabel: "Yes",
  yesPriceCents: 62,
  observedAt: "2026-05-19T20:00:00Z",
  ...overrides
});

const baseInput = (overrides: Partial<CommentaryDraftInput> = {}): CommentaryDraftInput => ({
  play: demoPlays[0],
  observation: baseObservation,
  impacts: [],
  group: baseGroup,
  news: [],
  recentCommentary: [],
  fallbackText: "Hosts are getting their footing — we'll take this one on the next swing.",
  hostId: "theo",
  listenerRoster,
  ...overrides
});

type Scenario = {
  /** Stable id used as turnId in the evaluator. */
  id: string;
  /** One-line description for the report. */
  description: string;
  input: CommentaryDraftInput;
  /** Plain-English moment context for the evaluator's pacing /
   *  energy-match judgment. Should match what the play actually is. */
  momentContext: string;
  /** What signals were available to the producer — for the
   *  evaluator's "generic despite rich signals?" check. */
  availableSources: string[];
};

export const scenarios: Scenario[] = [
  {
    id: "opener-with-roster",
    description: "Opener for a listener with a full roster loaded.",
    input: baseInput({ kind: "opener" }),
    momentContext: "Show opener: introduce the listener and their lineup.",
    availableSources: ["fantasy", "roster", "play"]
  },
  {
    id: "opener-anonymous",
    description: "Opener with no listener name (demo / no-profile flow).",
    input: baseInput({
      kind: "opener",
      group: { ...baseGroup, listener: { name: "", rosterId: undefined } },
      listenerRoster: undefined
    }),
    momentContext: "Show opener for an anonymous demo session.",
    availableSources: ["play"]
  },
  {
    id: "routine-play",
    description: "Low-excitement play — should stay quiet, not over-call it.",
    input: baseInput({
      play: { ...demoPlays[3] } as SportsPlay // first-down, low excitement
    }),
    momentContext: "Routine first down — listener doesn't need a hot take here.",
    availableSources: ["play"]
  },
  {
    id: "big-play-touchdown",
    description: "Touchdown with fantasy impact on the listener's starter.",
    input: baseInput({
      play: demoPlays[1], // Kelce touchdown
      impacts: [
        {
          rosterId: "roster-alex",
          ownerName: "Marc",
          teamName: "Fourth & Snack",
          playerName: "Travis Kelce",
          pointsDelta: 6.4,
          isStarter: true,
          reason: "TD reception"
        }
      ]
    }),
    momentContext: "Touchdown for the listener's starter — peak fantasy moment.",
    availableSources: ["fantasy", "play"]
  },
  {
    id: "turnover-bad-news",
    description: "Turnover — should hit the friction / 'brutal' register.",
    input: baseInput({
      play: {
        ...demoPlays[3],
        id: "play-int-1",
        type: "turnover",
        excitement: 5,
        headline: "Mahomes intercepted at midfield",
        description: "Pass tipped at the line, intercepted by linebacker.",
        team: "KC"
      } as SportsPlay,
      impacts: [
        {
          rosterId: "roster-alex",
          ownerName: "Marc",
          teamName: "Fourth & Snack",
          playerName: "Patrick Mahomes",
          pointsDelta: -2.8,
          isStarter: true,
          reason: "Interception"
        }
      ]
    }),
    momentContext: "Listener's QB throws an INT — fantasy points and emotional stakes both bad.",
    availableSources: ["fantasy", "play"]
  },
  {
    id: "listener-cue-direct-question",
    description: "Listener asked a direct question — hosts must answer it.",
    input: baseInput({
      listenerCues: [listenerCue("Should I trade away Kelce while he's hot?")]
    }),
    momentContext: "Listener push-to-talk question about a roster move.",
    availableSources: ["listener", "fantasy", "play"]
  },
  {
    id: "market-swing",
    description: "Live market move — host should open with the move.",
    input: baseInput({
      markets: [market({ recentDeltaCents: 8 })],
      marketSwing: {
        market: market(),
        deltaCents: 8,
        direction: "warming",
        windowMs: 5 * 60 * 1000
      } as CommentaryDraftInput["marketSwing"]
    }),
    momentContext: "Kalshi 'Chiefs win' market just moved +8 cents in 5 minutes.",
    availableSources: ["markets", "play"]
  },
  {
    id: "pregame-no-impact-no-cue",
    description: "Quiet pregame stretch — no impacts, no cue, no swing.",
    input: baseInput({
      play: {
        ...demoPlays[0],
        type: "other",
        excitement: 1,
        headline: "Coin toss — Chiefs receive",
        description: "Chiefs win the toss, deferred — pregame settle in.",
        period: { number: 1, kind: "quarter" },
        clock: "15:00"
      } as SportsPlay
    }),
    momentContext: "Coin toss complete, kickoff coming — no real event yet.",
    availableSources: ["play"]
  }
];
