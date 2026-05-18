/**
 * Batch endpoint that powers the discovery feed game-card chips.
 *
 * Client sends the visible slate. Server:
 *   1. Groups games by sport.
 *   2. Per sport: one markets snapshot fetch (cached upstream) + one
 *      news fetch (cached upstream).
 *   3. Per game: ranks the signals via `rankDiscoverySignalsForGame`.
 *
 * Total upstream calls regardless of slate size: ~ (sports * 2). With
 * a typical slate of 100+ games across 4 sports, the alternative
 * (per-game endpoints) would be ~200 network round-trips; this is 8.
 *
 * Returns `{ [gameId]: DiscoverySignal[] }`. Failures degrade
 * gracefully — a sport whose news fetch fails just contributes no
 * news-derived signals; markets work independently.
 */
import { NextResponse } from "next/server";
import { fetchMarketSnapshots } from "@/server/marketsProvider";
import { createNewsProvider } from "@/server/createNewsProvider";
import { rankDiscoverySignalsForGame, type DiscoverySignal } from "@/server/discoverySignals";
import { pickRelevantMarketsForGame, teamIdentifiersFromMeta } from "@/shared/marketsRelevance";
import type { MarketSnapshot, NewsItem, SportLeague, SportsGameOption } from "@/shared/contracts";

export const runtime = "nodejs";
export const maxDuration = 15;

type RequestBody = {
  games?: SportsGameOption[];
  /** Optional listener-starter playerIds — boost personalized news. */
  listenerStarterPlayerIds?: string[];
};

const VALID_SPORTS: SportLeague[] = ["nfl", "nba", "wnba", "mlb", "nhl", "ncaaf", "ncaab", "soccer"];

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    let body: RequestBody;
    try {
      body = (await request.json()) as RequestBody;
    } catch (parseError) {
      console.warn(
        JSON.stringify({
          event: "discovery.signals.bad_request",
          error: parseError instanceof Error ? parseError.message : String(parseError)
        })
      );
      return NextResponse.json({ signals: {} }, { status: 200 });
    }
    const games = Array.isArray(body.games) ? body.games : [];
    if (games.length === 0) {
      return NextResponse.json({ signals: {} });
    }

    // Group by sport so we make one upstream fetch per sport rather
    // than per game. Use a Set so order doesn't matter and duplicates
    // collapse naturally.
    const sportsInSlate = new Set<SportLeague>();
    for (const game of games) {
      if (VALID_SPORTS.includes(game.sport)) sportsInSlate.add(game.sport);
    }
    const sports = [...sportsInSlate];

    // Markets + news fire in parallel. Both have process-wide caches
    // (markets via marketsProvider, news via the provider chain), so
    // repeated discovery-feed requests in quick succession won't fan
    // out to upstreams.
    const [marketsResult, newsResult] = await Promise.allSettled([
      fetchMarketSnapshots({ sports }),
      fetchNewsBySport(sports)
    ]);
    const marketsRaw: MarketSnapshot[] = marketsResult.status === "fulfilled" ? marketsResult.value : [];
    const newsBySport: Map<SportLeague, NewsItem[]> = newsResult.status === "fulfilled" ? newsResult.value : new Map();
    if (marketsResult.status === "rejected") {
      console.warn(
        JSON.stringify({
          event: "discovery.signals.markets_failed",
          error: marketsResult.reason instanceof Error ? marketsResult.reason.message : String(marketsResult.reason),
          sports
        })
      );
    }
    if (newsResult.status === "rejected") {
      console.warn(
        JSON.stringify({
          event: "discovery.signals.news_failed",
          error: newsResult.reason instanceof Error ? newsResult.reason.message : String(newsResult.reason),
          sports
        })
      );
    }

    // Index markets by sport once so we can pass per-sport subsets to
    // the relevance helper instead of filtering N times.
    const marketsBySport = new Map<SportLeague, MarketSnapshot[]>();
    for (const snapshot of marketsRaw) {
      const bucket = marketsBySport.get(snapshot.sport) ?? [];
      bucket.push(snapshot);
      marketsBySport.set(snapshot.sport, bucket);
    }

    const signals: Record<string, DiscoverySignal[]> = {};
    for (const game of games) {
      const sportMarkets = marketsBySport.get(game.sport) ?? [];
      const teamIdentifiers = [
        ...teamIdentifiersFromMeta(game.awayTeam, game.awayMeta),
        ...teamIdentifiersFromMeta(game.homeTeam, game.homeMeta)
      ];
      const relevantMarkets = sportMarkets.length > 0
        ? pickRelevantMarketsForGame(
            sportMarkets,
            { sport: game.sport, teams: teamIdentifiers },
            4
          )
        : [];
      const sportNews = newsBySport.get(game.sport) ?? [];
      const ranked = rankDiscoverySignalsForGame({
        game,
        relevantMarkets,
        sportNews,
        // Odds intentionally omitted for v1 — per-game odds fetches
        // would defeat the batching here. Sharp-line chips therefore
        // need an odds layer (future enhancement); current chip output
        // covers markets + news + broadcast.
        listenerStarterPlayerIds: body.listenerStarterPlayerIds
      });
      if (ranked.length > 0) signals[game.id] = ranked;
    }

    console.log(
      JSON.stringify({
        event: "discovery.signals.ok",
        games: games.length,
        sports: sports.length,
        gamesWithSignals: Object.keys(signals).length,
        markets: marketsRaw.length,
        newsSports: newsBySport.size,
        latencyMs: Date.now() - startedAt
      })
    );

    return NextResponse.json(
      { signals },
      // Modest CDN-level cache: the slate changes slowly (markets
      // every 30-60s upstream, news every few minutes). Stale-while-
      // revalidate keeps subsequent visitors fast without ever showing
      // stale data older than a couple minutes.
      { headers: { "Cache-Control": "public, max-age=20, stale-while-revalidate=120" } }
    );
  } catch (error) {
    // Graceful empty so the client doesn't need a separate error
    // branch — the chips just don't render. Loud log so the operator
    // sees the outage in runtime logs.
    console.error(
      JSON.stringify({
        event: "discovery.signals.failed",
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt
      })
    );
    return NextResponse.json({ signals: {} }, { status: 200 });
  }
}

async function fetchNewsBySport(sports: SportLeague[]): Promise<Map<SportLeague, NewsItem[]>> {
  const out = new Map<SportLeague, NewsItem[]>();
  if (sports.length === 0) return out;
  const provider = createNewsProvider();
  const results = await Promise.allSettled(
    sports.map(async (sport) => {
      const items = await provider.getLatest({ playerIds: [], teams: [], sport });
      return [sport, items] as const;
    })
  );
  for (const result of results) {
    if (result.status === "fulfilled") {
      const [sport, items] = result.value;
      out.set(sport, items);
    }
  }
  return out;
}
