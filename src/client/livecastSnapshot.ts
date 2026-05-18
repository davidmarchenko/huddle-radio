/**
 * Per-game snapshot of live-show state so a tab refresh, accidental
 * close, or background-tab freeze never throws away the transcript +
 * captions + paused state the listener was looking at.
 *
 * Think Spotify on reload: the player UI must be fully rendered and
 * faithful before any backend talks back. Without this, the listener
 * lands on a flash of "discover" while the auto-resume gesture is
 * armed, then a blank player when audio context wakes up — both
 * jarring after a 20-minute show.
 *
 * What we persist:
 *  - commentary (the transcript array, capped to recent turns)
 *  - lineTimings (word-level karaoke timing, serialized from Map)
 *  - playedLineKeys (which lines should be visible, serialized from Set)
 *  - isPaused (so a paused show re-opens paused, not auto-playing)
 *  - sportsGameId so we only restore for the same show
 *
 * What we deliberately DON'T persist:
 *  - activePlayback. The audio bytes are gone after refresh, so the
 *    karaoke RAF loop has nothing to drive. PlayerBarCaptions falls
 *    back to the last entry in playedLineKeys with elapsedMs=∞, which
 *    renders the final word state of the last line — exactly the
 *    "frozen on the spot you left" UX Spotify shows.
 *  - audio chunks themselves. Re-fetching ~MBs of mp3 per turn through
 *    localStorage isn't worth it; a fresh SSE session will pick up the
 *    show from current play-by-play after the user taps Play.
 *
 * Storage: localStorage with a TTL so the snapshot doesn't haunt the
 * listener on the next morning. Game ID gates restoration so opening a
 * different /watch/{otherId} doesn't pull in stale captions.
 */

import type { LivecastCommentary, SportsPlay } from "../shared/contracts";
import type { MentionCue, WordTiming } from "../shared/contracts";
import { periodFromLegacyString } from "../shared/period";

const STORAGE_KEY = "huddle-livecast-snapshot";
// 4 hours covers an NFL game (~3h with halftime), an NBA game (~2.5h
// with overtime), and a reasonable pause-for-dinner-then-come-back
// scenario. Anything stale beyond this is probably the listener
// returning the next morning to a different show — wipe it.
const MAX_AGE_MS = 4 * 60 * 60 * 1000;
const MAX_COMMENTARY = 50; // bound storage cost

type LineTiming = { wordTimings?: WordTiming[]; mentionCues?: MentionCue[] };

export type LivecastSnapshot = {
  sportsGameId: string;
  commentary: LivecastCommentary[];
  lineTimings: Array<[string, LineTiming]>;
  playedLineKeys: string[];
  isPaused: boolean;
  savedAt: number;
};

export type LivecastSnapshotInput = {
  sportsGameId: string;
  commentary: LivecastCommentary[];
  lineTimings: Map<string, LineTiming>;
  playedLineKeys: Set<string>;
  isPaused: boolean;
};

export function saveLivecastSnapshot(input: LivecastSnapshotInput): void {
  if (typeof window === "undefined") return;
  if (!input.sportsGameId) return;
  if (input.commentary.length === 0) {
    // Nothing meaningful yet — leave any prior snapshot alone so a
    // brief mid-startup gap doesn't wipe a paused show's snapshot.
    return;
  }
  try {
    // Newest-first: cap to the most recent N turns so storage stays
    // sane on a long show.
    const trimmedCommentary = input.commentary.slice(0, MAX_COMMENTARY);
    const keptIds = new Set(trimmedCommentary.map((turn) => turn.id));
    const trimmedTimings: Array<[string, LineTiming]> = [];
    for (const [key, value] of input.lineTimings) {
      const turnId = key.split(":")[0];
      if (keptIds.has(turnId)) trimmedTimings.push([key, value]);
    }
    const trimmedPlayed: string[] = [];
    for (const key of input.playedLineKeys) {
      const turnId = key.split(":")[0];
      if (keptIds.has(turnId)) trimmedPlayed.push(key);
    }
    const payload: LivecastSnapshot = {
      sportsGameId: input.sportsGameId,
      commentary: trimmedCommentary,
      lineTimings: trimmedTimings,
      playedLineKeys: trimmedPlayed,
      isPaused: input.isPaused,
      savedAt: Date.now()
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // QuotaExceeded, JSON cycle, etc. Persistence is best-effort;
    // failing here just means the next refresh shows a fresh view.
  }
}

export function loadLivecastSnapshot(sportsGameId: string): LivecastSnapshot | undefined {
  if (typeof window === "undefined") return undefined;
  if (!sportsGameId) return undefined;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as LivecastSnapshot;
    if (!parsed || parsed.sportsGameId !== sportsGameId) return undefined;
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      // Stale — wipe so it doesn't grow forever.
      window.localStorage.removeItem(STORAGE_KEY);
      return undefined;
    }
    if (!Array.isArray(parsed.commentary) || parsed.commentary.length === 0) return undefined;
    // Migrate legacy snapshots written before SportsPlay.period existed.
    // The previous shape carried `play.quarter: string` (e.g. "Q3");
    // structured period replaced it. Without this, a snapshot from
    // a pre-upgrade session would render the captions panel with
    // undefined period info and the formatter would print empty.
    for (const turn of parsed.commentary) {
      // Some legacy turns (and a couple of test fixtures) persist
      // without a `play` field at all — skip those rather than
      // dereferencing undefined.
      const play = turn.play as (SportsPlay & { quarter?: string }) | undefined;
      if (!play) continue;
      if (!play.period && play.quarter !== undefined) {
        play.period = periodFromLegacyString(play.quarter, "other");
        delete play.quarter;
      }
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function clearLivecastSnapshot(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
