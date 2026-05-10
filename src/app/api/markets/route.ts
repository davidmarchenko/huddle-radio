import { NextResponse } from "next/server";
import { fetchMarketSnapshots } from "@/server/marketsProvider";
import type { SportLeague } from "@/shared/contracts";

const VALID_SPORTS: SportLeague[] = [
  "nfl", "nba", "wnba", "mlb", "nhl", "ncaaf", "ncaab", "soccer"
];

// Node runtime: the underlying providers do real network I/O and
// we want Fluid Compute's Active CPU pricing (only billed during
// the fetch). Edge runtime is fine here too but Node keeps the
// upgrade path simpler when we add ffmpeg / yt-dlp routes later.
export const runtime = "nodejs";

// 2-second cache headers match the in-process cache TTL — public
// CDN can collapse load when many viewers watch the same game.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const sportParam = url.searchParams.get("sport");
  const sports = sportParam
    ? sportParam
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is SportLeague => (VALID_SPORTS as string[]).includes(s))
    : undefined;

  const startedAt = Date.now();
  try {
    const snapshots = await fetchMarketSnapshots({ sports });
    console.log(JSON.stringify({
      event: "markets.fetch.ok",
      sports: sports ?? "all",
      count: snapshots.length,
      latencyMs: Date.now() - startedAt
    }));
    return NextResponse.json(
      { snapshots, count: snapshots.length },
      {
        headers: {
          "Cache-Control": "public, max-age=2, stale-while-revalidate=10"
        }
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: "markets.fetch.failed",
      sports: sports ?? "all",
      latencyMs: Date.now() - startedAt,
      error: message
    }));
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
