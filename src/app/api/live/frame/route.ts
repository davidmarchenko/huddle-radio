import { NextResponse } from "next/server";
import { getSession } from "@/server/showSessionStore";
import { isVideoFrameSnapshot } from "@/server/visionRequest";

/**
 * Push a captured browser frame into an active live-show session.
 * The engine uses the latest frame on its next vision-observe call.
 *
 * Body: { sessionId, frame: VideoFrameSnapshot }
 */

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  // Happy path is intentionally NOT logged: frames push every ~5s
  // per active session and would dominate the log stream. Only
  // failures and missing sessions get a line.
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
  const engine = getSession(body.sessionId);
  if (!engine) {
    console.warn(JSON.stringify({ event: "live.frame.no-session", sessionId: body.sessionId }));
    return NextResponse.json({ error: "Session not found or expired." }, { status: 404 });
  }
  engine.pushFrame(body.frame);
  return NextResponse.json({ ok: true });
}
