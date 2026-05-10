import { describe, expect, it } from "vitest";
import { EspnNewsProvider, normalizeEspnNews } from "../providers/espnNewsProvider";

describe("EspnNewsProvider", () => {
  it("hits the ESPN news endpoint for the requested sport and parses headlines", async () => {
    const calls: string[] = [];
    const provider = new EspnNewsProvider(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      return new Response(
        JSON.stringify({
          articles: [
            {
              headline: "Mahomes ankle expected to be fine for Sunday",
              published: "2026-05-09T18:00:00Z",
              byline: "Beat Writer",
              links: { web: { href: "https://espn.com/article/1" } },
              categories: [
                { type: "team", team: { id: 12, abbreviation: "KC" } },
                { type: "athlete", athlete: { id: 3139477, fullName: "Patrick Mahomes" } }
              ]
            }
          ]
        })
      );
    });

    const items = await provider.getLatest({ playerIds: [], teams: ["KC"], sport: "nfl" });
    expect(calls[0]).toContain("/sports/football/nfl/news");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Mahomes ankle expected to be fine for Sunday",
      source: "ESPN — Beat Writer",
      url: "https://espn.com/article/1",
      team: "KC",
      playerIds: ["3139477"]
    });
  });

  it("filters out articles that match neither team nor player", async () => {
    const provider = new EspnNewsProvider(async () =>
      new Response(
        JSON.stringify({
          articles: [
            { headline: "About KC", categories: [{ type: "team", team: { abbreviation: "KC" } }] },
            { headline: "About JAX", categories: [{ type: "team", team: { abbreviation: "JAX" } }] }
          ]
        })
      )
    );
    const items = await provider.getLatest({ playerIds: [], teams: ["KC"], sport: "nfl" });
    expect(items.map((i) => i.title)).toEqual(["About KC"]);
  });

  it("returns the article when matched by player id even if team does not match", async () => {
    const items = normalizeEspnNews(
      [
        {
          headline: "Mahomes finishes 4-for-4 in red zone",
          categories: [
            { type: "team", team: { abbreviation: "KC" } },
            { type: "athlete", athlete: { id: 3139477 } }
          ]
        }
      ],
      { sport: "nfl", teams: ["DET"], playerIds: ["3139477"] }
    );
    expect(items).toHaveLength(1);
  });

  it("sorts newest first", () => {
    const items = normalizeEspnNews(
      [
        { headline: "Older", published: "2026-05-08T12:00:00Z", categories: [{ team: { abbreviation: "KC" } }] },
        { headline: "Newer", published: "2026-05-09T12:00:00Z", categories: [{ team: { abbreviation: "KC" } }] }
      ],
      { sport: "nfl", teams: ["KC"], playerIds: [] }
    );
    expect(items.map((i) => i.title)).toEqual(["Newer", "Older"]);
  });

  it("throws on a non-200 response so the chain can fall through", async () => {
    const provider = new EspnNewsProvider(async () => new Response("oops", { status: 500, statusText: "Internal Server Error" }));
    await expect(provider.getLatest({ playerIds: [], teams: [], sport: "nfl" })).rejects.toThrow(/ESPN news request failed: 500/);
  });
});
