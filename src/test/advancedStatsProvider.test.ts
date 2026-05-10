import { describe, expect, it } from "vitest";
import { StaticAdvancedStatsProvider, getDefaultAdvancedStatsProvider, resetDefaultAdvancedStatsProvider } from "../server/advancedStatsProvider";
import { buildCommentaryPayload, resolveHostPersona, type CommentaryDraftInput } from "../providers/commentaryPrompts";

describe("StaticAdvancedStatsProvider", () => {
  it("returns the seed records for canonical ids that exist", async () => {
    const provider = new StaticAdvancedStatsProvider({
      version: "test",
      players: [
        { canonicalId: "4046", name: "Patrick Mahomes", sport: "nfl", season: "2025", position: "QB", team: "KC", epaPerPlay: 0.21 },
        { canonicalId: "1466", name: "Travis Kelce", sport: "nfl", season: "2025", position: "TE", team: "KC", targetShare: 0.22 }
      ]
    });
    const result = await provider.getPlayerSeason({ canonicalIds: ["4046", "missing"], sport: "nfl" });
    expect(result.map((r) => r.name)).toEqual(["Patrick Mahomes"]);
  });

  it("filters by sport so an NFL stat row never leaks into an NBA show", async () => {
    const provider = new StaticAdvancedStatsProvider({
      version: "test",
      players: [
        { canonicalId: "4046", name: "Patrick Mahomes", sport: "nfl", season: "2025" }
      ]
    });
    const result = await provider.getPlayerSeason({ canonicalIds: ["4046"], sport: "nba" });
    expect(result).toEqual([]);
  });

  it("filters by season when one is provided", async () => {
    const provider = new StaticAdvancedStatsProvider({
      version: "test",
      players: [
        { canonicalId: "4046", name: "Patrick Mahomes", sport: "nfl", season: "2025" }
      ]
    });
    expect(await provider.getPlayerSeason({ canonicalIds: ["4046"], sport: "nfl", season: "2024" })).toEqual([]);
    expect(await provider.getPlayerSeason({ canonicalIds: ["4046"], sport: "nfl", season: "2025" })).toHaveLength(1);
  });

  it("health is `disabled` with an empty bundle and `ready` otherwise", async () => {
    const empty = new StaticAdvancedStatsProvider({ version: "v0", players: [] });
    expect((await empty.health()).status).toBe("disabled");
    const filled = new StaticAdvancedStatsProvider({
      version: "v1",
      players: [{ canonicalId: "4046", name: "Patrick Mahomes", sport: "nfl", season: "2025" }]
    });
    expect((await filled.health()).status).toBe("ready");
  });

  it("default singleton hydrates from the shipped seed", async () => {
    resetDefaultAdvancedStatsProvider();
    const provider = getDefaultAdvancedStatsProvider();
    const result = await provider.getPlayerSeason({ canonicalIds: ["4046"], sport: "nfl" });
    expect(result[0]?.name).toBe("Patrick Mahomes");
    resetDefaultAdvancedStatsProvider();
  });
});

describe("buildCommentaryPayload analytics threading", () => {
  const baseInput = (): CommentaryDraftInput => ({
    play: {
      id: "p1",
      type: "pass",
      excitement: 3,
      clock: "0:00",
      quarter: "Q1",
      possession: "KC",
      headline: "h",
      description: "d",
      playerIds: [],
      team: "KC",
      score: { away: 0, home: 0 },
      occurredAt: "2026-05-09T00:00:00Z"
    },
    observation: {
      id: "obs",
      source: "stream-url",
      summary: "",
      confidence: 0.5,
      observedAt: "2026-05-09T00:00:00Z",
      latencyMs: 10
    },
    impacts: [],
    group: {
      listener: { name: "Alex" },
      friends: [],
      tone: "pg",
      homeTeamBias: "fantasy-first"
    },
    news: [],
    recentCommentary: [],
    fallbackText: "fallback",
    hostId: "maya"
  });

  it("includes analytics when provided and limits to 6 entries", () => {
    const input = baseInput();
    input.analytics = Array.from({ length: 10 }, (_, i) => ({
      canonicalId: `id-${i}`,
      name: `Player ${i}`,
      sport: "nfl",
      season: "2025",
      epaPerPlay: 0.1
    }));
    const payload = buildCommentaryPayload(input, resolveHostPersona("maya"));
    expect(payload.analytics).toHaveLength(6);
    expect(payload.analytics[0].name).toBe("Player 0");
  });

  it("emits an empty array when analytics is undefined", () => {
    const input = baseInput();
    const payload = buildCommentaryPayload(input, resolveHostPersona("maya"));
    expect(payload.analytics).toEqual([]);
  });
});
