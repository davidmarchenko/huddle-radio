import { NextResponse } from "next/server";
import { createNewsProvider } from "@/server/createNewsProvider";
import type { SportLeague } from "@/shared/contracts";

/**
 * Storyline feed: latest news items relevant to the listener's teams
 * and rostered players. Feeds the discover-page rail; absent results
 * just collapse the section, so the route always returns 200 with
 * `{ news }` (possibly empty).
 */

export const runtime = "nodejs";
export const maxDuration = 20;

const VALID_SPORTS: SportLeague[] = ["nfl", "nba", "wnba", "mlb", "nhl", "ncaaf", "ncaab", "soccer"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sportParam = url.searchParams.get("sport");
  const teams = (url.searchParams.get("teams") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const playerIds = (url.searchParams.get("playerIds") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const sport = sportParam
    ? VALID_SPORTS.find((s) => s === sportParam.toLowerCase())
    : undefined;

  try {
    const news = await createNewsProvider().getLatest({ playerIds, teams, sport });
    return NextResponse.json(
      { news },
      // News refreshes infrequently; modest CDN cache prevents
      // hammering the upstream when many viewers see the same teams.
      { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ event: "news.storylines.failed", sport, error: message }));
    // Graceful empty so the client doesn't need a separate error branch.
    return NextResponse.json({ news: [] });
  }
}
