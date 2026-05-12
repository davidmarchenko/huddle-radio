import { NextResponse } from "next/server";
import { getEntry } from "@/server/picksStore";

export const runtime = "nodejs";

/**
 * GET /api/picks/entry?listenerId=...&gameId=...
 *
 * Returns the PickEntry for this (listener, game) or 404. Used by
 * the client to re-hydrate a locked parlay after a reload — the
 * /api/picks/status endpoint returns derived status only, not the
 * entry shape the UI needs to render the locked-props list.
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
    return NextResponse.json({ error: "No entry." }, { status: 404 });
  }
  console.log(JSON.stringify({
    event: "picks.entry.ok",
    listenerId,
    gameId,
    entryId: entry.id,
    status: entry.status
  }));
  return NextResponse.json(entry, { headers: { "Cache-Control": "no-store" } });
}
