import { describe, expect, it, vi } from "vitest";
import { BlueskyProvider } from "../providers/enrichment/blueskyProvider";
import type { SportsGameState } from "../shared/contracts";

const game: SportsGameState = {
  provider: "espn-scoreboard",
  gameId: "wnba-401856904",
  sport: "wnba",
  awayTeam: "SEA",
  homeTeam: "LV",
  awayMeta: { abbreviation: "SEA", shortName: "Storm", displayName: "Seattle Storm" },
  homeMeta: { abbreviation: "LV", shortName: "Aces", displayName: "Las Vegas Aces" },
  status: "live",
  recentPlays: [],
  updatedAt: new Date().toISOString()
};

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: "OK",
    json: async () => body
  } as unknown as Response;
}

function fakePost(overrides: Partial<{ uri: string; text: string; likes: number; reposts: number; handle: string; createdAt: string }>) {
  return {
    uri: overrides.uri ?? `at://default/${Math.random()}`,
    cid: "cid",
    author: { handle: overrides.handle ?? "fan.bsky.social", displayName: "fan" },
    record: { text: overrides.text ?? "default text long enough to pass filter", createdAt: overrides.createdAt ?? new Date().toISOString() },
    likeCount: overrides.likes ?? 5,
    repostCount: overrides.reposts ?? 0,
    indexedAt: new Date().toISOString()
  };
}

describe("BlueskyProvider", () => {
  it("queries by team shortName + 'game'", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ posts: [] }));
    const provider = new BlueskyProvider({ fetcher: fetcher as unknown as typeof fetch });
    await provider.gather({ game, deadlineMs: 1000 });
    const url = String((fetcher.mock.calls[0] as unknown as [string])[0] ?? "");
    expect(url).toContain("Storm");
    expect(url).toContain("Aces");
    expect(url).toContain("game");
  });

  it("returns shaped EnrichmentSignals for valid posts", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        posts: [
          fakePost({ uri: "at://1", text: "Wilson is unreal tonight what a quarter she is having", likes: 50 }),
          fakePost({ uri: "at://2", text: "Storm defense looking lost on switches against the Aces", likes: 30 })
        ]
      })
    );
    const provider = new BlueskyProvider({ fetcher: fetcher as unknown as typeof fetch });
    const signals = await provider.gather({ game, deadlineMs: 1000 });
    expect(signals).toHaveLength(2);
    expect(signals[0].source).toBe("bluesky");
    expect(signals[0].kind).toBe("reaction");
    expect(signals[0].id).toMatch(/^bluesky-/);
  });

  it("filters out posts that are too short, too long, downvoted, or spam", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        posts: [
          fakePost({ uri: "at://good", text: "actual fan reaction with substance to it here", likes: 50 }),
          fakePost({ uri: "at://short", text: "lol", likes: 100 }), // too short
          fakePost({ uri: "at://huge", text: "x".repeat(400), likes: 100 }), // too long
          fakePost({ uri: "at://noeng", text: "no engagement whatsoever on this take here", likes: 0 }), // 0 likes
          fakePost({ uri: "at://spam", text: "free crypto airdrop just claim now click link", likes: 100 }) // spam
        ]
      })
    );
    const provider = new BlueskyProvider({ fetcher: fetcher as unknown as typeof fetch });
    const signals = await provider.gather({ game, deadlineMs: 1000 });
    expect(signals.map((s) => s.id)).toEqual([`bluesky-${stableHashTest("at://good")}`]);
  });

  it("classifies beat-reporter posts as kind='news' with floor score", async () => {
    const reporterGame = { ...game, sport: "nba" as const };
    const fetcher = vi.fn(async (url: string) => {
      // Beat-reporter author feed call.
      if (url.includes("getAuthorFeed")) {
        return jsonResponse({
          feed: [
            { post: fakePost({ uri: "at://woj", text: "Sources: Curry questionable for Game 3 with shoulder", likes: 0, handle: "wojespn.bsky.social" }) }
          ]
        });
      }
      // Search call returns nothing.
      return jsonResponse({ posts: [] });
    });
    const provider = new BlueskyProvider({
      fetcher: fetcher as unknown as typeof fetch,
      beatReporters: { nba: ["wojespn.bsky.social"] }
    });
    const signals = await provider.gather({ game: reporterGame, deadlineMs: 1000 });
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe("news");
    expect(signals[0].score).toBeGreaterThanOrEqual(0.7);
  });

  it("dedupes posts that appear in BOTH the search and beat-reporter results", async () => {
    const reporterGame = { ...game, sport: "nba" as const };
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("getAuthorFeed")) {
        return jsonResponse({
          feed: [{ post: fakePost({ uri: "at://shared", text: "Curry pulled from the rotation tonight breaking news", handle: "wojespn.bsky.social" }) }]
        });
      }
      return jsonResponse({
        posts: [fakePost({ uri: "at://shared", text: "Curry pulled from the rotation tonight breaking news", handle: "wojespn.bsky.social" })]
      });
    });
    const provider = new BlueskyProvider({
      fetcher: fetcher as unknown as typeof fetch,
      beatReporters: { nba: ["wojespn.bsky.social"] }
    });
    const signals = await provider.gather({ game: reporterGame, deadlineMs: 1000 });
    expect(signals).toHaveLength(1);
  });

  it("caches per-game for 90s and avoids re-hitting the API", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ posts: [fakePost({ uri: "at://x", text: "actual reaction with enough substance", likes: 10 })] }));
    let now = 1_000_000;
    const provider = new BlueskyProvider({ fetcher: fetcher as unknown as typeof fetch, now: () => now });
    await provider.gather({ game, deadlineMs: 1000 });
    const callsAfterFirst = fetcher.mock.calls.length;
    now += 30_000; // < 90s
    await provider.gather({ game, deadlineMs: 1000 });
    expect(fetcher.mock.calls.length).toBe(callsAfterFirst);
    now += 70_000; // > 90s now
    await provider.gather({ game, deadlineMs: 1000 });
    expect(fetcher.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("never throws on fetch errors — returns []", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const provider = new BlueskyProvider({ fetcher: fetcher as unknown as typeof fetch });
    const signals = await provider.gather({ game, deadlineMs: 1000 });
    expect(signals).toEqual([]);
  });

  it("never throws on non-2xx — returns []", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: "rate limited" }, { ok: false, status: 429 }));
    const provider = new BlueskyProvider({ fetcher: fetcher as unknown as typeof fetch });
    const signals = await provider.gather({ game, deadlineMs: 1000 });
    expect(signals).toEqual([]);
  });

  it("returns [] when the game has no team metadata or abbrev", async () => {
    const naked = { ...game, awayTeam: "", homeTeam: "", awayMeta: undefined, homeMeta: undefined };
    const fetcher = vi.fn(async () => jsonResponse({ posts: [] }));
    const provider = new BlueskyProvider({ fetcher: fetcher as unknown as typeof fetch });
    const signals = await provider.gather({ game: naked, deadlineMs: 1000 });
    expect(signals).toEqual([]);
  });
});

// Mirror of the provider's stableHash for assertion use.
function stableHashTest(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
