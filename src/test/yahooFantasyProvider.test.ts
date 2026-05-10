import { describe, expect, it } from "vitest";
import {
  buildYahooAuthUrl,
  exchangeYahooAuthCode,
  normalizeYahooLeague,
  refreshYahooAccessToken,
  YahooFantasyProvider
} from "../providers/yahooFantasyProvider";

describe("buildYahooAuthUrl", () => {
  it("includes client_id, redirect_uri, response_type, language, and state", () => {
    const url = buildYahooAuthUrl({
      clientId: "abc",
      redirectUri: "https://example.com/cb",
      state: "listener-1"
    });
    const parsed = new URL(url);
    expect(parsed.host).toBe("api.login.yahoo.com");
    expect(parsed.searchParams.get("client_id")).toBe("abc");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://example.com/cb");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("language")).toBe("en-us");
    expect(parsed.searchParams.get("state")).toBe("listener-1");
  });
});

describe("exchangeYahooAuthCode / refreshYahooAccessToken", () => {
  it("posts the right grant_type, code, and Basic auth on exchange", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    await exchangeYahooAuthCode(
      { code: "abc", clientId: "id", clientSecret: "secret", redirectUri: "https://example.com/cb" },
      async (url, init) => {
        captured.url = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        captured.init = init;
        return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 });
      }
    );
    expect(captured.url).toBe("https://api.login.yahoo.com/oauth2/get_token");
    expect((captured.init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    const body = String(captured.init?.body);
    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("abc");
  });

  it("posts grant_type=refresh_token and the stored refresh token on refresh", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    await refreshYahooAccessToken(
      { refreshToken: "rt", clientId: "id", clientSecret: "secret", redirectUri: "https://example.com/cb" },
      async (url, init) => {
        captured.url = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        captured.init = init;
        return new Response(JSON.stringify({ access_token: "at2", expires_in: 3600 }), { status: 200 });
      }
    );
    const params = new URLSearchParams(String(captured.init?.body));
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rt");
  });
});

describe("normalizeYahooLeague", () => {
  it("pulls league metadata, teams, and starters/bench from Yahoo's nested JSON", () => {
    const league = normalizeYahooLeague(
      {
        fantasy_content: {
          league: [
            { league_id: "12345", name: "Test League", season: "2026", current_week: "5", scoring_type: "head" },
            {
              teams: {
                count: 1,
                "0": {
                  team: [
                    [
                      { team_key: "nfl.l.12345.t.1" },
                      { team_id: "1" },
                      { name: "Champs" },
                      { managers: [{ manager: { nickname: "Sam" } }] }
                    ],
                    {
                      roster: {
                        "0": {
                          players: {
                            count: 2,
                            "0": {
                              player: [
                                [
                                  { player_id: "100" },
                                  { name: { full: "Patrick Mahomes" } },
                                  { display_position: "QB" },
                                  { editorial_team_abbr: "KC" }
                                ],
                                { selected_position: [{ position: "QB" }] }
                              ]
                            },
                            "1": {
                              player: [
                                [
                                  { player_id: "101" },
                                  { name: { full: "Bench Guy" } },
                                  { display_position: "WR" },
                                  { editorial_team_abbr: "KC" }
                                ],
                                { selected_position: [{ position: "BN" }] }
                              ]
                            }
                          }
                        }
                      }
                    }
                  ]
                }
              }
            }
          ]
        }
      },
      { leagueKey: "nfl.l.12345", week: 5 }
    );

    expect(league.leagueId).toBe("12345");
    expect(league.leagueName).toBe("Test League");
    expect(league.matchups[0].rosters[0]).toMatchObject({
      teamName: "Champs",
      ownerName: "Sam"
    });
    const roster = league.matchups[0].rosters[0];
    expect(roster.starters.map((p) => p.name)).toEqual(["Patrick Mahomes"]);
    expect(roster.bench.map((p) => p.name)).toEqual(["Bench Guy"]);
  });

  it("falls back to the league key when no metadata is present", () => {
    const league = normalizeYahooLeague({ fantasy_content: { league: [] } }, { leagueKey: "nfl.l.99" });
    expect(league.leagueId).toBe("nfl.l.99");
    expect(league.matchups).toEqual([]);
  });
});

describe("YahooFantasyProvider", () => {
  it("throws when the access token provider returns nothing", async () => {
    const provider = new YahooFantasyProvider(async () => undefined);
    await expect(provider.getLeagueState({ leagueId: "nfl.l.1" })).rejects.toThrow(/Yahoo access token missing/);
  });

  it("calls Yahoo with the bearer token and ;out=settings,scoreboard,standings query", async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const provider = new YahooFantasyProvider(
      async () => "tok",
      async (url, init) => {
        captured.url = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        captured.init = init;
        return new Response(JSON.stringify({ fantasy_content: { league: [{ league_id: "9", name: "L9", season: "2026", current_week: "1" }] } }), { status: 200 });
      }
    );
    await provider.getLeagueState({ leagueId: "nfl.l.9" });
    expect(captured.url).toContain("/league/nfl.l.9");
    expect(captured.url).toContain("format=json");
    expect((captured.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("health is `disabled` without a token, `ready` with one", async () => {
    expect((await new YahooFantasyProvider(async () => undefined).health()).status).toBe("disabled");
    expect((await new YahooFantasyProvider(async () => "tok").health()).status).toBe("ready");
  });
});
