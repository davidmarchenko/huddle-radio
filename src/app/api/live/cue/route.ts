import { NextResponse } from "next/server";
import { getSessionWithRoutingHint, lookupErrorResponse } from "@/server/showSessionStore";
import type { ListenerCue } from "@/shared/contracts";

/**
 * Push a push-to-talk listener cue (W18) into an active live-show
 * session. The engine drains pending cues on its next commentary
 * tick and folds them into the persona prompt.
 *
 * Body: { sessionId, cue: ListenerCue }
 */

export const runtime = "nodejs";
export const maxDuration = 30;

function isListenerCue(value: unknown): value is ListenerCue {
  if (!value || typeof value !== "object") return false;
  const cue = value as Partial<ListenerCue>;
  return Boolean(
    cue.id &&
    cue.capturedAt &&
    typeof cue.text === "string" &&
    cue.text.trim().length > 0 &&
    cue.text.length <= 600
  );
}

export async function POST(request: Request) {
  let body: { sessionId?: unknown; cue?: unknown };
  try {
    body = (await request.json()) as { sessionId?: unknown; cue?: unknown };
  } catch {
    console.warn(JSON.stringify({ event: "live.cue.bad-json" }));
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof body.sessionId !== "string") {
    console.warn(JSON.stringify({ event: "live.cue.bad-request", reason: "missing-sessionId" }));
    return NextResponse.json({ error: "sessionId is required." }, { status: 400 });
  }
  if (!isListenerCue(body.cue)) {
    console.warn(JSON.stringify({ event: "live.cue.bad-request", reason: "invalid-cue", sessionId: body.sessionId }));
    return NextResponse.json({ error: "A valid listener cue is required." }, { status: 400 });
  }
  const lookup = await getSessionWithRoutingHint(body.sessionId);
  const errorResponse = lookupErrorResponse(lookup, { route: "live.cue", sessionId: body.sessionId });
  if (errorResponse) return errorResponse;
  // Type-narrow: the helper only returns undefined for `local`.
  const engine = lookup.kind === "local" ? lookup.engine : undefined;
  if (!engine) return NextResponse.json({ error: "Session not found or expired." }, { status: 404 });
  engine.pushCue(body.cue);
  console.log(JSON.stringify({
    event: "live.cue.accepted",
    sessionId: body.sessionId,
    cueId: body.cue.id,
    chars: body.cue.text.length
  }));
  return NextResponse.json({ ok: true });
}
