import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as startPost } from "../app/api/live/start/route";
import { GET as streamGet } from "../app/api/live/stream/route";
import { POST as cuePost } from "../app/api/live/cue/route";
import { POST as nudgePost } from "../app/api/live/nudge/route";
import { POST as framePost } from "../app/api/live/frame/route";
import { POST as stopPost } from "../app/api/live/stop/route";
import { resetSessionStoreForTests } from "../server/showSessionStore";
import type { ClientServerEvent, ListenerCue, VideoFrameSnapshot } from "../shared/contracts";

/**
 * Integration tests for the SSE-based live show routes
 * (/api/live/{start,stream,frame,cue,nudge,stop}).
 *
 * Drives the same flow the browser EventSource consumer does: POST
 * /start to create a session, GET /stream and read the SSE response,
 * POST /cue to push input back, verify the cue-ack event lands.
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

/**
 * Drains the SSE stream's body up to `maxEvents` events (or up to
 * `timeoutMs`), parses each `event:` + `data:` block back into the
 * native ClientServerEvent shape, and returns the list. Cancels the
 * underlying reader when done so the engine's tick interval doesn't
 * keep the test runner alive.
 */
async function readEvents(
  response: Response,
  options: { maxEvents: number; timeoutMs?: number }
): Promise<ClientServerEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: ClientServerEvent[] = [];
  const deadline = Date.now() + (options.timeoutMs ?? 8000);

  try {
    while (events.length < options.maxEvents && Date.now() < deadline) {
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
          events.push(JSON.parse(dataLine.slice("data:".length).trim()) as ClientServerEvent);
        } catch {
          // Drop unparseable blocks (the `retry:` preamble, comments).
        }
      }
    }
  } finally {
    await reader.cancel();
  }
  return events;
}

describe("POST /api/live/start", () => {
  it("returns a sessionId for a valid LivecastRequest", async () => {
    const response = await startPost(
      jsonRequest("http://test.local/api/live/start", validRequestBody)
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { sessionId: string };
    expect(payload.sessionId).toMatch(/^[0-9a-f-]{36}$|^sess-/);
  });

  it("rejects a request whose body is not JSON", async () => {
    const response = await startPost(
      new Request("http://test.local/api/live/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json"
      })
    );
    expect(response.status).toBe(400);
  });

  it("rejects a LivecastRequest that fails schema validation (missing friends)", async () => {
    const response = await startPost(
      jsonRequest("http://test.local/api/live/start", {
        ...validRequestBody,
        group: { ...validRequestBody.group, friends: [] }
      })
    );
    expect(response.status).toBe(400);
  });
});

describe("GET /api/live/stream", () => {
  it("rejects a request without sessionId", async () => {
    const response = await streamGet(new Request("http://test.local/api/live/stream"));
    expect(response.status).toBe(400);
  });

  it("returns 404 when the sessionId doesn't match an active session", async () => {
    const response = await streamGet(
      new Request("http://test.local/api/live/stream?sessionId=does-not-exist")
    );
    expect(response.status).toBe(404);
  });

  it("streams the snapshot + opener commentary as SSE events for a real session", async () => {
    const startRes = await startPost(jsonRequest("http://test.local/api/live/start", validRequestBody));
    const { sessionId } = (await startRes.json()) as { sessionId: string };

    const streamRes = await streamGet(
      new Request(`http://test.local/api/live/stream?sessionId=${sessionId}`)
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("Content-Type")).toContain("text/event-stream");
    const events = await readEvents(streamRes, { maxEvents: 2, timeoutMs: 8000 });

    // The first event should be the snapshot (fantasy + game + health + providers).
    expect(events[0]?.type).toBe("snapshot");
    // The second event is the opener commentary turn.
    expect(events[1]?.type).toBe("commentary");
  });
});

describe("POST /api/live/cue", () => {
  it("queues a cue and the next commentary turn carries a cue-ack", async () => {
    const startRes = await startPost(jsonRequest("http://test.local/api/live/start", validRequestBody));
    const { sessionId } = (await startRes.json()) as { sessionId: string };

    const streamRes = await streamGet(
      new Request(`http://test.local/api/live/stream?sessionId=${sessionId}`)
    );
    expect(streamRes.status).toBe(200);

    // Fire the cue right away. The engine drains pending cues on its
    // next commentary tick, so the ack should land within a few events.
    const cue: ListenerCue = {
      id: "test-cue-1",
      text: "What's happening with Mahomes?",
      capturedAt: new Date().toISOString()
    };
    const cueRes = await cuePost(jsonRequest("http://test.local/api/live/cue", { sessionId, cue }));
    expect(cueRes.status).toBe(200);

    const events = await readEvents(streamRes, { maxEvents: 8, timeoutMs: 12000 });
    const ack = events.find(
      (e): e is Extract<ClientServerEvent, { type: "cue-ack" }> => e.type === "cue-ack"
    );
    expect(ack).toBeDefined();
    expect(ack!.cueIds).toContain("test-cue-1");
  });

  it("rejects a cue with empty text (would create a phantom commentary turn)", async () => {
    const startRes = await startPost(jsonRequest("http://test.local/api/live/start", validRequestBody));
    const { sessionId } = (await startRes.json()) as { sessionId: string };
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
    const startRes = await startPost(jsonRequest("http://test.local/api/live/start", validRequestBody));
    const { sessionId } = (await startRes.json()) as { sessionId: string };
    const res = await nudgePost(jsonRequest("http://test.local/api/live/nudge", { sessionId, hostId: "cam" }));
    expect(res.status).toBe(200);
  });

  it("rejects a nudge with an unknown hostId", async () => {
    const startRes = await startPost(jsonRequest("http://test.local/api/live/start", validRequestBody));
    const { sessionId } = (await startRes.json()) as { sessionId: string };
    const res = await nudgePost(
      jsonRequest("http://test.local/api/live/nudge", { sessionId, hostId: "rogue" })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/live/frame", () => {
  it("accepts a frame snapshot for an active session", async () => {
    const startRes = await startPost(jsonRequest("http://test.local/api/live/start", validRequestBody));
    const { sessionId } = (await startRes.json()) as { sessionId: string };
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
    const startRes = await startPost(jsonRequest("http://test.local/api/live/start", validRequestBody));
    const { sessionId } = (await startRes.json()) as { sessionId: string };
    const res = await framePost(
      jsonRequest("http://test.local/api/live/frame", { sessionId, frame: { width: 1, height: 1 } })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/live/stop", () => {
  it("evicts a session and is idempotent on repeat calls", async () => {
    const startRes = await startPost(jsonRequest("http://test.local/api/live/start", validRequestBody));
    const { sessionId } = (await startRes.json()) as { sessionId: string };

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
