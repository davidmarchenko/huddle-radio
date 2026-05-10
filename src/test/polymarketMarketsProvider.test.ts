import { describe, expect, it } from "vitest";
import { fetchPolymarketSnapshots } from "../providers/polymarketMarketsProvider";

function mockFetcher(responses: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (input: Request | URL | string) => {
    const url = typeof input === "string" ? input : input.toString();
    const matchKey = Object.keys(responses).find((key) => url.includes(key));
    const entry = matchKey ? responses[matchKey] : { status: 404, body: [] };
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

describe("fetchPolymarketSnapshots", () => {
  it("emits one snapshot per outcome with prices in cents", async () => {
    const fetcher = mockFetcher({
      "tag_slug=nfl": {
        status: 200,
        body: [{
          id: "evt-1",
          title: "Chiefs vs Lions, Week 9",
          markets: [{
            conditionId: "0xabc",
            question: "Will the Chiefs win?",
            outcomes: '["Yes", "No"]',
            outcomePrices: '["0.62", "0.38"]',
            volume24hr: 88000
          }]
        }]
      }
    });
    const snapshots = await fetchPolymarketSnapshots({ sports: ["nfl"], fetcher });
    expect(snapshots).toHaveLength(2);
    const yes = snapshots.find((s) => s.outcomeLabel === "Yes");
    const no = snapshots.find((s) => s.outcomeLabel === "No");
    expect(yes?.yesPriceCents).toBe(62);
    expect(no?.yesPriceCents).toBe(38);
    expect(yes?.source).toBe("polymarket");
    expect(yes?.marketKind).toBe("moneyline");
    expect(yes?.volume24hUsd).toBe(88000);
  });

  it("infers player-prop kind from prop-y questions", async () => {
    const fetcher = mockFetcher({
      "tag_slug=nba": {
        status: 200,
        body: [{
          markets: [{
            conditionId: "0xdef",
            question: "Will Jokic record over 28.5 points?",
            outcomes: '["Yes"]',
            outcomePrices: '["0.55"]'
          }]
        }]
      }
    });
    const snapshots = await fetchPolymarketSnapshots({ sports: ["nba"], fetcher });
    expect(snapshots[0]!.marketKind).toBe("player-prop");
  });

  it("skips outcomes with malformed price arrays", async () => {
    const fetcher = mockFetcher({
      "tag_slug=mlb": {
        status: 200,
        body: [{
          markets: [{
            conditionId: "0xghi",
            question: "Will the Dodgers win?",
            outcomes: '["Yes", "No"]',
            outcomePrices: 'not-json'
          }]
        }]
      }
    });
    const snapshots = await fetchPolymarketSnapshots({ sports: ["mlb"], fetcher });
    expect(snapshots).toEqual([]);
  });
});
