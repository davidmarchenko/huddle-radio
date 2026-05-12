import { NextResponse } from "next/server";
import { computeEntryStatus, getEntry } from "@/server/picksStore";
import { fetchLiveStats } from "@/server/picksLiveStats";
import { parseSportPrefixedGameId } from "@/server/showFactories";
import { demoGameOptions } from "@/server/demoGameOptions";
import type { SportLeague } from "@/shared/contracts";

export const runtime = "nodejs";

/**
 * POST /api/picks/settle
 * body: { listenerId, gameId }
 *
 * Force-settles the entry against the latest box score regardless of
 * game state. Use cases:
 *   - The client detects the show has ended and wants the recap.
 *   - A scheduled job sweeps unsettled entries for completed games.
 *
 * /api/picks/status auto-settles when the box-score reports
 * `completed: true`, so this is mostly a manual override.
 */
export async function POST(request: Request) {
  let body: { listenerId?: string; gameId?: string };
  try {
    body = (await request.json()) as { listenerId?: string; gameId?: string };
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const { listenerId, gameId } = body;
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
  const wants = entry.lockedProps.map((prop) => ({
    playerName: prop.playerName,
    statType: prop.statType
  }));
  const { stats } = gameId.startsWith("demo-")
    ? { stats: new Map() }
    : await fetchLiveStats({ gameId, sport, wants });
  const status = computeEntryStatus({ entry, stats, settle: true });
  console.log(JSON.stringify({
    event: "picks.settle.ok",
    listenerId,
    gameId,
    sport,
    payout: status.payout,
    hits: status.hits,
    misses: status.misses
  }));
  return NextResponse.json(status);
}

function resolveSport(gameId: string): SportLeague | undefined {
  if (gameId.startsWith("demo-")) {
    return demoGameOptions().find((g) => g.id === gameId)?.sport;
  }
  return parseSportPrefixedGameId(gameId)?.sportPath.sport;
}
