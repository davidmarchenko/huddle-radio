import { describe, expect, it } from "vitest";
import { SportsDataIoProvider, playTypeFromText, statusFromSportsDataIo } from "../providers/sportsDataIoProvider";
import { PlayerIdResolver } from "../server/playerIdResolver";

describe("statusFromSportsDataIo", () => {
  it("maps SportsDataIO statuses", () => {
    expect(statusFromSportsDataIo("InProgress")).toBe("live");
    expect(statusFromSportsDataIo("Final")).toBe("final");
    expect(statusFromSportsDataIo("Postponed")).toBe("postponed");
    expect(statusFromSportsDataIo("Scheduled")).toBe("scheduled");
  });
});

describe("playTypeFromText", () => {
  it("recognises play kinds", () => {
    expect(playTypeFromText("Touchdown pass!")).toBe("touchdown");
    expect(playTypeFromText("Intercepted")).toBe("turnover");
    expect(playTypeFromText("Field goal good")).toBe("field-goal");
    expect(playTypeFromText("Run for 6")).toBe("rush");
    expect(playTypeFromText("Weather delay")).toBe("other");
  });
});

describe("SportsDataIoProvider", () => {
  it("rejects construction without apiKey or scoreId", () => {
    expect(() => new SportsDataIoProvider({ apiKey: "", scoreId: 1 })).toThrow();
    expect(() => new SportsDataIoProvider({ apiKey: "k", scoreId: undefined as unknown as number })).toThrow();
  });

  it("normalizes the latest play and resolves player ids through the W1 resolver", async () => {
    const resolver = new PlayerIdResolver();
    resolver.register({
      canonicalId: "4046",
      name: "Patrick Mahomes",
      sport: "nfl",
      external: { sleeper: "4046", espn: "3139477" }
    });

    let capturedUrl: string | undefined;
    const provider = new SportsDataIoProvider({
      apiKey: "test",
      scoreId: 17,
      resolver,
      fetcher: async (input) => {
        capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        return new Response(
          JSON.stringify({
            Plays: [
              { PlayID: 1, Type: "Pass", Description: "Mahomes hits Kelce." },
              {
                PlayID: 2,
                Type: "Pass",
                Description: "Mahomes touchdown to Worthy.",
                TimeRemainingDisplay: "12:42",
                QuarterName: "Q2",
                PlayerIDs: [3139477],
                Team: "KC",
                HomeTeam: "DET",
                AwayTeam: "KC",
                HomeScore: 10,
                AwayScore: 20,
                Status: "InProgress"
              }
            ]
          })
        );
      }
    });

    const play = await provider.nextPlay();
    expect(capturedUrl).toContain("/PlayByPlayDelta/17/all");
    expect(capturedUrl).toContain("key=test");
    expect(play.type).toBe("touchdown");
    expect(play.playerIds).toEqual(["4046"]);
    expect(play.score).toEqual({ away: 20, home: 10 });
  });

  it("throws on a non-200 response", async () => {
    const provider = new SportsDataIoProvider({
      apiKey: "k",
      scoreId: 1,
      fetcher: async () => new Response("nope", { status: 401, statusText: "Unauthorized" })
    });
    await expect(provider.nextPlay()).rejects.toThrow(/SportsDataIO request failed: 401/);
  });
});
