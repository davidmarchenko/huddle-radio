import { NextResponse } from "next/server";
import { createSportsDataProvider } from "@/server/showFactories";
import { lockLivePick, refreshActivePicks } from "@/server/livePicksStore";
import type { LivePickSide } from "@/shared/livePicksContracts";

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * POST /api/picks/live/lock
 * body: { listenerId, gameId, propId, side: "more" | "less" }
 *
 * Single-leg snap lock. The active list is refreshed first so a stale
 * client never locks a prop the server has already aged out. Re-locks
 * on the same propId are idempotent — the existing entry is returned
 * unchanged, so accidental double-taps don't double-charge stake.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const body = payload as {
    listenerId?: unknown;
    gameId?: unknown;
    propId?: unknown;
    side?: unknown;
  };
  if (typeof body.listenerId !== "string" || !body.listenerId.trim()) {
    return NextResponse.json({ error: "Missing listenerId." }, { status: 400 });
  }
  if (typeof body.gameId !== "string" || !body.gameId.trim()) {
    return NextResponse.json({ error: "Missing gameId." }, { status: 400 });
  }
  if (typeof body.propId !== "string" || !body.propId.trim()) {
    return NextResponse.json({ error: "Missing propId." }, { status: 400 });
  }
  if (body.side !== "more" && body.side !== "less") {
    return NextResponse.json({ error: "side must be 'more' or 'less'." }, { status: 400 });
  }

  const listenerId = body.listenerId.trim();
  const gameId = body.gameId.trim();
  const propId = body.propId.trim();
  const side = body.side as LivePickSide;

  // Refresh the active menu against the freshest game state before
  // locking. Otherwise a stale propId from a closed window would
  // succeed even though the prop should already be gone.
  try {
    const provider = createSportsDataProvider(gameId);
    const game = await provider.getGameState();
    refreshActivePicks({ game, now: Date.now() });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "picks.live.lock.refresh_failed",
        gameId,
        error: error instanceof Error ? error.message : String(error)
      })
    );
    // Continue — the locker will reject below if the prop is missing.
  }

  const result = lockLivePick({ listenerId, gameId, propId, side, now: Date.now() });
  if ("error" in result) {
    console.warn(
      JSON.stringify({
        event: "picks.live.lock.rejected",
        gameId,
        listenerId,
        propId,
        reason: result.error
      })
    );
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  console.log(
    JSON.stringify({
      event: "picks.live.lock.ok",
      gameId,
      listenerId,
      propId,
      side,
      latencyMs: Date.now() - startedAt
    })
  );
  return NextResponse.json({ entry: result.entry }, { status: 200 });
}
