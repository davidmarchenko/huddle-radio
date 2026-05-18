import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearLivecastSnapshot,
  loadLivecastSnapshot,
  saveLivecastSnapshot
} from "../client/livecastSnapshot";
import type { LivecastCommentary } from "../shared/contracts";

/**
 * Snapshot persistence preserves the listener's player state across a
 * refresh (Spotify/YouTube pattern). The tests below pin the behaviors
 * the live-show UI relies on:
 *
 *   - Saves keyed by gameId; opening a different /watch/{otherId} does
 *     not surface another show's transcript.
 *   - Stale snapshots (> 30 min) are wiped on read so a return-the-
 *     -next-morning doesn't resurrect ghost captions.
 *   - Save is a no-op when commentary is empty so a mid-startup gap
 *     after a paused-show resume cannot overwrite the saved state with
 *     a blank one.
 */

// Minimal commentary shape — the snapshot module only reads `id` for
// trimming and persists the rest as opaque JSON, so we don't need
// real impacts / observations / plays here.
const makeCommentary = (id: string): LivecastCommentary => ({
  id,
  text: `Turn ${id}`,
  lines: [{ hostId: "maya", text: "Sample line." }]
} as unknown as LivecastCommentary);

const realLocalStorage = globalThis.localStorage;

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  get length(): number {
    return this.store.size;
  }
  key(_index: number): string | null {
    return null;
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: new MemoryStorage() },
    configurable: true
  });
  // The snapshot module reads `window.localStorage` directly, so we
  // only need to shim the window object on the global. Vitest's
  // jsdom env may not be active for this test file.
});

afterEach(() => {
  // Restore the original (possibly undefined) localStorage so other
  // suites that rely on the real one aren't poisoned by ours.
  if (realLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", {
      value: realLocalStorage,
      configurable: true
    });
  }
});

describe("livecast snapshot", () => {
  it("round-trips commentary, lineTimings, playedLineKeys and isPaused", () => {
    const commentary = [makeCommentary("a"), makeCommentary("b")];
    const lineTimings = new Map([
      ["a:0", { wordTimings: [{ text: "Sample", startMs: 0, endMs: 400 }] }]
    ]);
    const playedLineKeys = new Set(["a:0", "b:0"]);
    saveLivecastSnapshot({
      sportsGameId: "nfl-game-1",
      commentary,
      lineTimings,
      playedLineKeys,
      isPaused: true
    });
    const restored = loadLivecastSnapshot("nfl-game-1");
    expect(restored).toBeDefined();
    expect(restored?.commentary).toHaveLength(2);
    expect(restored?.lineTimings).toEqual([
      ["a:0", { wordTimings: [{ text: "Sample", startMs: 0, endMs: 400 }] }]
    ]);
    expect(restored?.playedLineKeys).toEqual(["a:0", "b:0"]);
    expect(restored?.isPaused).toBe(true);
  });

  it("does not return a snapshot for a different gameId", () => {
    saveLivecastSnapshot({
      sportsGameId: "nfl-game-1",
      commentary: [makeCommentary("a")],
      lineTimings: new Map(),
      playedLineKeys: new Set(),
      isPaused: false
    });
    expect(loadLivecastSnapshot("nfl-game-2")).toBeUndefined();
  });

  it("treats snapshots older than 4 hours as stale", () => {
    saveLivecastSnapshot({
      sportsGameId: "nfl-game-1",
      commentary: [makeCommentary("a")],
      lineTimings: new Map(),
      playedLineKeys: new Set(),
      isPaused: false
    });
    // Mutate the savedAt timestamp directly to simulate an old write.
    const raw = (globalThis as unknown as { window: { localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } } })
      .window.localStorage.getItem("huddle-livecast-snapshot");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    parsed.savedAt = Date.now() - (4 * 60 * 60 * 1000 + 60 * 1000);
    (globalThis as unknown as { window: { localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } } })
      .window.localStorage.setItem("huddle-livecast-snapshot", JSON.stringify(parsed));
    expect(loadLivecastSnapshot("nfl-game-1")).toBeUndefined();
  });

  it("does not overwrite a paused snapshot with empty commentary", () => {
    saveLivecastSnapshot({
      sportsGameId: "nfl-game-1",
      commentary: [makeCommentary("a")],
      lineTimings: new Map(),
      playedLineKeys: new Set(["a:0"]),
      isPaused: true
    });
    saveLivecastSnapshot({
      sportsGameId: "nfl-game-1",
      commentary: [],
      lineTimings: new Map(),
      playedLineKeys: new Set(),
      isPaused: false
    });
    const restored = loadLivecastSnapshot("nfl-game-1");
    expect(restored?.commentary).toHaveLength(1);
    expect(restored?.isPaused).toBe(true);
  });

  it("clearLivecastSnapshot wipes the stored snapshot", () => {
    saveLivecastSnapshot({
      sportsGameId: "nfl-game-1",
      commentary: [makeCommentary("a")],
      lineTimings: new Map(),
      playedLineKeys: new Set(),
      isPaused: false
    });
    expect(loadLivecastSnapshot("nfl-game-1")).toBeDefined();
    clearLivecastSnapshot();
    expect(loadLivecastSnapshot("nfl-game-1")).toBeUndefined();
  });

  it("migrates a legacy snapshot with play.quarter into structured period", () => {
    // Simulate a snapshot written before the period refactor — the
    // play carries `quarter: "Q3"` and no `period`. Drop it directly
    // into localStorage so we exercise the migration branch in
    // loadLivecastSnapshot rather than going through saveLivecastSnapshot
    // (which now writes the new shape).
    const legacy = {
      sportsGameId: "nfl-game-1",
      commentary: [
        {
          id: "a",
          text: "Hello",
          lines: [{ hostId: "maya", text: "Hi." }],
          play: { id: "p1", quarter: "Q3", clock: "10:00" }
        }
      ],
      lineTimings: [],
      playedLineKeys: [],
      isPaused: false,
      savedAt: Date.now()
    };
    const store = (globalThis as unknown as {
      window: { localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void } };
    }).window.localStorage;
    store.setItem("huddle-livecast-snapshot", JSON.stringify(legacy));

    const restored = loadLivecastSnapshot("nfl-game-1");
    expect(restored).toBeDefined();
    const restoredPlay = restored?.commentary[0]?.play as unknown as {
      period?: { number: number; shortDetail?: string };
      quarter?: string;
    };
    expect(restoredPlay.period).toBeDefined();
    expect(restoredPlay.period?.number).toBe(3);
    // Legacy field is stripped from the in-memory shape so consumers
    // don't accidentally branch on the deprecated key after migration.
    expect(restoredPlay.quarter).toBeUndefined();
  });
});
