import { describe, expect, it } from "vitest";
import { SportsGamesCache } from "../server/sportsGamesCache";
import type { EspnSportPath } from "../providers/espnSportsDataProvider";
import type { SportsGameOption } from "../shared/contracts";

const NFL: EspnSportPath = { sport: "nfl", label: "NFL", path: "football/nfl" };
const NBA: EspnSportPath = { sport: "nba", label: "NBA", path: "basketball/nba" };

function gameStub(id: string): SportsGameOption {
  return {
    id,
    label: `Game ${id}`,
    shortName: `A @ B`,
    sport: "nfl",
    awayTeam: "A",
    homeTeam: "B",
    score: { away: 0, home: 0 },
    status: "scheduled",
    detail: "scheduled"
  };
}

describe("SportsGamesCache", () => {
  it("calls the fetcher on first miss and caches the result", async () => {
    let calls = 0;
    const cache = new SportsGamesCache(async () => {
      calls++;
      return [gameStub("1")];
    });

    const a = await cache.get(NFL);
    const b = await cache.get(NFL);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(cache.getStats()).toMatchObject({ hits: 1, stale: 0, misses: 1 });
  });

  it("returns stale data and refreshes in the background after the fresh window expires", async () => {
    let now = 0;
    let calls = 0;
    const cache = new SportsGamesCache(
      async () => {
        calls++;
        return [gameStub(`call-${calls}`)];
      },
      { freshMs: 100, staleMs: 1000, now: () => now }
    );

    const first = await cache.get(NFL);
    expect(first[0].id).toBe("call-1");

    // Advance past the fresh TTL but inside the stale window.
    now = 200;
    const second = await cache.get(NFL);
    // Should serve stale immediately (still call-1) while a refresh
    // kicks off in the background.
    expect(second[0].id).toBe("call-1");
    // Let the background refresh microtask resolve.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    expect(cache.getStats()).toMatchObject({ hits: 0, stale: 1, misses: 1 });

    // Now the cache is freshly warmed with call-2.
    const third = await cache.get(NFL);
    expect(third[0].id).toBe("call-2");
  });

  it("re-fetches after the stale window also expires", async () => {
    let now = 0;
    let calls = 0;
    const cache = new SportsGamesCache(
      async () => {
        calls++;
        return [gameStub(`call-${calls}`)];
      },
      { freshMs: 100, staleMs: 200, now: () => now }
    );

    await cache.get(NFL);
    now = 500; // past staleUntil
    const next = await cache.get(NFL);
    expect(next[0].id).toBe("call-2");
    expect(cache.getStats().misses).toBe(2);
  });

  it("coalesces concurrent requests for the same sport into one fetch", async () => {
    let calls = 0;
    let resolveFetch: ((games: SportsGameOption[]) => void) | undefined;
    const cache = new SportsGamesCache(async () => {
      calls++;
      return new Promise<SportsGameOption[]>((resolve) => {
        resolveFetch = resolve;
      });
    });

    const a = cache.get(NFL);
    const b = cache.get(NFL);
    const c = cache.get(NFL);
    expect(calls).toBe(1);

    resolveFetch?.([gameStub("only")]);
    await Promise.all([a, b, c]);
    expect(calls).toBe(1);
  });

  it("does not cache cross-sport — NFL and NBA fetchers are independent", async () => {
    const seen: string[] = [];
    const cache = new SportsGamesCache(async (sportPath) => {
      seen.push(sportPath.sport);
      return [gameStub(sportPath.sport)];
    });

    await cache.get(NFL);
    await cache.get(NBA);
    expect(seen).toEqual(["nfl", "nba"]);
  });

  it("propagates errors on the first fetch (no stale fallback to hide it)", async () => {
    const cache = new SportsGamesCache(async () => {
      throw new Error("ESPN exploded");
    });
    await expect(cache.get(NFL)).rejects.toThrow("ESPN exploded");
  });

  it("invalidate() clears entries so the next get refetches", async () => {
    let calls = 0;
    const cache = new SportsGamesCache(async () => {
      calls++;
      return [gameStub(`call-${calls}`)];
    });

    await cache.get(NFL);
    await cache.get(NFL);
    expect(calls).toBe(1);

    cache.invalidate("nfl");
    await cache.get(NFL);
    expect(calls).toBe(2);
  });
});
