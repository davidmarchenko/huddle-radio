import { describe, expect, it } from "vitest";
import {
  SportradarSportsDataProvider,
  playTypeFromSportradar,
  statusFromSportradar
} from "../providers/sportradarSportsDataProvider";
import { PlayerIdResolver } from "../server/playerIdResolver";

describe("statusFromSportradar", () => {
  it("maps Sportradar statuses to our shared status union", () => {
    expect(statusFromSportradar("inprogress")).toBe("live");
    expect(statusFromSportradar("halftime")).toBe("live");
    expect(statusFromSportradar("closed")).toBe("final");
    expect(statusFromSportradar("complete")).toBe("final");
    expect(statusFromSportradar("postponed")).toBe("postponed");
    expect(statusFromSportradar("scheduled")).toBe("scheduled");
    expect(statusFromSportradar(undefined)).toBe("scheduled");
  });
});

describe("playTypeFromSportradar", () => {
  it("recognises common play types from the type field or the description", () => {
    expect(playTypeFromSportradar("touchdown_pass", "Mahomes hits Kelce for a touchdown.")).toBe("touchdown");
    expect(playTypeFromSportradar("interception", "INT.")).toBe("turnover");
    expect(playTypeFromSportradar("field_goal", "FG.")).toBe("field-goal");
    expect(playTypeFromSportradar(undefined, "First down on the carry.")).toBe("first-down");
    expect(playTypeFromSportradar(undefined, "weather note")).toBe("other");
  });
});

describe("SportradarSportsDataProvider", () => {
  it("rejects construction without apiKey/gameId", () => {
    expect(() => new SportradarSportsDataProvider({ apiKey: "", gameId: "g" })).toThrow();
    expect(() => new SportradarSportsDataProvider({ apiKey: "k", gameId: "" })).toThrow();
  });

  it("hits the right summary URL with the api key and parses last_event into a SportsPlay", async () => {
    let captured: string | undefined;
    const provider = new SportradarSportsDataProvider({
      apiKey: "test",
      gameId: "ABC-123",
      fetcher: async (input) => {
        captured = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        return new Response(
          JSON.stringify({
            id: "ABC-123",
            status: "inprogress",
            quarter: 2,
            clock: "12:42",
            summary: {
              home: { id: "H", alias: "DET", points: 10 },
              away: { id: "A", alias: "KC", points: 13 }
            },
            last_event: {
              id: "p1",
              type: "pass_completion",
              description: "Mahomes hits Kelce for 21 yards.",
              clock: "12:42",
              quarter: 2,
              statistics: [{ player: { id: "3139477", name: "Patrick Mahomes" } }]
            }
          })
        );
      }
    });

    const play = await provider.nextPlay();
    expect(captured).toContain("/games/ABC-123/summary.json");
    expect(captured).toContain("api_key=test");
    expect(play.type).toBe("pass");
    expect(play.headline).toContain("Pass");
    expect(play.score).toEqual({ away: 13, home: 10 });
  });

  it("resolves Sportradar player IDs through the W1 resolver to canonical Sleeper IDs", async () => {
    const resolver = new PlayerIdResolver();
    resolver.register({
      canonicalId: "4046",
      name: "Patrick Mahomes",
      sport: "nfl",
      external: { sleeper: "4046", espn: "3139477" }
    });

    const provider = new SportradarSportsDataProvider({
      apiKey: "k",
      gameId: "g",
      resolver,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            id: "g",
            status: "inprogress",
            summary: { home: { alias: "DET" }, away: { alias: "KC" } },
            last_event: { id: "p1", type: "pass", statistics: [{ player: { id: "3139477" } }] }
          })
        )
    });

    const play = await provider.nextPlay();
    expect(play.playerIds).toEqual(["4046"]);
  });

  it("synthesizes a status play when no last_event is present yet", async () => {
    const provider = new SportradarSportsDataProvider({
      apiKey: "k",
      gameId: "g",
      fetcher: async () =>
        new Response(
          JSON.stringify({ id: "g", status: "scheduled", summary: { home: { alias: "DET" }, away: { alias: "KC" } } })
        )
    });
    const play = await provider.nextPlay();
    expect(play.type).toBe("other");
    expect(play.headline).toContain("Sportradar status update");
  });

  it("throws on a non-200 response", async () => {
    const provider = new SportradarSportsDataProvider({
      apiKey: "k",
      gameId: "g",
      fetcher: async () => new Response("nope", { status: 500, statusText: "Internal Server Error" })
    });
    await expect(provider.nextPlay()).rejects.toThrow(/Sportradar summary request failed: 500/);
  });
});
