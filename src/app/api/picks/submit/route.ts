import { NextResponse } from "next/server";
import { submitEntry } from "@/server/picksStore";
import type { ListenerPickSelection, PickProp } from "@/shared/picksContracts";

export const runtime = "nodejs";

/**
 * POST /api/picks/submit
 * body: {
 *   listenerId: string,
 *   gameId: string,
 *   selections: Array<{ propId, side: "more"|"less" }>,
 *   availableProps: PickProp[]   // slate snapshot at submit time
 * }
 *
 * Replaces any prior entry for the same (listenerId, gameId) — the
 * latest submission wins, until lock at game start.
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const body = payload as {
    listenerId?: unknown;
    gameId?: unknown;
    selections?: unknown;
    availableProps?: unknown;
  };
  if (typeof body.listenerId !== "string" || !body.listenerId) {
    return NextResponse.json({ error: "Missing listenerId." }, { status: 400 });
  }
  if (typeof body.gameId !== "string" || !body.gameId) {
    return NextResponse.json({ error: "Missing gameId." }, { status: 400 });
  }
  if (!Array.isArray(body.selections)) {
    return NextResponse.json({ error: "selections must be an array." }, { status: 400 });
  }
  if (!Array.isArray(body.availableProps)) {
    return NextResponse.json({ error: "availableProps must be an array." }, { status: 400 });
  }

  const result = submitEntry({
    listenerId: body.listenerId,
    gameId: body.gameId,
    selections: body.selections as ListenerPickSelection[],
    availableProps: body.availableProps as PickProp[]
  });
  if ("error" in result) {
    console.warn(JSON.stringify({
      event: "picks.submit.rejected",
      listenerId: body.listenerId,
      gameId: body.gameId,
      reason: result.error
    }));
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  console.log(JSON.stringify({
    event: "picks.submit.ok",
    listenerId: body.listenerId,
    gameId: body.gameId,
    entryId: result.entry.id,
    pickCount: result.entry.selections.length
  }));
  return NextResponse.json(result.entry);
}
