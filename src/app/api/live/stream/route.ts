import {
  getSessionWithRoutingHint,
  lookupErrorResponse,
  markSessionConsumed,
  markSessionDetached
} from "@/server/showSessionStore";

/**
 * SSE event stream for an active live-show session. Pair with
 * `POST /api/live/start` (creates the session) and the companion
 * POST routes (`/api/live/{frame,cue,nudge,stop}`) that push state
 * back into the engine.
 *
 * Single-consumer per session — when this stream's underlying
 * iterator returns (client navigated away or hit /api/live/stop),
 * the session is marked detached and the engine stops a few seconds
 * later if no reattach happens.
 *
 * Lives on Fluid Compute / Node runtime so it can hold the response
 * open for up to ~800s. Past that, the client reconnects (browsers
 * auto-reconnect EventSource on close) and a fresh session is
 * created via /api/live/start.
 */

export const runtime = "nodejs";
// Hobby plan caps Function maxDuration at 300s; Pro/Enterprise can
// extend to 800s. Browsers auto-reconnect EventSource on close, so a
// session that runs past the cap reconnects via /api/live/start with
// a fresh sessionId — degraded but functional.
export const maxDuration = 300;

export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    console.warn(JSON.stringify({ event: "live.stream.bad-request", reason: "missing-sessionId" }));
    return new Response(JSON.stringify({ error: "sessionId is required." }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }
  const lookup = await getSessionWithRoutingHint(sessionId);
  const errorResponse = lookupErrorResponse(lookup, { route: "live.stream", sessionId });
  if (errorResponse) return errorResponse;
  // The helper only returns undefined for the local case; narrow it.
  if (lookup.kind !== "local") {
    return new Response(JSON.stringify({ error: "Session not found or expired." }), {
      status: 404,
      headers: { "content-type": "application/json" }
    });
  }
  const engine = lookup.engine;
  markSessionConsumed(sessionId);
  console.log(JSON.stringify({ event: "live.stream.attached", sessionId, engineId: engine.id }));

  const encoder = new TextEncoder();
  const iterator = engine.events()[Symbol.asyncIterator]();
  let eventCount = 0;
  let lastEventType: string | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // SSE preamble: most browsers + intermediaries are happier with
      // an immediate retry hint + a comment to flush headers.
      controller.enqueue(encoder.encode(`retry: 2000\n\n`));
      try {
        while (true) {
          const { value, done } = await iterator.next();
          if (done) break;
          // Each event becomes one SSE message. The `event:` line
          // lets EventSource consumers route by type via
          // addEventListener(type, …); we also keep `data:` so a
          // generic `onmessage` consumer still works.
          const eventType = (value as { type?: string }).type ?? "message";
          const lines = [
            `event: ${eventType}`,
            `data: ${JSON.stringify(value)}`,
            "",
            ""
          ];
          controller.enqueue(encoder.encode(lines.join("\n")));
          eventCount += 1;
          lastEventType = eventType;
        }
        controller.close();
        console.log(JSON.stringify({
          event: "live.stream.completed",
          sessionId,
          engineId: engine.id,
          eventCount,
          lastEventType,
          durationMs: Date.now() - startedAt
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({
          event: "live.stream.failed",
          sessionId,
          engineId: engine.id,
          eventCount,
          lastEventType,
          durationMs: Date.now() - startedAt,
          error: message
        }));
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`)
        );
        controller.close();
      } finally {
        markSessionDetached(sessionId);
      }
    },
    cancel(reason) {
      // Consumer hung up (browser tab closed, navigated, etc.). Clean
      // up the iterator so the engine queue doesn't keep producers
      // blocked on a phantom consumer.
      void iterator.return?.();
      markSessionDetached(sessionId);
      console.log(JSON.stringify({
        event: "live.stream.cancelled",
        sessionId,
        engineId: engine.id,
        eventCount,
        lastEventType,
        durationMs: Date.now() - startedAt,
        reason: reason instanceof Error ? reason.message : reason ? String(reason) : "client-disconnect"
      }));
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Discourage proxy buffering (nginx, Cloudflare, etc.) which
      // otherwise withholds events until the response closes.
      "X-Accel-Buffering": "no"
    }
  });
}
