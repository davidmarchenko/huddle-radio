import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/markets/route";
import { resetMarketsProviderState } from "../server/marketsProvider";

/**
 * Integration tests for GET /api/markets.
 *
 * The route fans out to live Kalshi + Polymarket REST endpoints.
 * We stub global fetch so tests are deterministic + offline. The
 * marketsProvider cache is reset between cases so an earlier test
 * can't bleed snapshot state into a later one.
 */

const KALSHI_RESPONSE = {
  markets: [
    {
      ticker: "KXNFL-26-KC",
      event_ticker: "KXNFL-26",
      title: "Will the Chiefs win the Super Bowl?",
      yes_sub_title: "Chiefs",
      yes_bid: 60,
      yes_ask: 62,
      volume_24h: 12345
    }
  ]
};

const POLYMARKET_EMPTY: unknown[] = [];

function stubFetch(response: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(response), {
        status,
        headers: { "content-type": "application/json" }
      })
    )
  );
}

function stubFetchByUrl(handler: (url: string) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return handler(url);
    })
  );
}

beforeEach(() => {
  resetMarketsProviderState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRequest(url = "http://test.local/api/markets"): Request {
  return new Request(url, { method: "GET" });
}

describe("GET /api/markets", () => {
  it("returns the merged Kalshi + Polymarket snapshots with a count + cache headers", async () => {
    stubFetchByUrl((url) => {
      if (url.includes("kalshi")) {
        return new Response(JSON.stringify(KALSHI_RESPONSE), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      // Polymarket Gamma events endpoint
      return new Response(JSON.stringify(POLYMARKET_EMPTY), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const response = await GET(makeRequest("http://test.local/api/markets?sport=nfl"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toMatch(/max-age=2/);
    const payload = (await response.json()) as { snapshots: unknown[]; count: number };
    expect(payload.count).toBeGreaterThan(0);
    expect(Array.isArray(payload.snapshots)).toBe(true);
  });

  it("filters out unknown sport names instead of querying providers for them", async () => {
    const fetchSpy = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ markets: [] })));
    vi.stubGlobal("fetch", fetchSpy);
    const response = await GET(makeRequest("http://test.local/api/markets?sport=cricket,nfl"));
    expect(response.status).toBe(200);
    // Only nfl made it through the sport filter — cricket was dropped
    // before it could turn into a Kalshi series request.
    const callUrls = fetchSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(callUrls.every((url) => !url.toLowerCase().includes("cricket"))).toBe(true);
  });

  it("treats a Kalshi 404 as offseason (empty), not an error", async () => {
    // Kalshi returns 404 for series that aren't currently live; the
    // provider must swallow that and return an empty array so the
    // route still returns 200.
    stubFetchByUrl((url) => {
      if (url.includes("kalshi")) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify(POLYMARKET_EMPTY), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const response = await GET(makeRequest("http://test.local/api/markets?sport=nba"));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { count: number };
    expect(payload.count).toBe(0);
  });
});
