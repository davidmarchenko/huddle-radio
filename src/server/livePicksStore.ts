import type { SportsGameState, SportsPlay } from "../shared/contracts";
import type {
  LivePickEntry,
  LivePickProp,
  LivePickResultStatus,
  LivePickSide
} from "../shared/livePicksContracts";
import { LIVE_PICK_PAYOUT_MULTIPLIER, LIVE_PICK_STAKE } from "../shared/livePicksContracts";
import { generateLivePickCandidates } from "./livePicksGenerator";

/**
 * In-memory store for live (in-show) snap picks. Holds three things:
 *
 *   1) Active props per game (`activeByGame`) — the rotating menu the
 *      UI polls and renders.
 *   2) Listener entries (`entriesByListenerGame`) — every locked pick
 *      ever made by a listener for a given game, including resolved.
 *   3) A small "recently-resolved" ring per game (`recentByGame`) so
 *      the engine can include resolution news in the next host turn
 *      even though the entries themselves live per-listener.
 *
 * Like the parlay store, single-instance memory is fine for the demo;
 * a multi-region promotion swaps the Maps for Upstash Redis with the
 * same surface.
 */

// ---------------- Store state ----------------

const activeByGame = new Map<string, LivePickProp[]>();
const entriesByListenerGame = new Map<string, LivePickEntry[]>();
/** Most-recent resolutions per game, capped — engine reads this to
 *  decide whether to call out a hit/miss in the next host turn. */
const recentByGame = new Map<string, LivePickEntry[]>();
const RECENT_RESOLUTION_CAP = 6;

const MAX_ACTIVE_PER_GAME = 3;

function listenerKey(listenerId: string, gameId: string): string {
  return `${listenerId}:${gameId}`;
}

// ---------------- Active prop lifecycle ----------------

/**
 * Run on each engine tick (and on each `/api/picks/live/active` GET).
 * Drops expired-and-resolved props, generates fresh candidates from
 * the current game state, merges in any new ones up to the cap.
 *
 * Returns the merged active list. Idempotent within a single tick.
 */
export function refreshActivePicks(input: { game: SportsGameState; now: number }): LivePickProp[] {
  const { game, now } = input;
  const nowIso = new Date(now).toISOString();
  const existing = activeByGame.get(game.gameId) ?? [];

  // Keep props that are still inside their window. Expired ones are
  // pulled from the active list — they get resolved separately by
  // `resolveExpiredEntries`. The active menu is what listeners can
  // still lock.
  const live = existing.filter((prop) => prop.expiresAt > nowIso);

  // Ask the generator for fresh candidates. Heuristic generator is
  // pure — same game snapshot returns the same ids, so this dedupes
  // cleanly against `live`.
  const candidates = generateLivePickCandidates({ game, now });
  const knownIds = new Set(live.map((prop) => prop.id));
  for (const candidate of candidates) {
    if (live.length >= MAX_ACTIVE_PER_GAME) break;
    if (knownIds.has(candidate.id)) continue;
    live.push(candidate);
    knownIds.add(candidate.id);
  }

  activeByGame.set(game.gameId, live);
  return live;
}

export function getActivePicks(gameId: string): LivePickProp[] {
  return [...(activeByGame.get(gameId) ?? [])];
}

// ---------------- Locking ----------------

export type LockInput = {
  listenerId: string;
  gameId: string;
  propId: string;
  side: LivePickSide;
  now: number;
};

export type LockResult = { entry: LivePickEntry } | { error: string };

export function lockLivePick(input: LockInput): LockResult {
  const { listenerId, gameId, propId, side, now } = input;
  if (!listenerId.trim()) return { error: "Missing listenerId." };
  const active = activeByGame.get(gameId) ?? [];
  const prop = active.find((candidate) => candidate.id === propId);
  if (!prop) return { error: "Prop is no longer available." };
  if (new Date(prop.expiresAt).getTime() <= now) return { error: "Prop window closed." };

  // One lock per listener per prop — re-tapping is a no-op so the UI
  // can fire without flinching about double-submits.
  const key = listenerKey(listenerId, gameId);
  const existing = entriesByListenerGame.get(key) ?? [];
  const already = existing.find((entry) => entry.propId === propId);
  if (already) return { entry: already };

  const entry: LivePickEntry = {
    id: `live-entry-${listenerId}-${propId}-${now}`,
    listenerId,
    gameId,
    propId,
    prop,
    side,
    lockedAt: new Date(now).toISOString(),
    status: "open",
    stake: LIVE_PICK_STAKE
  };
  entriesByListenerGame.set(key, [entry, ...existing]);
  return { entry };
}

export function getListenerEntries(listenerId: string, gameId: string): LivePickEntry[] {
  return [...(entriesByListenerGame.get(listenerKey(listenerId, gameId)) ?? [])];
}

/** Engine-facing summary: most-recently-resolved entry across ALL
 *  listeners for a game. The engine uses this to color the next host
 *  turn ("Lakers fans on the panel just hit the snap pick"). */
export function getRecentResolution(gameId: string): LivePickEntry | undefined {
  return recentByGame.get(gameId)?.[0];
}

// ---------------- Resolution ----------------

/**
 * Walk every listener entry for this game whose window has closed
 * and assign hit/miss/void. Idempotent — already-resolved entries
 * are skipped. Returns the entries that flipped from open to
 * resolved on this call (useful for the engine to emit a "just
 * resolved" line in the next turn).
 *
 * `game.recentPlays` is treated as the authoritative event log for
 * the window. Plays older than the entry's lockedAt are ignored —
 * the prop is forward-looking only.
 */
export function resolveExpiredEntries(input: { game: SportsGameState; now: number }): LivePickEntry[] {
  const { game, now } = input;
  const justResolved: LivePickEntry[] = [];

  // Resolution scans ALL listener entries for this game in one pass.
  for (const [key, entries] of entriesByListenerGame.entries()) {
    if (!key.endsWith(`:${game.gameId}`)) continue;
    let mutated = false;
    const next = entries.map((entry) => {
      if (entry.status !== "open") return entry;
      const expiresMs = new Date(entry.prop.expiresAt).getTime();
      if (expiresMs > now) return entry;
      const resolved = resolveEntry({ entry, game });
      mutated = true;
      justResolved.push(resolved);
      return resolved;
    });
    if (mutated) entriesByListenerGame.set(key, next);
  }

  // Drop expired props from the active menu too — the UI shouldn't
  // keep offering a window that's already closed even if no listener
  // locked it.
  const active = activeByGame.get(game.gameId);
  if (active) {
    const stillOpen = active.filter((prop) => new Date(prop.expiresAt).getTime() > now);
    if (stillOpen.length !== active.length) activeByGame.set(game.gameId, stillOpen);
  }

  if (justResolved.length > 0) {
    const ring = recentByGame.get(game.gameId) ?? [];
    recentByGame.set(game.gameId, [...justResolved, ...ring].slice(0, RECENT_RESOLUTION_CAP));
  }

  return justResolved;
}

function resolveEntry(input: { entry: LivePickEntry; game: SportsGameState }): LivePickEntry {
  const { entry, game } = input;
  const lockedMs = new Date(entry.lockedAt).getTime();
  const expiresMs = new Date(entry.prop.expiresAt).getTime();
  const playsInWindow = game.recentPlays.filter((play) => {
    const at = new Date(play.occurredAt).getTime();
    return at >= lockedMs && at <= expiresMs;
  });

  const verdict = decideVerdict({ entry, plays: playsInWindow, game });
  const payout = verdict.status === "hit" ? entry.stake * LIVE_PICK_PAYOUT_MULTIPLIER : 0;
  return {
    ...entry,
    status: verdict.status,
    resolvedAt: new Date(expiresMs).toISOString(),
    resolutionNote: verdict.note,
    payout
  };
}

function decideVerdict(input: { entry: LivePickEntry; plays: SportsPlay[]; game: SportsGameState }): {
  status: LivePickResultStatus;
  note: string;
} {
  const { entry, plays } = input;
  const { prop, side } = entry;

  switch (prop.kind) {
    case "team-scores-window": {
      const scoringPlay = plays.find((play) => {
        if (!prop.team) return false;
        if (play.team !== prop.team) return false;
        // A team "scored" when its scoreboard column increased on this
        // play. Walk the play list in chronological order and compare
        // to the previous play's score for that team.
        return scoreIncreasedFor(prop.team, play, plays, input.game);
      });
      const hit = side === "more" ? !!scoringPlay : !scoringPlay;
      return {
        status: hit ? "hit" : "miss",
        note: scoringPlay
          ? `${prop.team} scored on ${scoringPlay.headline}.`
          : `${prop.team} did not score before the window closed.`
      };
    }
    case "player-next-stat": {
      if (!prop.playerName) return { status: "void", note: "Player name missing." };
      const match = plays.find((play) => {
        const text = `${play.headline} ${play.description}`.toLowerCase();
        if (!text.includes(prop.playerName!.toLowerCase())) return false;
        return THREE_PT_PATTERN.test(text);
      });
      const hit = side === "more" ? !!match : !match;
      return {
        status: hit ? "hit" : "miss",
        note: match
          ? `${prop.playerName} hit a three: ${match.headline}.`
          : `${prop.playerName} didn't hit a three in the window.`
      };
    }
    case "combined-total-by": {
      const finalPlay = plays[plays.length - 1];
      if (!finalPlay) {
        return { status: "void", note: "No plays inside the window." };
      }
      const finalTotal = finalPlay.score.away + finalPlay.score.home;
      const crossed = finalTotal >= prop.line;
      const hit = side === "more" ? crossed : !crossed;
      return {
        status: hit ? "hit" : "miss",
        note: crossed
          ? `Combined score reached ${finalTotal} (target ${prop.line}).`
          : `Combined score stayed at ${finalTotal} (target ${prop.line}).`
      };
    }
    case "drive-scores":
      // Reserved for a future template — resolves like team-scores
      // but anchored to a possession sequence. For v0 we don't
      // generate these so void if one slipped through.
      return { status: "void", note: "Drive-resolution not yet implemented." };
  }
}

const THREE_PT_PATTERN = /\b(?:three|3[\s-]?pt|3-pointer|3pt made|from beyond the arc|from downtown)\b/i;

function scoreIncreasedFor(
  team: string,
  play: SportsPlay,
  windowPlays: SportsPlay[],
  game: SportsGameState
): boolean {
  // Find the play right before this one (within the window) — that's
  // the baseline score. If no prior play exists, compare against the
  // game's earlier `recentPlays` to find one. As a last-resort
  // baseline, treat zero as the baseline so the first scoring play
  // of the window still counts.
  const index = windowPlays.findIndex((candidate) => candidate.id === play.id);
  const prior = index > 0
    ? windowPlays[index - 1]
    : findPriorPlay(play, game) ?? null;
  const baselineAway = prior?.score.away ?? 0;
  const baselineHome = prior?.score.home ?? 0;
  if (team === game.awayTeam) return play.score.away > baselineAway;
  if (team === game.homeTeam) return play.score.home > baselineHome;
  return false;
}

function findPriorPlay(play: SportsPlay, game: SportsGameState): SportsPlay | undefined {
  // `recentPlays` is ordered newest-first in our provider contract,
  // so walk forward (further-back-in-time) looking for the next play
  // chronologically before `play`.
  const allPlays = game.recentPlays;
  const idx = allPlays.findIndex((candidate) => candidate.id === play.id);
  if (idx === -1) return undefined;
  return allPlays[idx + 1];
}

// ---------------- Engine hostHint integration ----------------

/**
 * Build a one-line context blurb for the next host turn — describes
 * the most-recently-locked or just-resolved live pick for this
 * listener. Combined with the parlay hostHint upstream, this gives
 * the model two parallel "what's the listener up to" feeds without
 * exploding the prompt.
 */
export function buildLivePicksHostHint(input: { listenerId: string; gameId: string; now: number }): string | undefined {
  const entries = entriesByListenerGame.get(listenerKey(input.listenerId, input.gameId));
  if (!entries || entries.length === 0) return undefined;
  // Prefer the most-recently-resolved (last 60s) — that's news. Fall
  // back to the most-recently-locked open pick — that's "live anchor".
  const sixtySecondsAgo = input.now - 60_000;
  const recentResolution = entries.find((entry) => {
    if (entry.status === "open") return false;
    const resolvedMs = entry.resolvedAt ? new Date(entry.resolvedAt).getTime() : 0;
    return resolvedMs >= sixtySecondsAgo;
  });
  if (recentResolution) {
    const sideLabel = recentResolution.side === "more" ? "More" : "Less";
    return `Listener live pick (${sideLabel}, "${recentResolution.prop.title}") just ${recentResolution.status === "hit" ? "HIT" : "missed"}: ${recentResolution.resolutionNote}`;
  }
  const open = entries.find((entry) => entry.status === "open");
  if (!open) return undefined;
  const sideLabel = open.side === "more" ? "More" : "Less";
  return `Listener live pick open (${sideLabel}, "${open.prop.title}") — resolves at ${open.prop.expiresAt}.`;
}

// ---------------- Test reset ----------------

export function resetLivePicksStore(): void {
  activeByGame.clear();
  entriesByListenerGame.clear();
  recentByGame.clear();
}
