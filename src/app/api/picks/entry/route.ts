import { NextResponse } from "next/server";
import { getEntry } from "@/server/picksStore";

export const runtime = "nodejs";

/**
 * GET /api/picks/entry?listenerId=...&gameId=...
 *
 * Returns the PickEntry for this (listener, game) — or `null` body
 * with 200 when none exists. Used by the client to re-hydrate a
 * locked parlay after a reload; "no entry yet" is the routine
 * pre-submit state, not an error, so returning 404 would spam the
 * DevTools console with red noise on every page load.
 *
 * The /api/picks/status endpoint returns derived status only, not
 * the entry shape the UI needs to render the locked-props list, so
 * this lookup stays separate.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const listenerId = url.searchParams.get("listenerId");
  const gameId = url.searchParams.get("gameId");
  if (!listenerId || !gameId) {
    return NextResponse.json({ error: "Missing listenerId or gameId." }, { status: 400 });
  }
  const entry = getEntry(listenerId, gameId);
  if (entry) {
    console.log(JSON.stringify({
      event: "picks.entry.ok",
      listenerId,
      gameId,
      entryId: entry.id,
      status: entry.status
    }));
  }
  return NextResponse.json(entry ?? null, { headers: { "Cache-Control": "no-store" } });
}
