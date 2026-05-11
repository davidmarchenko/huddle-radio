import { NextResponse } from "next/server";
import { defaultGroup } from "@/server/defaultGroup";
import {
  createFantasyProvider,
  createSportsDataProvider,
  deriveSportsLabelMode,
  getActiveProviders,
  getHealth
} from "@/server/showFactories";

/**
 * Initial-state hydration for the discover page. Combines fantasy
 * league + current game + group + provider health + active provider
 * summary into one round-trip so the UI doesn't need to chain
 * fetches before it can render.
 *
 * Query params (all optional):
 *   providerMode    - "demo" | "sleeper" | "espn"
 *   sportsDataMode  - "demo" | "espn" (label hint only; routing is
 *                     derived from sportsGameId)
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
  const sportsGameId = url.searchParams.get("sportsGameId") ?? undefined;
  // Sports backend is derived from the gameId prefix
  // (see resolveSportsSource). The old sportsDataMode query param is
  // accepted for back-compat but only used for the producer-panel
  // label, where "no game picked yet" legitimately needs the toggle's
  // hint as the label.
  const sportsDataModeHint =
    (url.searchParams.get("sportsDataMode") as "demo" | "espn" | null) ?? deriveSportsLabelMode(sportsGameId);
  const sleeperLeagueId = url.searchParams.get("sleeperLeagueId") ?? undefined;
  const espnLeagueId = url.searchParams.get("espnLeagueId") ?? undefined;
  const espnSeason = url.searchParams.get("espnSeason");
  const week = url.searchParams.get("week");

  // Each upstream is independent: a fantasy load failure shouldn't
  // prevent the discover page from rendering the current game card,
  // and an ESPN-offseason "no events" should not 502 the whole
  // bootstrap. Use allSettled and return whatever succeeded — the
  // client UI already handles missing fields conditionally.
  const fantasy = createFantasyProvider(providerMode, undefined);
  const sports = createSportsDataProvider(sportsGameId);
  const [leagueResult, gameResult, healthResult] = await Promise.allSettled([
    fantasy.getLeagueState({
      leagueId: providerMode === "espn" ? espnLeagueId : sleeperLeagueId,
      week: week ? Number(week) : undefined,
      season: espnSeason ? Number(espnSeason) : undefined
    }),
    sports.getGameState(),
    getHealth()
  ]);

  const failures: Record<string, string> = {};
  const reason = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : "";
  if (leagueResult.status === "rejected") failures.fantasy = reason(leagueResult);
  if (gameResult.status === "rejected") failures.game = reason(gameResult);
  if (healthResult.status === "rejected") failures.health = reason(healthResult);

  const payload = {
    fantasy: leagueResult.status === "fulfilled" ? leagueResult.value : undefined,
    game: gameResult.status === "fulfilled" ? gameResult.value : undefined,
    group: defaultGroup,
    health: healthResult.status === "fulfilled" ? healthResult.value : [],
    providers: getActiveProviders(undefined, providerMode, sportsDataModeHint),
    ...(Object.keys(failures).length > 0 ? { failures } : {})
  };

  if (Object.keys(failures).length > 0) {
    console.warn(JSON.stringify({
      event: "bootstrap.partial",
      providerMode,
      sportsDataMode: sportsDataModeHint,
      failures,
      latencyMs: Date.now() - startedAt
    }));
  } else {
    console.log(JSON.stringify({
      event: "bootstrap.ok",
      providerMode,
      sportsDataMode: sportsDataModeHint,
      latencyMs: Date.now() - startedAt
    }));
  }
  return NextResponse.json(payload);
}
