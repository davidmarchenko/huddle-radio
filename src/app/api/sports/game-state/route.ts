/**
 * Per-game state endpoint. Returns the current `SportsGameState` for
 * a single gameId, including the most-recent plays the upstream
 * provider has buffered.
 *
 * The live-show views hydrate "Recent Highlights" from this BEFORE
 * the show starts streaming — without it, opening a live game from
 * a deep link or the discovery feed shows "Waiting for the first
 * moment" even when the game is actually in progress.
 *
 * Provider routing follows the same gameId-prefix rules as the live
 * show engine (see `resolveSportsSource` / `createSportsDataProvider`).
 * Failures degrade to 200 + `{ game: null }` so the client doesn't
 * need a separate error branch — the panel just falls back to the
 * "waiting for the first moment" empty state.
 */
import { NextResponse } from "next/server";
import { createSportsDataProvider } from "@/server/showFactories";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const gameId = url.searchParams.get("gameId")?.trim();
  if (!gameId) {
    console.warn(
      JSON.stringify({
        event: "sports.gameState.bad_request",
        reason: "missing gameId"
      })
    );
    return NextResponse.json({ game: null }, { status: 200 });
  }
  try {
    const provider = createSportsDataProvider(gameId);
    const game = await provider.getGameState();
    console.log(
      JSON.stringify({
        event: "sports.gameState.ok",
        gameId,
        sport: game.sport,
        status: game.status,
        recentPlays: game.recentPlays.length,
        latencyMs: Date.now() - startedAt
      })
    );
    return NextResponse.json(
      { game },
      // Live games change quickly — short freshness window with
      // a stale-while-revalidate so reloads stay snappy without
      // ever showing data older than a couple minutes.
      { headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=60" } }
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "sports.gameState.failed",
        gameId,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt
      })
    );
    return NextResponse.json({ game: null }, { status: 200 });
  }
}
