import { NextResponse } from "next/server";
import { createOddsProvider } from "@/server/createOddsProvider";
import type { SportLeague } from "@/shared/contracts";

/**
 * Pre-game Vegas line lookup. The pregame view surfaces a "Vegas
 * line" card when this returns data; absence is graceful — the card
 * just doesn't render. Always returns 200 so the client doesn't have
 * to special-case missing-line vs missing-route.
 */

export const runtime = "nodejs";
export const maxDuration = 15;

const VALID_SPORTS: SportLeague[] = ["nfl", "nba", "wnba", "mlb", "nhl", "ncaaf", "ncaab", "soccer"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const gameId = url.searchParams.get("gameId");
  const sportParam = url.searchParams.get("sport");
  const homeTeam = url.searchParams.get("homeTeam");
  const awayTeam = url.searchParams.get("awayTeam");

  if (!gameId || !sportParam || !homeTeam || !awayTeam) {
    return NextResponse.json({ odds: undefined });
  }
  const sport = VALID_SPORTS.find((s) => s === sportParam.toLowerCase());
  if (!sport) {
    return NextResponse.json({ odds: undefined });
  }

  try {
    const odds = await createOddsProvider().getOdds({ gameId, sport, homeTeam, awayTeam });
    return NextResponse.json(
      { odds },
      // Vegas lines move slowly; a short cache + SWR is plenty.
      { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ event: "odds.failed", gameId, sport, error: message }));
    // Returning 200 + odds:undefined keeps the client UI graceful.
    return NextResponse.json({ odds: undefined });
  }
}
