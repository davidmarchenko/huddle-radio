/**
 * Slate ranker — turns a flat list of tonight's games into an
 * ORDERED, personalized rotation for the discovery-feed-driven show.
 *
 * The discovery feed has no concept of "which game?" — the listener
 * just hits play and trusts the producer to surface what matters.
 * The engine then boots in slate mode: it walks this ranking from
 * the top, fires the show open on entry #1, and auto-pivots to entry
 * #N+1 when entry #N reaches `final`.
 *
 * Scoring is intentionally HEURISTIC, not LLM-backed. Slate ranking
 * is read once at show start (and again when the slate changes) —
 * not a per-tick decision — so a deterministic, cheap rank function
 * is both faster and more debuggable than a model call. Weights here
 * are the editorial knobs to twist when the rank doesn't feel right.
 */
import type {
  FantasyRoster,
  GroupSettings,
  SportsGameOption
} from "../shared/contracts";

export type RankedSlateEntry = {
  game: SportsGameOption;
  /** Composite score — higher is more interesting to this listener.
   *  Surfaced for diagnostics so an editorial mismatch ("why is the
   *  blowout above my starter's game?") can be debugged from logs. */
  score: number;
  /** Per-factor breakdown — cheap to compute, expensive to lose.
   *  Surface in the UI rank chip as a tooltip; surface in turn
   *  summaries when slate mode auto-pivots. */
  reasons: SlateReason[];
};

export type SlateReason =
  | { kind: "starter-in-game"; playerName: string; team: string }
  | { kind: "favorite-team"; team: string }
  | { kind: "live-game" }
  | { kind: "marquee-matchup"; teams: [string, string] }
  | { kind: "scheduled-soon"; minutesAway: number }
  | { kind: "friend-rivalry"; friendName: string; team: string };

/**
 * Marquee teams whose mere presence raises a game's interest baseline
 * even without listener anchors. Kept narrow — only the franchises
 * that meaningfully move dial across a sports-fan baseline. Adjust
 * here when the editorial signal feels off rather than threading a
 * per-show config through every layer.
 */
const MARQUEE_TEAMS = new Set([
  "LAL", "BOS", "GSW", "NYK", // NBA gravity
  "KC", "DAL", "BUF", "GB", "SF", "PHI", // NFL gravity
  "NYY", "LAD", // MLB gravity
  "LV", "NY" // WNBA gravity
]);

const NOW_MS = () => Date.now();

export type SlateRankerInput = {
  candidates: SportsGameOption[];
  group: GroupSettings;
  /** Listener's fantasy roster for the active league. When absent,
   *  starter-anchored scoring is skipped — the slate still ranks,
   *  just without the personalization boost. */
  listenerRoster?: FantasyRoster;
  /** Friend rosters keyed by rosterId. Used to surface friend-room
   *  rivalry beats — a game where the listener's rival's starter is
   *  playing scores higher than a generic matchup. */
  friendRosters?: Record<string, FantasyRoster>;
  /** Inject for tests; falls back to wall clock. */
  now?: () => number;
};

export function rankSlate(input: SlateRankerInput): RankedSlateEntry[] {
  const now = input.now ?? NOW_MS;
  const starters = input.listenerRoster?.starters ?? [];
  const starterTeams = new Set(starters.map((s) => s.proTeam.toUpperCase()));
  const starterByTeam = new Map<string, { name: string; proTeam: string }>();
  for (const s of starters) starterByTeam.set(s.proTeam.toUpperCase(), { name: s.name, proTeam: s.proTeam });
  const favoriteTeam = input.group.listener.favoriteTeam?.toUpperCase();
  const friendTeams: Array<{ friendName: string; team: string }> = [];
  for (const friend of input.group.friends) {
    if (friend.favoriteTeam) friendTeams.push({ friendName: friend.name, team: friend.favoriteTeam.toUpperCase() });
    const friendRoster = friend.rosterId ? input.friendRosters?.[friend.rosterId] : undefined;
    for (const starter of friendRoster?.starters ?? []) {
      friendTeams.push({ friendName: friend.name, team: starter.proTeam.toUpperCase() });
    }
  }

  const entries = input.candidates.map((game) => {
    let score = 0;
    const reasons: SlateReason[] = [];
    const teams = [game.awayTeam.toUpperCase(), game.homeTeam.toUpperCase()];

    // Per-team scoring. Iterating both teams catches the case where
    // the listener has starters on BOTH sides (a real fantasy
    // situation — points for either team are points for the listener).
    for (const team of teams) {
      const starter = starterByTeam.get(team);
      if (starter) {
        score += 50;
        reasons.push({ kind: "starter-in-game", playerName: starter.name, team });
      }
      if (favoriteTeam && team === favoriteTeam) {
        // Higher than the combined marquee-matchup bonus on purpose:
        // a listener's favorite team is more interesting to THEM than
        // a generic blue-blood matchup is to anyone. Lakers-Celtics
        // beats most things, but not "your team is playing."
        score += 40;
        reasons.push({ kind: "favorite-team", team });
      }
      if (MARQUEE_TEAMS.has(team)) {
        score += 8;
      }
      for (const friend of friendTeams) {
        if (friend.team === team) {
          score += 10;
          reasons.push({ kind: "friend-rivalry", friendName: friend.friendName, team });
        }
      }
    }
    // Marquee matchup bonus — only fires when BOTH teams are
    // marquee, so it doesn't double-count one big franchise vs a
    // small-market team.
    if (MARQUEE_TEAMS.has(teams[0]) && MARQUEE_TEAMS.has(teams[1])) {
      score += 15;
      reasons.push({ kind: "marquee-matchup", teams: [teams[0], teams[1]] });
    }

    // Liveness scoring. Live games are the highest-priority for an
    // active broadcast; scheduled games starting soon are next;
    // final games are the floor (the listener might still want a
    // wrap-up but the action is over).
    if (game.status === "live") {
      score += 30;
      reasons.push({ kind: "live-game" });
    } else if (game.status === "scheduled" && game.startsAt) {
      const minutesAway = Math.round((new Date(game.startsAt).getTime() - now()) / 60_000);
      if (minutesAway >= 0 && minutesAway <= 30) {
        // Imminent — about to tip.
        score += 20;
        reasons.push({ kind: "scheduled-soon", minutesAway });
      } else if (minutesAway > 30 && minutesAway <= 120) {
        // Later tonight.
        score += 10;
        reasons.push({ kind: "scheduled-soon", minutesAway });
      }
    } else if (game.status === "final") {
      score -= 20; // Final games sit at the bottom unless boosted by personalization.
    }

    return { game, score, reasons };
  });

  // Stable sort by score desc, then by startsAt asc as a tiebreaker
  // so earlier games come first when two share a score.
  return entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aStart = a.game.startsAt ? new Date(a.game.startsAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bStart = b.game.startsAt ? new Date(b.game.startsAt).getTime() : Number.MAX_SAFE_INTEGER;
    return aStart - bStart;
  });
}

/**
 * Slate-context summary for the producer's opener. Captures what the
 * hosts should reference when the show is started in discovery mode:
 * "eight games tonight, three of your starters live, here's where
 * we're opening."
 */
export type SlateContext = {
  /** Total number of games on the slate the listener could be on. */
  totalGames: number;
  /** Games where at least one of the listener's starters is on the
   *  field/court. Used to brag "three of your guys are live" in the
   *  opener. */
  starterGames: number;
  /** Friendly summary of the slate — names the top-ranked alternatives
   *  past the lead game. Used by the opener producer to surface
   *  "we're starting with X, then we'll check in on Y and Z." */
  upcomingHighlights: string[];
};

export function summarizeSlate(
  ranked: RankedSlateEntry[],
  options: { listenerStarterTeams: Set<string> } = { listenerStarterTeams: new Set() }
): SlateContext {
  const starterGames = ranked.filter((entry) => {
    const teams = [entry.game.awayTeam.toUpperCase(), entry.game.homeTeam.toUpperCase()];
    return teams.some((t) => options.listenerStarterTeams.has(t));
  }).length;
  // Skip the lead game (index 0) — the opener is already anchored on
  // it. Surface up to two "what's next" highlights.
  const upcomingHighlights = ranked
    .slice(1, 3)
    .map((entry) => `${entry.game.awayTeam} at ${entry.game.homeTeam}`);
  return {
    totalGames: ranked.length,
    starterGames,
    upcomingHighlights
  };
}
