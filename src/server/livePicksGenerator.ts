import type { SportsGameState, SportsPlay, SportLeague } from "../shared/contracts";
import { formatPeriodLabel } from "../shared/period";
import type { LivePickKind, LivePickProp, LivePickSide } from "../shared/livePicksContracts";
import { LIVE_PICK_DEFAULT_WINDOW_S } from "../shared/livePicksContracts";

/**
 * Generate live-pick candidates from the current game state.
 *
 * Pure function — given the same game snapshot it always returns the
 * same candidate list. The store layer (livePicksStore.ts) calls this
 * periodically and dedupes against the already-active props, so the
 * generator doesn't worry about persistence.
 *
 * Heuristic-first: deterministic templates work in every sport, never
 * fail, and don't need a network call. The AI path (OpenAI / Anthropic)
 * is wired in for richer flavor when an API key is configured —
 * heuristic candidates are still emitted as a safety net so the panel
 * never sits empty mid-show.
 *
 * Candidates are *seeded* off the latest play id so a fresh re-poll
 * inside the same window returns the same id — the active list stays
 * stable until the window actually expires.
 */

type GenerateInput = {
  game: SportsGameState;
  /** Unix ms. Lets tests pass a deterministic clock. */
  now: number;
};

const MAX_CANDIDATES = 3;

export function generateLivePickCandidates(input: GenerateInput): LivePickProp[] {
  const { game, now } = input;

  // No props before a game tips off — there's nothing for the listener
  // to predict against and resolving against pre-game placeholder plays
  // would just generate noise.
  if (game.status !== "live") return [];

  const candidates: LivePickProp[] = [];
  const anchorPlay = game.currentPlay ?? game.recentPlays[0];
  if (!anchorPlay) return candidates;

  // Universal: "team scores in window". Picks the team that does NOT
  // currently have possession (or, if possession is unclear, the
  // trailing team) so the prop is a real prediction rather than a
  // foregone conclusion.
  const teamScoresCandidate = buildTeamScoresCandidate({ game, anchorPlay, now });
  if (teamScoresCandidate) candidates.push(teamScoresCandidate);

  // Basketball: "Next [stat] by [star]". Star is inferred from
  // recently-mentioned playerIds in the play feed — keeps us honest
  // (no inventing players we haven't seen play). Only basketball for
  // v0 because the play type set is small and resolution is clean.
  if (isBasketball(game.sport)) {
    const playerCandidate = buildPlayerNextThreeCandidate({ game, anchorPlay, now });
    if (playerCandidate) candidates.push(playerCandidate);
  }

  // Always-on, low-effort prop: combined total crosses a near-future
  // threshold. Gives the user something to bet on when the other two
  // templates can't find a hook.
  const totalCandidate = buildCombinedTotalCandidate({ game, anchorPlay, now });
  if (totalCandidate) candidates.push(totalCandidate);

  return candidates.slice(0, MAX_CANDIDATES);
}

// ---------------- Templates ----------------

type TemplateInput = {
  game: SportsGameState;
  anchorPlay: SportsPlay;
  now: number;
};

function buildTeamScoresCandidate(input: TemplateInput): LivePickProp | null {
  const { game, anchorPlay, now } = input;
  const trailingTeam = inferTrailingTeam(game, anchorPlay);
  if (!trailingTeam) return null;

  const windowS = LIVE_PICK_DEFAULT_WINDOW_S["team-scores-window"];
  const expiresAt = new Date(now + windowS * 1000).toISOString();
  const id = stableId({
    kind: "team-scores-window",
    gameId: game.gameId,
    anchor: anchorPlay.id,
    detail: trailingTeam
  });

  return {
    id,
    gameId: game.gameId,
    sport: game.sport,
    kind: "team-scores-window",
    title: `${trailingTeam} score in next ${formatWindow(windowS)}?`,
    subtitle: `${formatPeriodLabel(anchorPlay.period)} · ${anchorPlay.clock}`,
    team: trailingTeam,
    line: 1,
    source: "heuristic",
    createdAt: new Date(now).toISOString(),
    expiresAt,
    // "More" reads as "yes they score" which matches the title
    // phrasing — the picks UI uses More/Less buttons.
    hotSide: "more"
  };
}

function buildPlayerNextThreeCandidate(input: TemplateInput): LivePickProp | null {
  const { game, anchorPlay, now } = input;
  const playerName = inferRecentPlayerName(game);
  if (!playerName) return null;

  const windowS = LIVE_PICK_DEFAULT_WINDOW_S["player-next-stat"];
  const expiresAt = new Date(now + windowS * 1000).toISOString();
  const id = stableId({
    kind: "player-next-stat",
    gameId: game.gameId,
    anchor: anchorPlay.id,
    detail: `${playerName}:three`
  });

  return {
    id,
    gameId: game.gameId,
    sport: game.sport,
    kind: "player-next-stat",
    title: `${playerName} hits a 3 in next ${formatWindow(windowS)}?`,
    subtitle: `${formatPeriodLabel(anchorPlay.period)} · ${anchorPlay.clock}`,
    playerName,
    line: 1,
    source: "heuristic",
    createdAt: new Date(now).toISOString(),
    expiresAt,
    hotSide: "more"
  };
}

function buildCombinedTotalCandidate(input: TemplateInput): LivePickProp | null {
  const { game, anchorPlay, now } = input;
  const total = anchorPlay.score.away + anchorPlay.score.home;
  // Pick a threshold a few points ahead of the current pace — the
  // gap depends on sport so the prop stays meaningful (basketball
  // games move 10x faster than baseball).
  const bump = combinedBumpFor(game.sport);
  const threshold = total + bump;

  const windowS = LIVE_PICK_DEFAULT_WINDOW_S["combined-total-by"];
  const expiresAt = new Date(now + windowS * 1000).toISOString();
  const id = stableId({
    kind: "combined-total-by",
    gameId: game.gameId,
    anchor: anchorPlay.id,
    detail: `${threshold}`
  });

  return {
    id,
    gameId: game.gameId,
    sport: game.sport,
    kind: "combined-total-by",
    title: `Combined score crosses ${threshold} in next ${formatWindow(windowS)}?`,
    subtitle: `Currently ${total}`,
    line: threshold,
    source: "heuristic",
    createdAt: new Date(now).toISOString(),
    expiresAt
  };
}

// ---------------- Inference helpers ----------------

function inferTrailingTeam(game: SportsGameState, play: SportsPlay): string | null {
  if (play.score.away === play.score.home) {
    // Tied — fall back to the team that just had possession lost on a
    // turnover; otherwise just bias to home.
    if (play.type === "turnover" && play.team) {
      return otherTeam(game, play.team);
    }
    return game.homeTeam ?? null;
  }
  return play.score.away > play.score.home ? game.homeTeam : game.awayTeam;
}

function otherTeam(game: SportsGameState, team: string): string {
  if (team === game.homeTeam) return game.awayTeam;
  return game.homeTeam;
}

/**
 * Pull a recent player name from play headlines/descriptions. The
 * upstream provider already does NER for the headline (e.g. "Curry
 * 26-ft three") — we walk plays newest-first and grab the first
 * capitalized first+last that looks like a name.
 *
 * Falls back to null when nothing parseable shows up — the candidate
 * is then skipped rather than fabricated.
 */
function inferRecentPlayerName(game: SportsGameState): string | null {
  // Skim only the most recent plays so the candidate prop tracks
  // who's actually involved right now.
  const haystack: SportsPlay[] = [];
  if (game.currentPlay) haystack.push(game.currentPlay);
  for (const play of game.recentPlays.slice(0, 6)) haystack.push(play);
  for (const play of haystack) {
    const fromHeadline = extractPlayerName(play.headline);
    if (fromHeadline) return fromHeadline;
    const fromDescription = extractPlayerName(play.description);
    if (fromDescription) return fromDescription;
  }
  return null;
}

const PLAYER_NAME_RE = /\b([A-Z][a-z]+)\s+([A-Z][a-z'’]+(?:-[A-Z][a-z]+)?)\b/;

function extractPlayerName(text: string | undefined): string | null {
  if (!text) return null;
  const match = PLAYER_NAME_RE.exec(text);
  if (!match) return null;
  const first = match[1]!;
  const last = match[2]!;
  // Filter out common false positives. Play headlines like "First Down"
  // or "Quarter Three" otherwise pattern-match as names.
  if (NAME_BLOCKLIST.has(first) || NAME_BLOCKLIST.has(last)) return null;
  return `${first} ${last}`;
}

const NAME_BLOCKLIST = new Set([
  "First", "Second", "Third", "Fourth",
  "Down", "Quarter", "Half", "Time", "Out",
  "Field", "Goal", "Touchdown", "Turnover",
  "Lakers", "Celtics", "Warriors", "Knicks", "Bucks", "Nets", "Heat",
  "Bulls", "Sixers", "Spurs", "Suns", "Kings", "Magic", "Pacers",
  "Bills", "Chiefs", "Eagles", "Cowboys", "Giants", "Jets", "Patriots",
  "Yankees", "Mets", "Cubs", "Dodgers", "Padres"
]);

function combinedBumpFor(sport: SportLeague): number {
  switch (sport) {
    case "nba":
    case "wnba":
    case "ncaab":
      // Basketball moves fast — both teams together usually score
      // 4-6 points every minute. A +6 threshold over a 5-minute
      // window is hittable but real.
      return 6;
    case "nfl":
    case "ncaaf":
      // Football: scoring is discrete (3, 6, 7). +7 means "anyone
      // scores a TD or two FGs in the window".
      return 7;
    case "mlb":
      return 1;
    case "nhl":
      return 1;
    case "soccer":
      return 1;
    default:
      return 3;
  }
}

function isBasketball(sport: SportLeague): boolean {
  return sport === "nba" || sport === "wnba" || sport === "ncaab";
}

function formatWindow(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  return `${mins}m`;
}

/**
 * Deterministic id for a candidate. Same (kind, gameId, anchorPlay,
 * detail) → same id, so re-polling the generator inside the window
 * returns the same prop and lock state stays intact.
 */
function stableId(parts: { kind: LivePickKind; gameId: string; anchor: string; detail: string }): string {
  return `live:${parts.kind}:${parts.gameId}:${parts.anchor}:${parts.detail}`
    .toLowerCase()
    .replace(/[^a-z0-9:.-]+/g, "-");
}

// Exposed for the store to format its own hostHint lines.
export { isBasketball, otherTeam };
export type { LivePickSide };
