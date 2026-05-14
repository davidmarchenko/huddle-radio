import { describe, expect, it, vi } from "vitest";
import { RedditGameThreadProvider } from "../providers/enrichment/redditProvider";
import type { SportsGameState } from "../shared/contracts";

const game: SportsGameState = {
  provider: "espn-scoreboard",
  gameId: "wnba-401856904",
  sport: "wnba",
  awayTeam: "SEA",
  homeTeam: "LV",
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

const searchHit = {
  data: {
    children: [
      {
        data: {
          id: "abc123",
          title: "Game Thread: Seattle Storm @ Las Vegas Aces",
          link_flair_text: "Game Thread",
          permalink: "/r/wnba/comments/abc123/game_thread/"
        }
      }
    ]
  }
};

function commentsResponse(comments: Array<Partial<{ id: string; body: string; score: number; created_utc: number; stickied: boolean; distinguished: string | null }>>) {
  return [
    { data: {} }, // post listing — provider ignores
    {
      data: {
        children: comments.map((c) => ({
          kind: "t1",
          data: {
            id: c.id ?? "x",
            body: c.body ?? "",
            score: c.score ?? 0,
            created_utc: c.created_utc ?? Math.floor(Date.now() / 1000),
            stickied: c.stickied ?? false,
            distinguished: c.distinguished ?? null,
            author: "u/fan"
          }
        }))
      }
    }
  ];
}

describe("RedditGameThreadProvider", () => {
  it("returns [] for sports without a configured subreddit", async () => {
    const fetcher = vi.fn();
    const provider = new RedditGameThreadProvider({ fetcher: fetcher as unknown as typeof fetch });
    const out = await provider.gather({ game: { ...game, sport: "other" }, deadlineMs: 1000 });
    expect(out).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("finds a game thread and shapes comments into EnrichmentSignals", async () => {
    const comments = commentsResponse([
      { id: "c1", body: "WILSON FROM DEEP, WHAT A SHOT THIS IS UNREAL", score: 200 },
      { id: "c2", body: "Storm defense looking lost on switches tonight", score: 80 },
      { id: "c3", body: "lol", score: 5 } // too short — filtered
    ]);
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/search.json")) return jsonResponse(searchHit);
      return jsonResponse(comments);
    });
    const provider = new RedditGameThreadProvider({ fetcher: fetcher as unknown as typeof fetch });
    const out = await provider.gather({ game, deadlineMs: 1000 });
    expect(out).toHaveLength(2);
    expect(out[0].source).toBe("reddit");
    expect(out[0].kind).toBe("reaction");
    expect(out[0].id).toBe("reddit-c1");
    expect(out[0].text).toContain("WILSON");
  });

  it("filters stickied / moderator / deleted / downvoted / overlong comments", async () => {
    const comments = commentsResponse([
      { id: "good", body: "actual fan reaction with substance to it here", score: 50 },
      { id: "sticky", body: "subreddit rules go here read them please", score: 999, stickied: true },
      { id: "mod", body: "moderator announcement everyone please be civil", score: 999, distinguished: "moderator" },
      { id: "deleted", body: "[deleted] by user", score: 100 },
      { id: "down", body: "downvoted contrarian take with substance", score: 0 },
      { id: "huge", body: "x".repeat(400), score: 100 }
    ]);
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/search.json")) return jsonResponse(searchHit);
      return jsonResponse(comments);
    });
    const provider = new RedditGameThreadProvider({ fetcher: fetcher as unknown as typeof fetch });
    const out = await provider.gather({ game, deadlineMs: 1000 });
    expect(out.map((s) => s.id)).toEqual(["reddit-good"]);
  });

  it("caches the discovered thread URL across ticks (no re-search within window)", async () => {
    const comments = commentsResponse([{ id: "c1", body: "great play just now from Wilson", score: 50 }]);
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/search.json")) return jsonResponse(searchHit);
      return jsonResponse(comments);
    });
    let now = 1_000_000;
    const provider = new RedditGameThreadProvider({ fetcher: fetcher as unknown as typeof fetch, now: () => now });
    await provider.gather({ game, deadlineMs: 1000 });
    await provider.gather({ game, deadlineMs: 1000 });
    const searchCalls = fetcher.mock.calls.filter(([url]) => String(url).includes("/search.json")).length;
    const commentCalls = fetcher.mock.calls.filter(([url]) => String(url).includes("/comments/")).length;
    expect(searchCalls).toBe(1); // search cached
    expect(commentCalls).toBe(2); // comments re-fetched each tick
  });

  it("re-searches after the thread cache window expires", async () => {
    const comments = commentsResponse([{ id: "c1", body: "huge bucket from the corner there", score: 50 }]);
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/search.json")) return jsonResponse(searchHit);
      return jsonResponse(comments);
    });
    let now = 0;
    const provider = new RedditGameThreadProvider({ fetcher: fetcher as unknown as typeof fetch, now: () => now });
    await provider.gather({ game, deadlineMs: 1000 });
    now += 11 * 60 * 1000; // > 10min cache TTL
    await provider.gather({ game, deadlineMs: 1000 });
    const searchCalls = fetcher.mock.calls.filter(([url]) => String(url).includes("/search.json")).length;
    expect(searchCalls).toBe(2);
  });

  it("returns [] when search comes back empty (no game thread found)", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: { children: [] } }));
    const provider = new RedditGameThreadProvider({ fetcher: fetcher as unknown as typeof fetch });
    const out = await provider.gather({ game, deadlineMs: 1000 });
    expect(out).toEqual([]);
  });

  it("never throws past the public surface — swallows fetch errors", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const provider = new RedditGameThreadProvider({ fetcher: fetcher as unknown as typeof fetch });
    const out = await provider.gather({ game, deadlineMs: 1000 });
    expect(out).toEqual([]);
  });

  it("never throws when reddit returns a non-2xx", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: "rate limited" }, { ok: false, status: 429 }));
    const provider = new RedditGameThreadProvider({ fetcher: fetcher as unknown as typeof fetch });
    const out = await provider.gather({ game, deadlineMs: 1000 });
    expect(out).toEqual([]);
  });

  it("sends a custom User-Agent (reddit blocks default UAs)", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: { children: [] } }));
    const provider = new RedditGameThreadProvider({ fetcher: fetcher as unknown as typeof fetch });
    await provider.gather({ game, deadlineMs: 1000 });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/huddle-radio/);
  });

  it("matches game thread by team displayName even when abbrev is absent (OKC, VGK, GB)", async () => {
    const okcGame = {
      ...game,
      sport: "nba" as const,
      homeTeam: "OKC",
      awayTeam: "MIA",
      homeMeta: { abbreviation: "OKC", shortName: "Thunder", displayName: "Oklahoma City Thunder" },
      awayMeta: { abbreviation: "MIA", shortName: "Heat", displayName: "Miami Heat" }
    };
    const search = {
      data: {
        children: [
          {
            data: {
              id: "right",
              title: "GAME THREAD: Miami Heat (12-5) @ Oklahoma City Thunder (14-3)",
              link_flair_text: "Game Thread",
              permalink: "/r/nba/comments/right/"
            }
          }
        ]
      }
    };
    const comments = commentsResponse([{ id: "c1", body: "Thunder defense looking nasty tonight on switches", score: 100 }]);
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/search.json")) return jsonResponse(search);
      return jsonResponse(comments);
    });
    const provider = new RedditGameThreadProvider({ fetcher: fetcher as unknown as typeof fetch });
    const out = await provider.gather({ game: okcGame, deadlineMs: 1000 });
    expect(out).toHaveLength(1);
  });

  it("prefers shortName/displayName over abbrev in the search query", async () => {
    const okcGame = {
      ...game,
      sport: "nba" as const,
      homeTeam: "OKC",
      awayTeam: "MIA",
      homeMeta: { abbreviation: "OKC", shortName: "Thunder", displayName: "Oklahoma City Thunder" },
      awayMeta: { abbreviation: "MIA", shortName: "Heat", displayName: "Miami Heat" }
    };
    const fetcher = vi.fn(async () => jsonResponse({ data: { children: [] } }));
    const provider = new RedditGameThreadProvider({ fetcher: fetcher as unknown as typeof fetch });
    await provider.gather({ game: okcGame, deadlineMs: 1000 });
    const firstCall = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const searchUrl = String(firstCall?.[0] ?? "");
    expect(searchUrl).toContain("Thunder");
    expect(searchUrl).toContain("Heat");
    expect(searchUrl).not.toMatch(/[?&]q=[^&]*OKC/);
  });

  it("avoids false-positive substring matches for short abbrevs (LA != play)", async () => {
    const laGame = {
      ...game,
      sport: "nba" as const,
      homeTeam: "LA",
      awayTeam: "BOS",
      // No meta — forces the matcher to fall back to the abbrev.
      homeMeta: undefined,
      awayMeta: undefined
    };
    const search = {
      data: {
        children: [
          {
            data: {
              id: "wrong",
              title: "Post-game thread: who else played well tonight",
              link_flair_text: "Discussion",
              permalink: "/r/nba/comments/wrong/"
            }
          }
        ]
      }
    };
    const fetcher = vi.fn(async () => jsonResponse(search));
    const provider = new RedditGameThreadProvider({ fetcher: fetcher as unknown as typeof fetch });
    const out = await provider.gather({ game: laGame, deadlineMs: 1000 });
    expect(out).toEqual([]);
  });

  it("matches game thread by team abbreviation in the title", async () => {
    const wrongGame = {
      data: {
        children: [
          {
            data: {
              id: "wrong",
              title: "Game Thread: Liberty @ Sun",
              link_flair_text: "Game Thread",
              permalink: "/r/wnba/comments/wrong/"
            }
          },
          {
            data: {
              id: "right",
              title: "Game Thread: Storm @ Aces (SEA @ LV)",
              link_flair_text: "Game Thread",
              permalink: "/r/wnba/comments/right/"
            }
          }
        ]
      }
    };
    const comments = commentsResponse([{ id: "c1", body: "what a play that was tonight", score: 50 }]);
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/search.json")) return jsonResponse(wrongGame);
      // Capture which permalink was followed by inspecting the URL.
      if (url.includes("/right/")) return jsonResponse(comments);
      return jsonResponse([{ data: {} }, { data: { children: [] } }]);
    });
    const provider = new RedditGameThreadProvider({ fetcher: fetcher as unknown as typeof fetch });
    const out = await provider.gather({ game, deadlineMs: 1000 });
    expect(out).toHaveLength(1);
  });
});
