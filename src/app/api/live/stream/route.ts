import {
  markSessionConsumed,
  markSessionDetached,
  registerSession
} from "@/server/showSessionStore";
import { ShowEngine } from "@/server/showEngine";
import { parseLivecastRequest } from "@/server/app";

/**
 * Live-show SSE endpoint. POSTs the LivecastRequest as the body; the
 * engine is created on whichever Function instance answers this request
 * and streams its events back over the same connection. The pair-style
 * `POST /api/live/start` + `GET /api/live/stream?sessionId=...` was
 * removed: under Vercel autoscale, the start instance and the stream
 * instance could diverge, leaving the SSE GET with nothing to attach to
 * (in-memory session map). Colocating engine + stream eliminates the
 * cross-instance failure entirely — no shared store needed for the
 * happy path; companion POSTs (cue/frame/nudge/stop) still use the
 * registry for cross-instance hint detection (returns 410, client
 * reconnects via startLiveSession).
 *
 * Handshake:
 *   - First event over the stream is `{type:"session-ready", sessionId}`.
 *     The client uses that sessionId for the companion POSTs.
 *
 * Lives on Fluid Compute / Node runtime so it can hold the response
 * open for up to ~800s. Past that, the client reconnects via
 * startLiveSession (a fresh POST + new engine on whichever instance
 * answers).
 */

export const runtime = "nodejs";
// Hobby plan caps Function maxDuration at 300s; Pro/Enterprise can
// extend to 800s. The client reconnects by POSTing again with a fresh
// engine — degraded but functional.
export const maxDuration = 300;

export async function POST(request: Request) {
  const startedAt = Date.now();
  let raw: string;
  try {
    raw = JSON.stringify(await request.json());
  } catch {
    return new Response(JSON.stringify({ error: "Body must be JSON." }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }
  const parsed = parseLivecastRequest(raw);
  if (!parsed.ok) {
    return new Response(JSON.stringify({ error: parsed.message }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  const engine = new ShowEngine({
    logger: {
      info: (obj, msg) => console.log(JSON.stringify({ event: "live.engine.info", ...flatten(obj), msg })),
      warn: (obj, msg) => console.warn(JSON.stringify({ event: "live.engine.warn", ...flatten(obj), msg })),
      error: (obj, msg) => console.error(JSON.stringify({ event: "live.engine.error", ...flatten(obj), msg }))
    }
  });
  // Fire and forget — events buffer in the engine's AsyncEventQueue
  // and drain into the SSE stream below.
  void engine.start(parsed.request);
  const sessionId = await registerSession(engine);
  // The SSE consumer is attached by definition — we're streaming into it
  // on the same request. Skip the ATTACH_GRACE_MS reaper.
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
      // Handshake event: tells the client which sessionId to use for
      // companion POSTs (cue/frame/nudge/stop).
      const handshake = { type: "session-ready", sessionId };
      controller.enqueue(
        encoder.encode(`event: session-ready\ndata: ${JSON.stringify(handshake)}\n\n`)
      );
      try {
        while (true) {
          const { value, done } = await iterator.next();
          if (done) break;
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
      // Consumer hung up (browser tab closed, navigated, abort signal).
      // Stop the iterator so the engine queue doesn't keep producers
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

// Pino expects a single object as the first arg; our routes accept
// either an object or a primitive. Flatten so the JSON line stays
// loggable either way.
function flatten(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return { detail: obj };
  return obj as Record<string, unknown>;
}
