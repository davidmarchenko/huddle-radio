import { describe, expect, it } from "vitest";
import { fetchKalshiSnapshots } from "../providers/kalshiMarketsProvider";

function mockFetcher(responses: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (input: Request | URL | string) => {
    const url = typeof input === "string" ? input : input.toString();
    const matchKey = Object.keys(responses).find((key) => url.includes(key));
    const entry = matchKey ? responses[matchKey] : { status: 404, body: { error: "no match" } };
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

describe("fetchKalshiSnapshots", () => {
  it("normalizes a yes-side market into MarketSnapshot shape", async () => {
    const fetcher = mockFetcher({
      "series_ticker=KXNFL": {
        status: 200,
        body: {
          markets: [{
            ticker: "KXNFL-25CHIWIN-Y",
            event_ticker: "KXNFL-25CHI",
            title: "Will the Chiefs win Sunday?",
            yes_sub_title: "Chiefs",
            status: "open",
            yes_bid_dollars: 0.62,
            yes_ask_dollars: 0.66,
            last_price_dollars: 0.64,
            volume_24h: 12450
          }]
        }
      }
    });
    const snapshots = await fetchKalshiSnapshots({ sports: ["nfl"], fetcher });
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0]!;
    expect(snapshot.source).toBe("kalshi");
    expect(snapshot.sport).toBe("nfl");
    expect(snapshot.yesPriceCents).toBe(64);
    expect(snapshot.marketKind).toBe("moneyline");
    expect(snapshot.outcomeLabel).toBe("Chiefs");
    expect(snapshot.volume24hUsd).toBe(12450);
  });

  it("returns [] for offseason 404 instead of throwing", async () => {
    const fetcher = mockFetcher({
      "series_ticker=KXCBB": { status: 404, body: { code: 404, message: "no events" } }
    });
    const snapshots = await fetchKalshiSnapshots({ sports: ["ncaab"], fetcher });
    expect(snapshots).toEqual([]);
  });

  it("infers player-prop kind from prop-y titles", async () => {
    const fetcher = mockFetcher({
      "series_ticker=KXNBA": {
        status: 200,
        body: {
          markets: [{
            ticker: "KXNBA-25LAL-LBJ-25POINTS",
            title: "LeBron James over 25.5 points",
            yes_sub_title: "Over",
            last_price_dollars: 0.43
          }]
        }
      }
    });
    const snapshots = await fetchKalshiSnapshots({ sports: ["nba"], fetcher });
    expect(snapshots[0]!.marketKind).toBe("player-prop");
  });

  it("isolates per-sport failures so one outage doesn't poison the batch", async () => {
    const fetcher = mockFetcher({
      "series_ticker=KXNFL": {
        status: 200,
        body: { markets: [{ ticker: "OK", title: "ok", last_price_dollars: 0.5 }] }
      },
      "series_ticker=KXNBA": { status: 500, body: { error: "boom" } }
    });
    const snapshots = await fetchKalshiSnapshots({ sports: ["nfl", "nba"], fetcher });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.externalId).toBe("OK");
  });
});
