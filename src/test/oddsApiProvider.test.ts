import { describe, expect, it } from "vitest";
import { OddsApiProvider, normalizeOddsEvent } from "../providers/oddsApiProvider";

describe("OddsApiProvider", () => {
  it("returns undefined when no API key is configured", async () => {
    const provider = new OddsApiProvider(undefined);
    const odds = await provider.getOdds({ gameId: "g1", sport: "nfl", homeTeam: "KC", awayTeam: "DET" });
    expect(odds).toBeUndefined();
  });

  it("returns undefined for sports the Odds API doesn't cover", async () => {
    const provider = new OddsApiProvider("test-key");
    const odds = await provider.getOdds({ gameId: "g1", sport: "soccer", homeTeam: "MAN", awayTeam: "LIV" });
    expect(odds).toBeUndefined();
  });

  it("hits the right Odds API URL and parses spread/total/moneyline", async () => {
    let capturedUrl: string | undefined;
    const provider = new OddsApiProvider("test-key", async (input) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(
        JSON.stringify([
          {
            id: "ev1",
            sport_key: "americanfootball_nfl",
            home_team: "Kansas City Chiefs",
            away_team: "Detroit Lions",
            bookmakers: [
              {
                key: "draftkings",
                title: "DraftKings",
                last_update: "2026-05-09T18:00:00Z",
                markets: [
                  { key: "spreads", outcomes: [{ name: "Kansas City Chiefs", point: -3.5 }, { name: "Detroit Lions", point: 3.5 }] },
                  { key: "totals", outcomes: [{ name: "Over", point: 47.5 }, { name: "Under", point: 47.5 }] },
                  { key: "h2h", outcomes: [{ name: "Kansas City Chiefs", price: -180 }, { name: "Detroit Lions", price: 154 }] }
                ]
              }
            ]
          }
        ])
      );
    });

    const odds = await provider.getOdds({ gameId: "g1", sport: "nfl", homeTeam: "KC", awayTeam: "DET" });
    expect(capturedUrl).toContain("/v4/sports/americanfootball_nfl/odds");
    expect(capturedUrl).toContain("apiKey=test-key");
    expect(odds).toMatchObject({
      gameId: "g1",
      sport: "nfl",
      homeTeam: "KC",
      awayTeam: "DET",
      spread: -3.5,
      total: 47.5,
      moneyline: { home: -180, away: 154 },
      book: "DraftKings"
    });
  });

  it("throws on a non-200 response so the caller can fall back cleanly", async () => {
    const provider = new OddsApiProvider("test-key", async () => new Response("rate", { status: 429 }));
    await expect(provider.getOdds({ gameId: "g1", sport: "nfl", homeTeam: "KC", awayTeam: "DET" })).rejects.toThrow(/Odds API request failed: 429/);
  });

  it("returns undefined when the team pairing is not found in the response", async () => {
    const provider = new OddsApiProvider("test-key", async () =>
      new Response(JSON.stringify([{ id: "ev1", home_team: "New York Giants", away_team: "Dallas Cowboys", bookmakers: [] }]))
    );
    const odds = await provider.getOdds({ gameId: "g1", sport: "nfl", homeTeam: "KC", awayTeam: "DET" });
    expect(odds).toBeUndefined();
  });

  it("normalizeOddsEvent returns moneyline=undefined when neither price is present", () => {
    const odds = normalizeOddsEvent(
      {
        id: "x",
        home_team: "Kansas City Chiefs",
        away_team: "Detroit Lions",
        bookmakers: [{ key: "dk", title: "DK", markets: [{ key: "spreads", outcomes: [{ name: "Kansas City Chiefs", point: -2 }] }] }]
      },
      { gameId: "g1", sport: "nfl", homeTeam: "KC", awayTeam: "DET" }
    );
    expect(odds.moneyline).toBeUndefined();
    expect(odds.spread).toBe(-2);
  });
});
