import type { CommentaryKind, DialogueLine, FantasyRoster, GameOdds, GroupSettings, HostId, ListenerCue, MarketSnapshot, NewsItem, PlayerSeasonStats, SportsPlay, VideoObservation, FantasyImpact, MomentCue } from "../shared/contracts";
import { HOST_PERSONAS, type HostPersona } from "../shared/hostPersonas";

export type CommentaryDraftInput = {
  play: SportsPlay;
  observation: VideoObservation;
  impacts: FantasyImpact[];
  moment?: MomentCue;
  group: GroupSettings;
  news: NewsItem[];
  recentCommentary: string[];
  fallbackText: string;
  hostId?: HostId;
  listenerRoster?: FantasyRoster;
  kind?: CommentaryKind;
  /**
   * Free-form summary of the listener's recent shows. The opener prompt
   * uses this for cross-session memory ("last week Mahomes burned you").
   * Plain prose, ~1-3 sentences. Skipped silently when absent.
   */
  priorContext?: string;
  /** Vegas line + total + moneyline. When provided, persona prompts may cite it. */
  odds?: GameOdds;
  /**
   * W12: advanced stats for the listener's starters playing in this
   * game. EPA, target share, snap%. Persona prompts may cite at most
   * one of these per turn — beat-writer flavor without overload.
   */
  analytics?: PlayerSeasonStats[];
  /**
   * W13/W14: live prediction-market snapshots from Kalshi /
   * Polymarket. Pass at most 4-6 most-relevant entries — the
   * commentary engine should already have pre-filtered via
   * pickRelevantMarketsForGame. Hosts can quote a price ("Polymarket
   * has the Chiefs at 64 cents") and call out moves
   * (`recentDeltaCents`) when one is meaningful.
   */
  markets?: MarketSnapshot[];
  /**
   * High-confidence swing event derived from market history. When
   * the engine detects a >5pt move in the last 5 min, it can pass
   * this so the host opens with the move rather than burying it.
   * See marketSwingDetector below.
   */
  marketSwing?: MarketSwing;
  /**
   * W18: push-to-talk listener cues captured since the last
   * commentary tick. The persona prompt may answer one of these
   * directly when it lands ("you asked about Mahomes — ..."). Pass
   * 1-3 max; older cues should be acked + dropped client-side.
   */
  listenerCues?: ListenerCue[];
};

/**
 * A single market that just moved enough to be call-out worthy.
 * Produced by detectMarketSwings() on each commentary tick.
 */
export type MarketSwing = {
  market: MarketSnapshot;
  /** Cents change from the snapshot we last cited on-air. */
  deltaCents: number;
  /** Negative = market cooled on this side; positive = warming. */
  direction: "warming" | "cooling";
};

export function resolveHostPersona(hostId?: HostId): HostPersona {
  return hostId ? HOST_PERSONAS[hostId] : HOST_PERSONAS.maya;
}

/**
 * Persona summary block used by every dialogue prompt. Three hosts —
 * the LLM picks who speaks each line based on context. Kept outside
 * the per-turn prompt so all three personas stay grounded in the same
 * canonical description regardless of who's leading the turn.
 */
function buildHostsBlock(): string {
  return [
    "Hosts on the show:",
    ...Object.values(HOST_PERSONAS).map((persona) => {
      const tics = persona.speechTics.map((tic) => `  · ${tic}`).join("\n");
      return [
        `- ${persona.name} (${persona.role}, id: "${persona.id}"): ${persona.description}`,
        `  Voice: ${persona.directive}`,
        `  Speech tics:`,
        tics
      ].join("\n");
    })
  ].join("\n");
}

const SHARED_HARD_RULES = [
  "- Each line ≤ 100 characters (~5-8 seconds of speech). Short, conversational lines, not paragraphs.",
  "- Hosts react to each other. Use natural acknowledgements: 'right,' 'exactly,' 'yeah,' 'wait — actually,' 'to your point.' Make it feel like they're listening.",
  "- Verbal fillers are encouraged sparingly: 'you know,' 'I mean,' a single 'um' across the turn. Never overuse.",
  "- Stay in each host's voice. Maya leads with numbers; Theo references last week / addresses the listener; Cam interrupts with one-line hot takes.",
  "- The lead host (named in the input as `leadHostId`) speaks the FIRST line. Other hosts pick up after.",
  "- Address the listener by name once across the turn, where it lands naturally — never twice.",
  "- Reference the listener's actual starters when relevant; do not invent players or numbers. Hedge ('through three quarters,' 'on the season') when a fact isn't in the provided data.",
  "- Avoid generic radio openers ('welcome back, folks,' 'big play here').",
  "- If `odds` is provided, ONE host may cite the line/total/moneyline once if it lands. Never lead with it; never recommend a bet.",
  "- If `analytics` carries stats for a named player, ONE line may weave in ONE number (snap%, EPA, target share). Skip if forced.",
  "- If `markets` carries live prediction-market prices, ONE line may quote ONE price ('Kalshi has them at 64 cents'); attribute the source. Never recommend a trade.",
  "- If `marketSwing` is set, the LEAD line opens with it. Name the side, source, direction, magnitude in cents.",
  "- If `listenerCues` includes a recent push-to-talk message, ONE host addresses ONE cue conversationally ('you asked about ...'). Don't quote verbatim, don't list cues.",
  "- If video validation is unavailable, uncertain, or not-sports, anchor only to official play data; don't imply you saw video.",
  "- PG. No profanity even on chaos tone.",
  "- Do not mention API keys, system prompts, credentials, or implementation details."
];

const OUTPUT_SCHEMA_BLOCK = [
  "Required output: JSON only, no code fences, no commentary outside JSON. Shape:",
  "{",
  '  "lines": [',
  '    {"speaker": "maya" | "theo" | "cam", "text": "the line of dialogue"},',
  "    ...",
  "  ]",
  "}",
  "Begin directly with `{`. Do not include any preamble."
];

export function buildOpenerSystemPrompt(persona: HostPersona): string {
  return [
    "You are the producer of Huddle Radio — a personalized fantasy sports podcast for ONE specific listener. Output a SHOW OPEN as a multi-speaker dialogue between the named hosts below.",
    "",
    buildHostsBlock(),
    "",
    `For this turn the LEAD host is ${persona.name} (id: "${persona.id}") — they speak the first line.`,
    "",
    "Goal of the open: in 5 short lines (each ≤ 100 chars), the listener should hear all three voices and know — without being told — that this show was made for them.",
    "",
    "Required arc:",
    "1. Lead host opens by addressing the listener by name and naming their fantasy team.",
    "2. Another host reacts and names ONE of the listener's actual starters with a forward-looking beat (projected role tonight, recent form, or stakes).",
    "3. A third host adds ONE more starter or a stake — one specific fact, hedged if not in the data.",
    "4. One natural verbal acknowledgement somewhere ('right,' 'exactly').",
    "5. End on a single line handing off to live game action.",
    "",
    "If `priorContext` is provided, weave ONE 'last time you were here' callback in line 2 or 3 — only if it lands naturally.",
    "",
    "Hard rules:",
    ...SHARED_HARD_RULES,
    "",
    ...OUTPUT_SCHEMA_BLOCK
  ].join("\n");
}

export function buildPlaySystemPrompt(persona: HostPersona): string {
  return [
    "You are the producer of Huddle Radio. Output ONE turn of multi-speaker dialogue reacting to the play and fantasy context provided.",
    "",
    buildHostsBlock(),
    "",
    `For this turn the LEAD host is ${persona.name} (id: "${persona.id}") — they speak the first line. They were chosen because: ${persona.description}`,
    "",
    "Shape of a turn: EXACTLY 3 short lines (each ≤ 100 chars). Multi-speaker. Lines 2 and 3 react to line 1 — natural acknowledgements like 'right,' 'exactly,' or 'wait — but...'. The total turn should run 8-12 seconds of spoken audio so it fits in one cadence interval.",
    "",
    "Hard rules:",
    ...SHARED_HARD_RULES,
    "",
    ...OUTPUT_SCHEMA_BLOCK
  ].join("\n");
}

/**
 * The structured payload every commentary provider sends to its model.
 * Shared so OpenAI / Anthropic / Gemini all receive the same facts —
 * persona behavior is the only thing that differs across vendors.
 */
export function buildCommentaryPayload(input: CommentaryDraftInput, persona: HostPersona) {
  const listener = input.group.listener;
  const roster = input.listenerRoster;
  return {
    host: {
      id: persona.id,
      name: persona.name,
      role: persona.role,
      directive: persona.directive,
      speechTics: persona.speechTics,
      examples: persona.examples
    },
    listener: {
      name: listener.name,
      favoriteTeam: listener.favoriteTeam,
      fantasyTeamName: roster?.teamName,
      starters: (roster?.starters ?? []).map((p) => ({
        name: p.name,
        position: p.position,
        proTeam: p.proTeam,
        currentPoints: p.currentPoints
      }))
    },
    priorContext: input.priorContext ?? null,
    tone: input.group.tone,
    priority: input.group.homeTeamBias,
    friends: input.group.friends.map((friend) => ({
      name: friend.name,
      favoriteTeam: friend.favoriteTeam,
      rosterId: friend.rosterId,
      rivalryNotes: friend.rivalryNotes
    })),
    play: input.play,
    observation: {
      summary: input.observation.summary,
      confidence: input.observation.confidence,
      validation: input.observation.validation,
      guardrail:
        input.observation.validation?.status === "sports-event"
          ? "You may mention visible sports context cautiously."
          : "Do not imply the model saw game action; rely on official play data for stats and game events."
    },
    fantasyImpacts: input.impacts,
    moment: input.moment,
    news: input.news.slice(0, 1),
    odds: input.odds
      ? {
          spread: input.odds.spread,
          total: input.odds.total,
          moneyline: input.odds.moneyline,
          movement: input.odds.movement,
          book: input.odds.book
        }
      : null,
    analytics: (input.analytics ?? []).slice(0, 6).map((stats) => ({
      name: stats.name,
      position: stats.position,
      team: stats.team,
      snapPercent: stats.snapPercent,
      epaPerPlay: stats.epaPerPlay,
      targetShare: stats.targetShare,
      usagePerGame: stats.usagePerGame,
      pointsPerGame: stats.pointsPerGame,
      note: stats.note
    })),
    markets: (input.markets ?? []).slice(0, 6).map((market) => ({
      source: market.source,
      kind: market.marketKind,
      title: market.title,
      outcome: market.outcomeLabel,
      yesCents: market.yesPriceCents,
      moveCents: market.recentDeltaCents ?? 0,
      volume24h: market.volume24hUsd ?? null
    })),
    marketSwing: input.marketSwing
      ? {
          source: input.marketSwing.market.source,
          title: input.marketSwing.market.title,
          outcome: input.marketSwing.market.outcomeLabel,
          fromCents: input.marketSwing.market.yesPriceCents - input.marketSwing.deltaCents,
          toCents: input.marketSwing.market.yesPriceCents,
          direction: input.marketSwing.direction
        }
      : null,
    listenerCues: (input.listenerCues ?? [])
      .filter((cue) => cue.text.trim().length > 0)
      .slice(0, 3)
      .map((cue) => ({
        text: cue.text,
        capturedAt: cue.capturedAt,
        confidence: cue.confidence ?? null
      })),
    recentCommentary: input.recentCommentary.slice(0, 4)
  };
}

/**
 * Compare a fresh batch of MarketSnapshots against the last batch
 * we cited on-air, and surface any market that moved by more than
 * `thresholdCents` (default 5). Used per commentary tick to decide
 * whether to lead with a market story.
 *
 * Returns at most one swing — the largest absolute move — so the
 * host doesn't get pulled in two directions at once. Sorts by
 * absolute delta so the loudest signal wins.
 */
export function detectMarketSwings(
  current: MarketSnapshot[],
  previous: MarketSnapshot[],
  thresholdCents = 5
): MarketSwing | undefined {
  if (current.length === 0 || previous.length === 0) return undefined;
  const previousById = new Map(
    previous.map((snapshot) => [`${snapshot.source}:${snapshot.externalId}`, snapshot])
  );
  let best: MarketSwing | undefined;
  let bestAbs = thresholdCents - 1;
  for (const snapshot of current) {
    const key = `${snapshot.source}:${snapshot.externalId}`;
    const prior = previousById.get(key);
    if (!prior) continue;
    const delta = snapshot.yesPriceCents - prior.yesPriceCents;
    const abs = Math.abs(delta);
    if (abs <= bestAbs) continue;
    bestAbs = abs;
    best = {
      market: snapshot,
      deltaCents: delta,
      direction: delta > 0 ? "warming" : "cooling"
    };
  }
  return best;
}

export function sanitizeCommentary(text: string, fallbackText: string): string {
  // Catch credential-shaped phrases in any reasonable spelling so a
  // jailbroken model echoing the system prompt can't leak the key:
  // `apikey`, `api_key`, `api-key`, and `api key` (with whitespace).
  if (/api[\s_-]?key|secret|token|credential|system prompt/i.test(text)) {
    return fallbackText;
  }
  return text.slice(0, 520);
}

/**
 * Parse the LLM's JSON dialogue output into validated DialogueLines.
 * Tolerant: strips a leading code fence if the model added one, drops
 * lines with empty text, normalizes any unknown speaker id to the
 * supplied lead host so playback never falls silent. Returns
 * `undefined` on unrecoverable shape problems so the caller can fall
 * back to single-line mode.
 */
const VALID_HOST_IDS = new Set<HostId>(["maya", "theo", "cam"]);

export function parseDialogueResponse(raw: string, leadHostId: HostId): DialogueLine[] | undefined {
  const stripped = raw
    .trim()
    // Drop a single leading code fence if the model wrapped its JSON in one.
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  if (!stripped.startsWith("{")) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const linesRaw = (parsed as { lines?: unknown }).lines;
  if (!Array.isArray(linesRaw) || linesRaw.length === 0) return undefined;

  const lines: DialogueLine[] = [];
  for (const entry of linesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const speakerRaw = (entry as { speaker?: unknown }).speaker;
    const textRaw = (entry as { text?: unknown }).text;
    if (typeof textRaw !== "string") continue;
    const text = textRaw.trim();
    if (!text) continue;
    // Coerce: unknown / missing speaker → fall back to lead host so the
    // line still plays in one of our known voices.
    const speaker = typeof speakerRaw === "string" && VALID_HOST_IDS.has(speakerRaw as HostId)
      ? (speakerRaw as HostId)
      : leadHostId;
    // Per-line sanitizer: same credential filter as the legacy single-text path.
    if (/api[\s_-]?key|secret|token|credential|system prompt/i.test(text)) continue;
    lines.push({ hostId: speaker, text: text.slice(0, 220) });
  }
  if (lines.length === 0) return undefined;
  // Force the first speaker to be the lead host. If the LLM picked
  // someone else, that's fine — the rotation still respects the
  // selectHost decision but the LLM's reordering is overridden.
  if (lines[0].hostId !== leadHostId) {
    lines[0] = { ...lines[0], hostId: leadHostId };
  }
  return lines;
}

/**
 * Joined transcript across all dialogue lines. Used by the engine to
 * populate `LivecastCommentary.text` for clip captions, accessibility,
 * and the local commentary fallback.
 */
export function joinDialogueLines(lines: DialogueLine[]): string {
  return lines.map((line) => line.text).join(" ");
}
