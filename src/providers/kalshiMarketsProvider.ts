import type { MarketSnapshot, SportLeague } from "../shared/contracts";

/**
 * Kalshi market snapshot fetcher.
 *
 * Read-only REST endpoints don't require auth; the provider here
 * polls the public scoreboard at /trade-api/v2/markets and
 * normalizes into the shared MarketSnapshot shape. Trading
 * endpoints (and the WebSocket, which requires KYC + RSA-signed
 * headers) are out of scope.
 *
 * Rate budget: basic tier is 200 reads/sec which is far more than
 * we need; the consumer caches snapshots and re-polls every 2s for
 * the active game.
 */

const BASE = "https://external-api.kalshi.com/trade-api/v2";

type KalshiMarket = {
  ticker: string;
  event_ticker?: string;
  series_ticker?: string;
  title?: string;
  yes_sub_title?: string;
  status?: string;
  yes_bid_dollars?: number;
  yes_ask_dollars?: number;
  last_price_dollars?: number;
  volume?: number;
  volume_24h?: number;
  close_time?: string;
};

type KalshiListResponse = {
  markets?: KalshiMarket[];
  cursor?: string;
};

const SERIES_BY_SPORT: Record<SportLeague, string | undefined> = {
  nfl: "KXNFL",
  ncaaf: "KXCFB",
  nba: "KXNBA",
  ncaab: "KXCBB",
  wnba: "KXWNBA",
  mlb: "KXMLBGAME",
  nhl: "KXNHL",
  soccer: "KXSOCCER",
  other: undefined
};

function inferKindFromTicker(ticker: string, title: string): MarketSnapshot["marketKind"] {
  const haystack = `${ticker} ${title}`.toLowerCase();
  // Player-stat tokens before over/under so "LeBron over 25.5 points"
  // resolves as a prop, not a total.
  if (/(prop|points|rebound|assist|yard|reception|td|home run|strikeout)/.test(haystack)) return "player-prop";
  if (/(spread|cover|line)/.test(haystack)) return "spread";
  if (/(over|under|total points|total runs)/.test(haystack)) return "total";
  if (/(champ|division|conference|mvp|season-long)/.test(haystack)) return "futures";
  if (/(win|moneyline|game-line)/.test(haystack)) return "moneyline";
  return "other";
}

async function fetchMarkets(seriesTicker: string, fetcher: typeof fetch): Promise<KalshiMarket[]> {
  // Filter to open contracts only — settled or pending markets are
  // noise for live commentary.
  const url = `${BASE}/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=200`;
  const response = await fetcher(url, { headers: { accept: "application/json" } });
  // 404 from Kalshi date-range queries means the series is offseason;
  // treat as empty rather than a hard error.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Kalshi markets request failed: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as KalshiListResponse;
  return payload.markets ?? [];
}

export type FetchKalshiOptions = {
  sports?: SportLeague[];
  fetcher?: typeof fetch;
};

export async function fetchKalshiSnapshots(options: FetchKalshiOptions = {}): Promise<MarketSnapshot[]> {
  const fetcher = options.fetcher ?? fetch;
  const sports = options.sports ?? (Object.keys(SERIES_BY_SPORT) as SportLeague[]);
  const observedAt = new Date().toISOString();

  const tasks = sports
    .map((sport) => ({ sport, series: SERIES_BY_SPORT[sport] }))
    .filter((entry): entry is { sport: SportLeague; series: string } => Boolean(entry.series))
    .map(async ({ sport, series }) => {
      try {
        const markets = await fetchMarkets(series, fetcher);
        return markets.map<MarketSnapshot>((market) => {
          const lastDollars = market.last_price_dollars ?? market.yes_bid_dollars ?? market.yes_ask_dollars ?? 0;
          const yesPriceCents = Math.round(Math.max(0, Math.min(1, lastDollars)) * 100);
          const title = market.title ?? market.event_ticker ?? market.ticker;
          // Kalshi's canonical URL is /markets/{series}/{event} where
          // both segments are lowercase. The series_ticker is fixed
          // per sport (KXNBA, KXMLBGAME, etc.); event_ticker is the
          // specific game/event. Falling back to /markets/{ticker}
          // when the event ticker is missing — that route also resolves.
          const marketUrl = market.event_ticker
            ? `https://kalshi.com/markets/${series.toLowerCase()}/${market.event_ticker.toLowerCase()}`
            : `https://kalshi.com/markets/${market.ticker.toLowerCase()}`;
          return {
            source: "kalshi",
            externalId: market.ticker,
            sport,
            marketKind: inferKindFromTicker(market.ticker, title),
            title,
            outcomeLabel: market.yes_sub_title ?? "Yes",
            yesPriceCents,
            volume24hUsd: market.volume_24h,
            observedAt,
            marketUrl
          };
        });
      } catch {
        // Swallow per-sport failures so one outage doesn't poison
        // the whole snapshot. The consumer can decide how to surface.
        return [];
      }
    });

  const grouped = await Promise.all(tasks);
  return grouped.flat();
}
