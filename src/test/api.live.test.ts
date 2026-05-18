import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as streamPost } from "../app/api/live/stream/route";
import { POST as cuePost } from "../app/api/live/cue/route";
import { POST as nudgePost } from "../app/api/live/nudge/route";
import { POST as framePost } from "../app/api/live/frame/route";
import { POST as stopPost } from "../app/api/live/stop/route";
import { resetSessionStoreForTests } from "../server/showSessionStore";
import type { ClientServerEvent, ListenerCue, VideoFrameSnapshot } from "../shared/contracts";

/**
 * Integration tests for the live show routes
 * (/api/live/{stream,frame,cue,nudge,stop}).
 *
 * Drives the same flow the browser fetch-streaming consumer does:
 * POST /stream with a LivecastRequest body, read the SSE response,
 * extract the sessionId from the `session-ready` handshake event,
 * then POST /cue (etc.) with that sessionId.
 *
 * Tests run in mock-provider mode (NODE_ENV=test) so the engine
 * boots without external dependencies. Cadence is set to the
 * minimum (3000 ms) but we drain only the opener + first tick to
 * keep test runtime under a few seconds.
 */

const validRequestBody = {
  providerMode: "demo" as const,
  sportsDataMode: "demo" as const,
  sportsGameId: "demo-kc-det",
  group: {
    listener: { name: "Alex", rosterId: "roster-alex" },
    tone: "pg" as const,
    homeTeamBias: "fantasy-first" as const,
    friends: [{ id: "f1", name: "Sam", favoriteTeam: "DET" }]
  },
  video: { mode: "stream-url" as const, url: "" },
  ttsEnabled: false,
  cadenceMs: 3000
};

beforeEach(() => {
  resetSessionStoreForTests();
});

afterEach(() => {
  resetSessionStoreForTests();
});

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

type StreamEvent = { type?: string; sessionId?: string; [k: string]: unknown };

type ResponseDrainer = {
  /** Read up to `maxEvents` more events. Continues where the previous call left off. */
  next(maxEvents: number, timeoutMs?: number): Promise<StreamEvent[]>;
  /** Cancel the underlying stream so the engine's tick interval doesn't keep the test runner alive. */
  close(): Promise<void>;
};

/**
 * Build a stateful drainer over an SSE response. Each call to
 * `next()` continues where the previous one left off, so a test can
 * read the `session-ready` handshake first and then keep draining
 * the engine's events without re-locking the stream.
 */
function drainerFor(response: Response): ResponseDrainer {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;

  return {
    async next(maxEvents, timeoutMs = 8000) {
      const events: StreamEvent[] = [];
      const deadline = Date.now() + timeoutMs;
      while (events.length < maxEvents && Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value?: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ done: true }), Math.max(50, deadline - Date.now()))
          )
        ]);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (!block.trim()) continue;
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          try {
            events.push(JSON.parse(dataLine.slice("data:".length).trim()) as StreamEvent);
          } catch {
            // Drop unparseable blocks (the `retry:` preamble, comments).
          }
        }
      }
      return events;
    },
    async close() {
      if (closed) return;
      closed = true;
      await reader.cancel();
    }
  };
}

/** Open a live stream and pull the `session-ready` handshake. Returns the drainer so the caller can keep reading events. */
async function openStreamForSession(body: unknown = validRequestBody): Promise<{ sessionId: string; drainer: ResponseDrainer }> {
  const response = await streamPost(jsonRequest("http://test.local/api/live/stream", body));
  if (response.status !== 200) {
    throw new Error(`Expected 200 from /api/live/stream, got ${response.status}`);
  }
  const drainer = drainerFor(response);
  const events = await drainer.next(1, 4000);
  const sessionEvent = events.find((e) => e.type === "session-ready");
  if (!sessionEvent || typeof sessionEvent.sessionId !== "string") {
    throw new Error("Stream did not emit session-ready handshake.");
  }
  return { sessionId: sessionEvent.sessionId, drainer };
}

describe("POST /api/live/stream", () => {
  it("rejects a request whose body is not JSON", async () => {
    const response = await streamPost(
      new Request("http://test.local/api/live/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json"
      })
    );
    expect(response.status).toBe(400);
  });

  it("rejects a LivecastRequest that fails schema validation (malformed friend)", async () => {
    // Empty `friends` and `listener.name` are valid by design — non-demo
    // casts where the user has no fantasy profile send neutral
    // placeholders, and sanitizeCommentaryGroup strips them on the
    // client. So the negative case is a friend object that's missing
    // its required fields (id/name/favoriteTeam are still `.min(1)`).
    const response = await streamPost(
      jsonRequest("http://test.local/api/live/stream", {
        ...validRequestBody,
        group: { ...validRequestBody.group, friends: [{ id: "" }] }
      })
    );
    expect(response.status).toBe(400);
  });

  it("emits session-ready as the first SSE event with a fresh sessionId", async () => {
    const response = await streamPost(jsonRequest("http://test.local/api/live/stream", validRequestBody));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const drainer = drainerFor(response);
    const events = await drainer.next(1, 4000);
    expect(events[0]?.type).toBe("session-ready");
    expect(events[0]?.sessionId).toMatch(/^[0-9a-f-]{36}$|^sess-/);
    await drainer.close();
  });

  it("streams the snapshot + opener commentary after the handshake", async () => {
    const response = await streamPost(jsonRequest("http://test.local/api/live/stream", validRequestBody));
    expect(response.status).toBe(200);
    const drainer = drainerFor(response);
    // Drain enough to cover the session-ready, snapshot, the
    // placeholder observation (lets NemotronSeesPanel mount as
    // "warming up" before the first real vision frame), and the
    // opener commentary turn.
    const events = await drainer.next(4, 8000);
    expect(events[0]?.type).toBe("session-ready");
    // The snapshot (fantasy + game + health + providers).
    expect(events[1]?.type).toBe("snapshot");
    // Order of the next two is engine-internal — assert presence
    // rather than position so a future reordering doesn't break us.
    const types = events.slice(2).map((e) => e?.type);
    expect(types).toContain("observation");
    expect(types).toContain("commentary");
    await drainer.close();
  });
});

describe("POST /api/live/cue", () => {
  it("queues a cue and the next commentary turn carries a cue-ack", async () => {
    const { sessionId, drainer } = await openStreamForSession();

    // Fire the cue right away. The engine drains pending cues on its
    // next commentary tick, so the ack should land within a few events.
    const cue: ListenerCue = {
      id: "test-cue-1",
      text: "What's happening with Mahomes?",
      capturedAt: new Date().toISOString()
    };
    const cueRes = await cuePost(jsonRequest("http://test.local/api/live/cue", { sessionId, cue }));
    expect(cueRes.status).toBe(200);

    const events = (await drainer.next(8, 12000)) as ClientServerEvent[];
    const ack = events.find(
      (e): e is Extract<ClientServerEvent, { type: "cue-ack" }> => e.type === "cue-ack"
    );
    expect(ack).toBeDefined();
    expect(ack!.cueIds).toContain("test-cue-1");
    await drainer.close();
  });

  it("rejects a cue with empty text (would create a phantom commentary turn)", async () => {
    const { sessionId } = await openStreamForSession();
    const cueRes = await cuePost(
      jsonRequest("http://test.local/api/live/cue", {
        sessionId,
        cue: { id: "x", text: "   ", capturedAt: new Date().toISOString() }
      })
    );
    expect(cueRes.status).toBe(400);
  });

  it("rejects a cue against an unknown session", async () => {
    const cueRes = await cuePost(
      jsonRequest("http://test.local/api/live/cue", {
        sessionId: "does-not-exist",
        cue: { id: "x", text: "hi", capturedAt: new Date().toISOString() }
      })
    );
    expect(cueRes.status).toBe(404);
  });
});

describe("POST /api/live/nudge", () => {
  it("accepts a nudge for a valid host", async () => {
    const { sessionId } = await openStreamForSession();
    const res = await nudgePost(jsonRequest("http://test.local/api/live/nudge", { sessionId, hostId: "cam" }));
    expect(res.status).toBe(200);
  });

  it("rejects a nudge with an unknown hostId", async () => {
    const { sessionId } = await openStreamForSession();
    const res = await nudgePost(
      jsonRequest("http://test.local/api/live/nudge", { sessionId, hostId: "rogue" })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/live/frame", () => {
  it("accepts a frame snapshot for an active session", async () => {
    const { sessionId } = await openStreamForSession();
    const frame: VideoFrameSnapshot = {
      id: "f1",
      capturedAt: new Date().toISOString(),
      source: "screen-share",
      width: 640,
      height: 360,
      dataUrl: "data:image/jpeg;base64,QUJD"
    };
    const res = await framePost(jsonRequest("http://test.local/api/live/frame", { sessionId, frame }));
    expect(res.status).toBe(200);
  });

  it("rejects a frame snapshot missing required fields", async () => {
    const { sessionId } = await openStreamForSession();
    const res = await framePost(
      jsonRequest("http://test.local/api/live/frame", { sessionId, frame: { width: 1, height: 1 } })
    );
    expect(res.status).toBe(400);
  });

  it("acknowledges (200) a frame against an unknown session instead of 404", async () => {
    // Frames are best-effort: under Vercel autoscale a frame POST may
    // land on a different Function instance than the engine. We drop
    // silently rather than spam the console with a 404 for every
    // dropped frame.
    const frame: VideoFrameSnapshot = {
      id: "f1",
      capturedAt: new Date().toISOString(),
      source: "screen-share",
      width: 640,
      height: 360,
      dataUrl: "data:image/jpeg;base64,QUJD"
    };
    const res = await framePost(
      jsonRequest("http://test.local/api/live/frame", { sessionId: "does-not-exist", frame })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; dropped?: boolean; reason?: string };
    expect(body.ok).toBe(true);
    expect(body.dropped).toBe(true);
    expect(body.reason).toBe("missing");
  });
});

describe("POST /api/live/stop", () => {
  it("evicts a session and is idempotent on repeat calls", async () => {
    const { sessionId } = await openStreamForSession();

    const first = await stopPost(jsonRequest("http://test.local/api/live/stop", { sessionId }));
    expect(first.status).toBe(200);
    // Repeat call: the session is already gone but the route still
    // returns 200 so the client doesn't have to track stop state.
    const second = await stopPost(jsonRequest("http://test.local/api/live/stop", { sessionId }));
    expect(second.status).toBe(200);

    // The session is now gone — frame/cue/nudge should report 404.
    const cueRes = await cuePost(
      jsonRequest("http://test.local/api/live/cue", {
        sessionId,
        cue: { id: "x", text: "hi", capturedAt: new Date().toISOString() }
      })
    );
    expect(cueRes.status).toBe(404);
  });
});
