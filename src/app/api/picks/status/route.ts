import { NextResponse } from "next/server";
import { computeEntryStatus, getEntry, lockEntry } from "@/server/picksStore";
import { fetchLiveStats } from "@/server/picksLiveStats";
import { parseSportPrefixedGameId } from "@/server/showFactories";
import { demoGameOptions } from "@/server/demoGameOptions";
import type { SportLeague } from "@/shared/contracts";

export const runtime = "nodejs";

/**
 * GET /api/picks/status?listenerId=...&gameId=...
 *
 * Returns the EntryStatus for the listener's entry on this game:
 * per-pick status (hit / miss / live-on-track / live-off-track /
 * pending), parlay totals, projected payout, and a hostHint for the
 * commentary engine to weave in.
 *
 * Does NOT settle — settlement runs on /api/picks/settle, which the
 * client triggers (or the engine triggers internally) once the game
 * goes final. Status here is "live snapshot" only.
 *
 * Cached briefly so a 5s client poll doesn't pin ESPN's box-score
 * endpoint per session.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const listenerId = url.searchParams.get("listenerId");
  const gameId = url.searchParams.get("gameId");
  if (!listenerId || !gameId) {
    return NextResponse.json({ error: "Missing listenerId or gameId." }, { status: 400 });
  }

  const entry = getEntry(listenerId, gameId);
  if (!entry) {
    return NextResponse.json({ error: "No entry for this listener/game." }, { status: 404 });
  }

  const sport = resolveSport(gameId);
  if (!sport) {
    return NextResponse.json({ error: "Could not resolve sport for gameId." }, { status: 400 });
  }

  const startedAt = Date.now();
  // Demo gameIds have no ESPN box score — return the entry with all
  // picks pending. The UI shows the locked slate and the commentary
  // engine doesn't get bubble hints, but the flow doesn't break.
  if (gameId.startsWith("demo-")) {
    const status = computeEntryStatus({ entry, stats: new Map(), settle: false });
    return NextResponse.json(status, {
      headers: { "Cache-Control": "no-store" }
    });
  }

  // Auto-lock once we see live stats — the entry was pending (game
  // hadn't started); now the box score is available so picks freeze.
  const wants = entry.lockedProps.map((prop) => ({
    playerName: prop.playerName,
    statType: prop.statType
  }));
  const { stats, gameCompleted } = await fetchLiveStats({ gameId, sport, wants });
  if (entry.status === "pending" && stats.size > 0) {
    lockEntry(listenerId, gameId);
  }
  const fresh = getEntry(listenerId, gameId)!;
  const status = computeEntryStatus({ entry: fresh, stats, settle: gameCompleted });
  console.log(JSON.stringify({
    event: "picks.status.ok",
    listenerId,
    gameId,
    sport,
    pickCount: status.picks.length,
    hits: status.hits,
    misses: status.misses,
    pending: status.pending,
    settled: gameCompleted,
    latencyMs: Date.now() - startedAt
  }));
  return NextResponse.json(status, {
    headers: {
      "Cache-Control": "private, max-age=5, stale-while-revalidate=15"
    }
  });
}

function resolveSport(gameId: string): SportLeague | undefined {
  if (gameId.startsWith("demo-")) {
    const game = demoGameOptions().find((g) => g.id === gameId);
    return game?.sport;
  }
  return parseSportPrefixedGameId(gameId)?.sportPath.sport;
}
