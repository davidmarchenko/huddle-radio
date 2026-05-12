import { NextResponse } from "next/server";
import type { MarketHistoryPoint } from "@/shared/contracts";

/**
 * Price history fetcher for the rich market preview sparkline.
 *
 * Routes to the right upstream by `source`:
 *
 *   polymarket — CLOB /prices-history takes a `market` token ID
 *     (the YES side from clobTokenIds[idx]). The conditionId we use
 *     elsewhere returns 404 there.
 *   kalshi — /trade-api/v2/series/{series}/markets/{ticker}/candlesticks
 *     returns OHLC candles; we extract `close` per candle for the
 *     sparkline. (Falling back to the simpler /markets/{ticker}/
 *     candlesticks when series can't be inferred.)
 *
 * Output is normalized: `{ history: [{ ts, priceCents }] }`. Empty
 * history is a legitimate response (some markets are too new for
 * history yet) — the UI hides the sparkline gracefully.
 *
 * Cached in-memory with a 5-minute TTL plus a CDN cache header so
 * repeat hovers across a session (and across users) don't re-hit
 * upstream. Cache key includes source + identifier so distinct
 * markets don't collide.
 */

export const runtime = "nodejs";
export const maxDuration = 10;

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: MarketHistoryPoint[]; expiresAt: number }>();
const FETCH_TIMEOUT_MS = 5000;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const source = url.searchParams.get("source");
  const externalId = url.searchParams.get("externalId");
  const clobTokenId = url.searchParams.get("clobTokenId") ?? undefined;
  const sport = url.searchParams.get("sport") ?? undefined;

  if (!source || !externalId) {
    return NextResponse.json({ error: "Missing source or externalId." }, { status: 400 });
  }

  const cacheKey = `${source}:${clobTokenId ?? externalId}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return jsonWithCache(cached.value);
  }

  const startedAt = Date.now();
  try {
    let history: MarketHistoryPoint[] = [];
    if (source === "polymarket") {
      if (!clobTokenId) {
        // Older snapshots without clobTokenId can't query CLOB. Return
        // empty history — the UI hides the sparkline gracefully.
        return jsonWithCache([]);
      }
      history = await fetchPolymarketHistory(clobTokenId);
    } else if (source === "kalshi") {
      history = await fetchKalshiHistory(externalId, sport);
    } else {
      return NextResponse.json({ error: "Unknown source." }, { status: 400 });
    }
    cache.set(cacheKey, { value: history, expiresAt: Date.now() + CACHE_TTL_MS });
    console.log(
      JSON.stringify({
        event: "markets.history.ok",
        source,
        identifier: clobTokenId ?? externalId,
        latencyMs: Date.now() - startedAt,
        points: history.length
      })
    );
    return jsonWithCache(history);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "markets.history.failed",
        source,
        identifier: clobTokenId ?? externalId,
        error: error instanceof Error ? error.message : String(error)
      })
    );
    // Cache the empty result briefly so a transient upstream failure
    // doesn't get retried on every single hover.
    cache.set(cacheKey, { value: [], expiresAt: Date.now() + 60_000 });
    return jsonWithCache([]);
  }
}

function jsonWithCache(history: MarketHistoryPoint[]) {
  return NextResponse.json(
    { history },
    {
      headers: {
        "Cache-Control": "public, max-age=120, s-maxage=300, stale-while-revalidate=600"
      }
    }
  );
}

async function fetchPolymarketHistory(clobTokenId: string): Promise<MarketHistoryPoint[]> {
  // 24-hour window with ~10-minute fidelity gives a clean sparkline
  // that's not too noisy and still shows the recent move.
  const url = `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(clobTokenId)}&interval=1d&fidelity=10`;
  const response = await timedFetch(url);
  if (!response.ok) {
    throw new Error(`Polymarket history HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { history?: Array<{ t: number; p: number }> };
  return (payload.history ?? []).map((point) => ({
    ts: new Date(point.t * 1000).toISOString(),
    priceCents: Math.round(Math.max(0, Math.min(1, point.p)) * 100)
  }));
}

const KALSHI_SERIES_BY_SPORT: Record<string, string> = {
  nfl: "KXNFL",
  ncaaf: "KXCFB",
  nba: "KXNBA",
  ncaab: "KXCBB",
  wnba: "KXWNBA",
  mlb: "KXMLBGAME",
  nhl: "KXNHL",
  soccer: "KXSOCCER"
};

async function fetchKalshiHistory(ticker: string, sport?: string): Promise<MarketHistoryPoint[]> {
  // Last 24 hours of 15-minute candles — same shape as Polymarket's
  // 10-minute fidelity. Series is required by the candlesticks
  // endpoint; infer from sport when available, else parse out of
  // the ticker prefix (KXNBA-... → KXNBA).
  const series =
    (sport && KALSHI_SERIES_BY_SPORT[sport]) ??
    ticker.split(/[-_]/)[0] ??
    "";
  if (!series) throw new Error("Could not resolve Kalshi series for ticker.");
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - 24 * 60 * 60;
  const url =
    `https://external-api.kalshi.com/trade-api/v2/series/${encodeURIComponent(series)}` +
    `/markets/${encodeURIComponent(ticker)}/candlesticks` +
    `?start_ts=${startTs}&end_ts=${endTs}&period_interval=15`;
  const response = await timedFetch(url);
  if (!response.ok) {
    throw new Error(`Kalshi history HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    candlesticks?: Array<{ end_period_ts: number; price?: { close?: number } }>;
  };
  return (payload.candlesticks ?? [])
    .filter((c) => c.price?.close != null)
    .map((c) => ({
      ts: new Date(c.end_period_ts * 1000).toISOString(),
      // Kalshi candlestick prices are returned in cents already.
      priceCents: Math.round(c.price!.close!)
    }));
}

async function timedFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}
