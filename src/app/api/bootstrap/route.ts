import { NextResponse } from "next/server";
import { defaultGroup } from "@/server/defaultGroup";
import { createFantasyProvider, createSportsDataProvider, getActiveProviders, getHealth } from "@/server/showFactories";

/**
 * Initial-state hydration for the discover page. Combines fantasy
 * league + current game + group + provider health + active provider
 * summary into one round-trip so the UI doesn't need to chain
 * fetches before it can render.
 *
 * Query params (all optional):
 *   providerMode    - "demo" | "sleeper" | "espn"
 *   sportsDataMode  - "demo" | "espn"
 *   sportsGameId    - sport-prefixed game id when known
 *   sleeperLeagueId - Sleeper league id (when providerMode=sleeper)
 *   espnLeagueId    - ESPN league id (when providerMode=espn)
 *   espnSeason      - season year (espn)
 *   week            - week number
 */

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const providerMode = (url.searchParams.get("providerMode") as "demo" | "sleeper" | "espn" | null) ?? "demo";
  const sportsDataMode = (url.searchParams.get("sportsDataMode") as "demo" | "espn" | null) ?? "demo";
  const sportsGameId = url.searchParams.get("sportsGameId") ?? undefined;
  const sleeperLeagueId = url.searchParams.get("sleeperLeagueId") ?? undefined;
  const espnLeagueId = url.searchParams.get("espnLeagueId") ?? undefined;
  const espnSeason = url.searchParams.get("espnSeason");
  const week = url.searchParams.get("week");

  try {
    const fantasy = createFantasyProvider(providerMode, undefined);
    const sports = createSportsDataProvider(sportsDataMode, sportsGameId);
    const [leagueState, gameState, health] = await Promise.all([
      fantasy.getLeagueState({
        leagueId: providerMode === "espn" ? espnLeagueId : sleeperLeagueId,
        week: week ? Number(week) : undefined,
        season: espnSeason ? Number(espnSeason) : undefined
      }),
      sports.getGameState(),
      getHealth()
    ]);
    const payload = {
      fantasy: leagueState,
      game: gameState,
      group: defaultGroup,
      health,
      providers: getActiveProviders(undefined, providerMode, sportsDataMode)
    };
    console.log(JSON.stringify({
      event: "bootstrap.ok",
      providerMode,
      sportsDataMode,
      latencyMs: Date.now() - startedAt
    }));
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: "bootstrap.failed",
      providerMode,
      sportsDataMode,
      error: message,
      latencyMs: Date.now() - startedAt
    }));
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
