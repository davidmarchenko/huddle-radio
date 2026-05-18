import { NextResponse } from "next/server";
import { createSportsDataProvider } from "@/server/showFactories";
import {
  getListenerEntries,
  refreshActivePicks,
  resolveExpiredEntries
} from "@/server/livePicksStore";

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * GET /api/picks/live/active?gameId=...&listenerId=...
 *
 * Returns the rotating menu of live (in-show) snap picks for this
 * game plus any entries the listener has already locked. The endpoint
 * also drives the resolution clock — every time a client polls, we:
 *
 *   1) Re-fetch the live game state (one round-trip to the upstream
 *      provider — same one the engine uses).
 *   2) Resolve any listener entries whose windows have closed.
 *   3) Refresh the active menu with new candidate props.
 *
 * Polling-driven resolution keeps the store sync'd without a separate
 * cron — listeners only see resolution when they're actually looking
 * at the panel, and the engine still gets fresh data via its own
 * tick loop.
 *
 * Returns 200 + an empty list on any upstream failure so the panel
 * degrades gracefully — a missing menu shouldn't blow up the show.
 */
export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const gameId = url.searchParams.get("gameId")?.trim();
  const listenerId = url.searchParams.get("listenerId")?.trim() || "";

  if (!gameId) {
    return NextResponse.json({ active: [], entries: [] }, { status: 200 });
  }

  try {
    const provider = createSportsDataProvider(gameId);
    const game = await provider.getGameState();
    const now = Date.now();
    resolveExpiredEntries({ game, now });
    const active = refreshActivePicks({ game, now });
    const entries = listenerId ? getListenerEntries(listenerId, gameId) : [];

    console.log(
      JSON.stringify({
        event: "picks.live.active.ok",
        gameId,
        listenerId: listenerId ? listenerId : undefined,
        active: active.length,
        entries: entries.length,
        latencyMs: Date.now() - startedAt
      })
    );
    return NextResponse.json(
      { active, entries },
      {
        // Short freshness — live props rotate on a sub-minute cadence
        // and we want lock-state to feel responsive after a tap.
        headers: { "Cache-Control": "no-store" }
      }
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "picks.live.active.failed",
        gameId,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt
      })
    );
    return NextResponse.json({ active: [], entries: [] }, { status: 200 });
  }
}
