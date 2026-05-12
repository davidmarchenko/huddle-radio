import { NextResponse } from "next/server";
import { fetchMarketSnapshots } from "@/server/marketsProvider";
import { buildPickSlate } from "@/server/picksGenerator";
import { getDefaultSportsGamesCache } from "@/server/sportsGamesCache";
import { demoGameOptions } from "@/server/demoGameOptions";
import { ESPN_SPORTS, type EspnSportPath } from "@/providers/espnSportsDataProvider";
import { parseSportPrefixedGameId } from "@/server/showFactories";
import type { SportLeague, SportsGameOption } from "@/shared/contracts";

export const runtime = "nodejs";

/**
 * GET /api/picks/slate?gameId=...
 *
 * Builds a 4-6-prop slate for the requested game by:
 *   1) Resolving sport + teams from the gameId (sport-prefixed for
 *      ESPN ids, or by lookup in the demo list for "demo-*").
 *   2) Fetching player-prop markets for that sport.
 *   3) Filtering + diversifying via picksGenerator.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const gameId = url.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json({ error: "Missing gameId." }, { status: 400 });
  }

  const resolved = await resolveGame(gameId);
  if (!resolved) {
    return NextResponse.json({ error: "Game not found." }, { status: 404 });
  }
  const { sport, homeTeam, awayTeam } = resolved;

  const startedAt = Date.now();
  try {
    const markets = await fetchMarketSnapshots({ sports: [sport] });
    const slate = buildPickSlate({
      gameId,
      sport,
      teams: [homeTeam, awayTeam],
      markets
    });
    console.log(JSON.stringify({
      event: "picks.slate.ok",
      gameId,
      sport,
      props: slate.props.length,
      synthetic: slate.synthetic,
      latencyMs: Date.now() - startedAt
    }));
    return NextResponse.json(slate, {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=120, stale-while-revalidate=300"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: "picks.slate.failed",
      gameId,
      latencyMs: Date.now() - startedAt,
      error: message
    }));
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

async function resolveGame(gameId: string): Promise<
  { sport: SportLeague; homeTeam: string; awayTeam: string } | undefined
> {
  if (gameId.startsWith("demo-")) {
    const game = demoGameOptions().find((g: SportsGameOption) => g.id === gameId);
    if (!game) return undefined;
    return { sport: game.sport, homeTeam: game.homeTeam, awayTeam: game.awayTeam };
  }
  const parsed = parseSportPrefixedGameId(gameId);
  if (!parsed) return undefined;
  const sportPath: EspnSportPath = parsed.sportPath;
  const cache = getDefaultSportsGamesCache();
  try {
    const games = await cache.get(sportPath);
    const game = games.find((g) => g.id === gameId);
    if (!game) return undefined;
    return { sport: sportPath.sport, homeTeam: game.homeTeam, awayTeam: game.awayTeam };
  } catch {
    return undefined;
  }
  // Fallback never used — narrowing keeps tsc happy.
  void ESPN_SPORTS;
}
