import { NextResponse } from "next/server";
import { getSessionWithRoutingHint } from "@/server/showSessionStore";
import { isVideoFrameSnapshot } from "@/server/visionRequest";

/**
 * Push a captured browser frame into an active live-show session.
 * The engine uses the latest frame on its next vision-observe call.
 *
 * Body: { sessionId, frame: VideoFrameSnapshot }
 *
 * Frames are *best effort*: the show pumps one every 3+ seconds and
 * the engine commentates fine without any specific frame. Under
 * Vercel autoscale the POST may land on a different Function
 * instance than the one running the engine — without a sticky
 * routing layer we can't forward across instances. We acknowledge
 * the request (200) and silently drop the frame instead of returning
 * 404 — a spammy 404 in the console for every dropped frame is
 * worse than a missed frame, and the engine has no actionable
 * recovery for "frame couldn't reach me."
 *
 * Cue / nudge / stop intentionally keep their proper 404/410
 * semantics: those are user-initiated, infrequent, and meaningful.
 */

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  // Happy path is intentionally NOT logged: frames push every ~5s
  // per active session and would dominate the log stream. Only
  // failures + cross-instance misses get a line.
  let body: { sessionId?: unknown; frame?: unknown };
  try {
    body = (await request.json()) as { sessionId?: unknown; frame?: unknown };
  } catch {
    console.warn(JSON.stringify({ event: "live.frame.bad-json" }));
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof body.sessionId !== "string") {
    console.warn(JSON.stringify({ event: "live.frame.bad-request", reason: "missing-sessionId" }));
    return NextResponse.json({ error: "sessionId is required." }, { status: 400 });
  }
  if (!isVideoFrameSnapshot(body.frame)) {
    console.warn(JSON.stringify({ event: "live.frame.bad-request", reason: "invalid-frame", sessionId: body.sessionId }));
    return NextResponse.json({ error: "A valid frame snapshot is required." }, { status: 400 });
  }
  const lookup = await getSessionWithRoutingHint(body.sessionId);
  if (lookup.kind !== "local") {
    // Cross-instance hit (kind: "remote") OR truly-gone session
    // (kind: "missing"). Either way, drop the frame and acknowledge:
    // the engine has no in-band recovery path for an unreachable
    // frame, and converting these to client-visible errors just
    // creates console noise that doesn't help anyone debug.
    console.warn(JSON.stringify({
      event: "live.frame.dropped",
      reason: lookup.kind,
      sessionId: body.sessionId
    }));
    return NextResponse.json({ ok: true, dropped: true, reason: lookup.kind });
  }
  lookup.engine.pushFrame(body.frame);
  return NextResponse.json({ ok: true });
}
