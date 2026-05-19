import { NextResponse } from "next/server";
import { getSessionWithRoutingHint, lookupErrorResponse } from "@/server/showSessionStore";

/**
 * Listener pause / resume. Body: { sessionId, paused: boolean }.
 *
 * Flips a flag on the engine so subsequent ticks short-circuit before
 * any LLM call or TTS generation. The SSE connection stays open —
 * resume re-engages the existing engine instance (state preserved:
 * rapport, claims, arc, eval ring, recentCommentary). Without this,
 * the client's `togglePause` only paused the local audio element
 * while the server kept burning OpenAI tokens + ElevenLabs / Inworld
 * voice credits + piling unheard audio chunks into the client queue.
 */

export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    let body: { sessionId?: unknown; paused?: unknown };
    try {
      body = (await request.json()) as { sessionId?: unknown; paused?: unknown };
    } catch {
      console.warn(JSON.stringify({ event: "live.pause.bad-json" }));
      return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
    }
    if (typeof body.sessionId !== "string") {
      console.warn(JSON.stringify({ event: "live.pause.bad-request", reason: "missing-sessionId" }));
      return NextResponse.json({ error: "sessionId is required." }, { status: 400 });
    }
    if (typeof body.paused !== "boolean") {
      console.warn(JSON.stringify({ event: "live.pause.bad-request", reason: "missing-paused", sessionId: body.sessionId }));
      return NextResponse.json({ error: "paused (boolean) is required." }, { status: 400 });
    }
    const lookup = await getSessionWithRoutingHint(body.sessionId);
    const errorResponse = lookupErrorResponse(lookup, { route: "live.pause", sessionId: body.sessionId });
    if (errorResponse) return errorResponse;
    const engine = lookup.kind === "local" ? lookup.engine : undefined;
    if (!engine) {
      console.warn(JSON.stringify({ event: "live.pause.session-not-found", sessionId: body.sessionId }));
      return NextResponse.json({ error: "Session not found or expired." }, { status: 404 });
    }
    engine.setPaused(body.paused);
    console.log(JSON.stringify({
      event: "live.pause.accepted",
      sessionId: body.sessionId,
      paused: body.paused,
      durationMs: Date.now() - startedAt
    }));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(JSON.stringify({
      event: "live.pause.error",
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt
    }));
    return NextResponse.json({ error: "Internal error." }, { status: 500 });
  }
}
