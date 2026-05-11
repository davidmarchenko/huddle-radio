import { NextResponse } from "next/server";
import { demoGameOptions } from "@/server/demoGameOptions";
import { ESPN_SPORTS } from "@/providers/espnSportsDataProvider";
import { getDefaultSportsGamesCache } from "@/server/sportsGamesCache";
import type { SportLeague, SportsGameOption } from "@/shared/contracts";

/**
 * Game-picker source for the discover page. Returns the bundled demo
 * list when sportsDataMode=demo; for sportsDataMode=espn fans out to
 * the ESPN scoreboards (cached, with stale-while-revalidate) and
 * surfaces any per-sport failures so the UI can flag them.
 */

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const sportsDataMode = url.searchParams.get("sportsDataMode");

  if (sportsDataMode !== "espn") {
    return NextResponse.json(
      { games: demoGameOptions(), failedSports: [] as Array<{ sport: SportLeague; label: string }> },
      // Demo data is static; cache aggressively at the CDN.
      { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } }
    );
  }

  const cache = getDefaultSportsGamesCache();
  const results = await Promise.allSettled(ESPN_SPORTS.map((sportPath) => cache.get(sportPath)));
  const failedSports: Array<{ sport: SportLeague; label: string }> = [];
  const games: SportsGameOption[] = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const sport = ESPN_SPORTS[index];
    console.warn(JSON.stringify({
      event: "sports.games.scoreboard-failed",
      sport: sport.sport,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason)
    }));
    failedSports.push({ sport: sport.sport, label: sport.label });
    return [];
  });

  console.log(JSON.stringify({
    event: "sports.games.ok",
    mode: "espn",
    games: games.length,
    failedSports: failedSports.length,
    latencyMs: Date.now() - startedAt
  }));

  return NextResponse.json(
    { games, failedSports },
    {
      // Same TTL as the in-memory cache — decouples user count from
      // ESPN request count at every layer (CDN + Function + cache).
      headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=120" }
    }
  );
}
