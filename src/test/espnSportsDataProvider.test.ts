import { describe, expect, it } from "vitest";
import { EspnSportsDataProvider, scoreboardDateRange, ESPN_SPORTS } from "../providers/espnSportsDataProvider";
import { PlayerIdResolver } from "../server/playerIdResolver";

describe("EspnSportsDataProvider", () => {
  it("normalizes ESPN scoreboard events into game state and play data", async () => {
    const provider = new EspnSportsDataProvider(async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              id: "401",
              name: "Kansas City Chiefs at Detroit Lions",
              shortName: "KC @ DET",
              status: { displayClock: "12:42", period: 2, type: { state: "in", detail: "Q2 12:42" } },
              competitions: [
                {
                  status: { displayClock: "12:42", period: 2, type: { state: "in", detail: "Q2 12:42" } },
                  situation: {
                    possession: "12",
                    lastPlay: { id: "p1", text: "Patrick Mahomes pass complete to Travis Kelce for 21 yards.", type: { text: "Pass Reception" } }
                  },
                  competitors: [
                    { homeAway: "away", score: "13", team: { id: "12", abbreviation: "KC" } },
                    { homeAway: "home", score: "10", team: { id: "8", abbreviation: "DET" } }
                  ]
                }
              ]
            }
          ]
        })
      )
    );

    const play = await provider.nextPlay();
    const game = await provider.getGameState();

    expect(play.team).toBe("KC");
    expect(play.type).toBe("pass");
    expect(game.awayTeam).toBe("KC");
    expect(game.homeTeam).toBe("DET");
    expect(game.status).toBe("live");
  });

  it("lists games and honors a selected ESPN game id", async () => {
    const payload = {
      events: [
        {
          id: "401",
          name: "Kansas City Chiefs at Detroit Lions",
          shortName: "KC @ DET",
          status: { displayClock: "12:42", period: 2, type: { state: "in", detail: "Q2 12:42", shortDetail: "Q2" } },
          competitions: [
            {
              competitors: [
                { homeAway: "away", score: "13", team: { id: "12", abbreviation: "KC" } },
                { homeAway: "home", score: "10", team: { id: "8", abbreviation: "DET" } }
              ]
            }
          ]
        },
        {
          id: "402",
          name: "Seattle Seahawks at New England Patriots",
          shortName: "SEA @ NE",
          status: { displayClock: "0:00", period: 4, type: { state: "post", detail: "Final", shortDetail: "Final" } },
          competitions: [
            {
              competitors: [
                { homeAway: "away", score: "29", team: { id: "26", abbreviation: "SEA" } },
                { homeAway: "home", score: "13", team: { id: "17", abbreviation: "NE" } }
              ]
            }
          ]
        }
      ]
    };
    const provider = new EspnSportsDataProvider(async () => new Response(JSON.stringify(payload)), "402");

    const games = await provider.listGames();
    const game = await provider.getGameState();

    expect(games).toHaveLength(2);
    expect(games[1]).toMatchObject({ id: "nfl-402", sport: "nfl", shortName: "SEA @ NE", status: "final", score: { away: 29, home: 13 } });
    expect(game.gameId).toBe("402");
    expect(game.awayTeam).toBe("SEA");
  });

  it("classifies postponed games as 'postponed' instead of 'scheduled'", async () => {
    const payload = {
      events: [
        {
          id: "501",
          name: "Tampa Bay Rays at New York Yankees",
          shortName: "TB @ NYY",
          status: { type: { state: "pre", name: "STATUS_POSTPONED", detail: "Postponed", shortDetail: "PPD" } },
          competitions: [
            {
              competitors: [
                { homeAway: "away", score: "0", team: { id: "30", abbreviation: "TB" } },
                { homeAway: "home", score: "0", team: { id: "10", abbreviation: "NYY" } }
              ]
            }
          ]
        }
      ]
    };
    const provider = new EspnSportsDataProvider(async () => new Response(JSON.stringify(payload)));
    const games = await provider.listGames();
    expect(games[0].status).toBe("postponed");
  });

  it("classifies canceled and suspended games as 'postponed' too", async () => {
    const make = (statusName: string) => ({
      events: [
        {
          id: `e-${statusName}`,
          shortName: "X @ Y",
          status: { type: { state: "pre", name: statusName } },
          competitions: [
            {
              competitors: [
                { homeAway: "away", score: "0", team: { id: "1", abbreviation: "X" } },
                { homeAway: "home", score: "0", team: { id: "2", abbreviation: "Y" } }
              ]
            }
          ]
        }
      ]
    });
    for (const name of ["STATUS_CANCELED", "STATUS_SUSPENDED", "STATUS_FORFEIT"]) {
      const provider = new EspnSportsDataProvider(async () => new Response(JSON.stringify(make(name))));
      const games = await provider.listGames();
      expect(games[0].status).toBe("postponed");
    }
  });

  it("resolves athletesInvolved IDs through the PlayerIdResolver into canonical Sleeper-namespace IDs", async () => {
    const resolver = new PlayerIdResolver();
    resolver.register({
      canonicalId: "4046",
      name: "Patrick Mahomes",
      sport: "nfl",
      external: { sleeper: "4046", espn: "3139477" }
    });
    const payload = {
      events: [
        {
          id: "401",
          shortName: "KC @ DET",
          status: { displayClock: "12:42", period: 2, type: { state: "in", detail: "Q2 12:42" } },
          competitions: [
            {
              status: { displayClock: "12:42", period: 2, type: { state: "in", detail: "Q2 12:42" } },
              situation: {
                possession: "12",
                lastPlay: {
                  id: "p1",
                  text: "Mahomes hits Kelce.",
                  type: { text: "Pass Reception" },
                  athletesInvolved: [
                    { id: "3139477", displayName: "Patrick Mahomes" },
                    // Unknown ESPN id should fall back to namespaced
                    // form so the data isn't lost but doesn't collide.
                    { id: "999999", displayName: "Unknown Athlete" }
                  ]
                }
              },
              competitors: [
                { homeAway: "away", score: "13", team: { id: "12", abbreviation: "KC" } },
                { homeAway: "home", score: "10", team: { id: "8", abbreviation: "DET" } }
              ]
            }
          ]
        }
      ]
    };
    const provider = new EspnSportsDataProvider(
      async () => new Response(JSON.stringify(payload)),
      undefined,
      ESPN_SPORTS[0],
      resolver
    );

    const play = await provider.nextPlay();
    expect(play.playerIds).toEqual(["4046", "espn:999999"]);
  });

  it("queries ESPN with a 7-day dates window so non-today games surface", async () => {
    const calls: string[] = [];
    const provider = new EspnSportsDataProvider(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      return new Response(JSON.stringify({ events: [] }));
    });
    await provider.listGames();
    expect(calls).toHaveLength(1);
    // Must include a dates= range — exact dates depend on test clock, so
    // just assert the shape is YYYYMMDD-YYYYMMDD (8-8).
    expect(calls[0]).toMatch(/[?&]dates=\d{8}-\d{8}/);
  });
});

describe("scoreboardDateRange", () => {
  it("formats today and today+N as YYYYMMDD-YYYYMMDD", () => {
    expect(scoreboardDateRange(new Date("2026-05-09T12:00:00Z"), 7)).toMatch(/^\d{8}-\d{8}$/);
  });

  it("rolls month boundaries correctly", () => {
    // Jan 28 + 7 days = Feb 4
    const range = scoreboardDateRange(new Date("2026-01-28T12:00:00"), 7);
    const [, end] = range.split("-");
    expect(end).toBe("20260204");
  });

  it("zero-pads single-digit month and day", () => {
    const range = scoreboardDateRange(new Date("2026-03-05T12:00:00"), 0);
    expect(range).toBe("20260305-20260305");
  });
});
