import { NextResponse } from "next/server";
import { destroySession } from "@/server/showSessionStore";

/**
 * Tear down an active live-show session. Stops the engine
 * (clears its tick + health intervals) and evicts the session
 * from the store. Idempotent — calling stop on a missing
 * session returns 200 so the client doesn't have to track
 * whether stop already ran.
 *
 * Body: { sessionId }
 */

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  let body: { sessionId?: unknown };
  try {
    body = (await request.json()) as { sessionId?: unknown };
  } catch {
    console.warn(JSON.stringify({ event: "live.stop.bad-json" }));
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof body.sessionId !== "string") {
    console.warn(JSON.stringify({ event: "live.stop.bad-request", reason: "missing-sessionId" }));
    return NextResponse.json({ error: "sessionId is required." }, { status: 400 });
  }
  destroySession(body.sessionId);
  console.log(JSON.stringify({ event: "live.stop.accepted", sessionId: body.sessionId }));
  return NextResponse.json({ ok: true });
}
