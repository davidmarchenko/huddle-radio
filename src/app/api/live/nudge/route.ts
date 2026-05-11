import { NextResponse } from "next/server";
import { getSessionWithRoutingHint, lookupErrorResponse } from "@/server/showSessionStore";
import type { HostId } from "@/shared/contracts";

/**
 * Force the next commentary turn onto a specific host (Maya / Theo /
 * Cam). One-shot: the engine consumes the nudge on the next tick,
 * then resumes its deterministic selectHost rotation.
 *
 * Body: { sessionId, hostId: "maya" | "theo" | "cam" }
 */

export const runtime = "nodejs";
export const maxDuration = 30;

const VALID_HOST_IDS: HostId[] = ["maya", "theo", "cam"];

export async function POST(request: Request) {
  let body: { sessionId?: unknown; hostId?: unknown };
  try {
    body = (await request.json()) as { sessionId?: unknown; hostId?: unknown };
  } catch {
    console.warn(JSON.stringify({ event: "live.nudge.bad-json" }));
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof body.sessionId !== "string") {
    console.warn(JSON.stringify({ event: "live.nudge.bad-request", reason: "missing-sessionId" }));
    return NextResponse.json({ error: "sessionId is required." }, { status: 400 });
  }
  if (!VALID_HOST_IDS.includes(body.hostId as HostId)) {
    console.warn(JSON.stringify({ event: "live.nudge.bad-request", reason: "invalid-hostId", sessionId: body.sessionId }));
    return NextResponse.json({ error: "hostId must be one of maya | theo | cam." }, { status: 400 });
  }
  const lookup = await getSessionWithRoutingHint(body.sessionId);
  const errorResponse = lookupErrorResponse(lookup, { route: "live.nudge", sessionId: body.sessionId });
  if (errorResponse) return errorResponse;
  const engine = lookup.kind === "local" ? lookup.engine : undefined;
  if (!engine) return NextResponse.json({ error: "Session not found or expired." }, { status: 404 });
  engine.pushNudge(body.hostId as HostId);
  console.log(JSON.stringify({
    event: "live.nudge.accepted",
    sessionId: body.sessionId,
    hostId: body.hostId
  }));
  return NextResponse.json({ ok: true });
}
