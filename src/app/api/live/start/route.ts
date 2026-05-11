import { NextResponse } from "next/server";
import { ShowEngine } from "@/server/showEngine";
import { registerSession } from "@/server/showSessionStore";
import { parseLivecastRequest } from "@/server/app";

/**
 * Create a new live-show session. Pair with `GET /api/live/stream`
 * which attaches the SSE consumer.
 *
 * The server eagerly starts the engine here so the opener and first
 * tick can begin computing in parallel with the client's SSE
 * connection. Events buffer in the engine's AsyncEventQueue until
 * the GET attaches and drains.
 *
 * Sessions self-expire if no SSE consumer attaches within ~30s.
 *
 * Body: a LivecastRequest (same shape Fastify's WS protocol used).
 * Response: { sessionId }
 */

export const runtime = "nodejs";
// Match the SSE endpoint's potential lifetime so a long opener that
// runs before the first event push still completes if the client
// happens to be slow to GET.
export const maxDuration = 60;

export async function POST(request: Request) {
  let raw: string;
  try {
    raw = JSON.stringify(await request.json());
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = parseLivecastRequest(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.message }, { status: 400 });
  }
  const engine = new ShowEngine({
    logger: {
      info: (obj, msg) => console.log(JSON.stringify({ event: "live.engine.info", ...flatten(obj), msg })),
      warn: (obj, msg) => console.warn(JSON.stringify({ event: "live.engine.warn", ...flatten(obj), msg })),
      error: (obj, msg) => console.error(JSON.stringify({ event: "live.engine.error", ...flatten(obj), msg }))
    }
  });
  // Fire and forget — events will buffer in the queue. The SSE GET
  // drains them as soon as it attaches.
  void engine.start(parsed.request);
  const sessionId = registerSession(engine);
  return NextResponse.json({ sessionId });
}

// Pino expects a single object as the first arg; our routes accept
// either an object or a primitive. Flatten so the JSON line stays
// loggable either way.
function flatten(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return { detail: obj };
  return obj as Record<string, unknown>;
}
