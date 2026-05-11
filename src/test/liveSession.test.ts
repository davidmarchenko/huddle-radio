import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeSession,
  sendCue,
  sendFrame,
  sendNudge,
  startLiveSession
} from "../client/liveSession";
import type { ClientServerEvent, ListenerCue, LivecastRequest, VideoFrameSnapshot } from "../shared/contracts";

/**
 * Tests for the client-side fetch-streaming transport (liveSession.ts).
 *
 * We stub `fetch` with a controllable fake. The stream-streaming
 * variant returns a Response whose body is a custom ReadableStream
 * the test can push SSE-formatted chunks into; the companion POSTs
 * (cue/frame/nudge/stop) just return ad-hoc JSON responses. AbortController
 * is supported natively in Node so we don't stub it.
 *
 * The server's first SSE event must be `session-ready` with the
 * sessionId — startLiveSession resolves only after this handshake.
 */

const baseRequest: LivecastRequest = {
  providerMode: "demo",
  sportsDataMode: "demo",
  sportsGameId: "demo-kc-det",
  group: {
    listener: { name: "Alex", rosterId: "roster-alex" },
    tone: "pg",
    homeTeamBias: "fantasy-first",
    friends: [{ id: "f1", name: "Sam", favoriteTeam: "DET" }]
  },
  video: { mode: "stream-url", url: "" },
  ttsEnabled: false,
  cadenceMs: 5000
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Builds a fake stream-handler. Returns:
 *  - `fetchSpy`: the vi.fn that gets installed as global.fetch
 *  - `controller`: lets the test push events / close the stream / reject reads
 *
 * The `/api/live/stream` POST returns a streaming Response; every
 * other URL returns `{ok: true}` 200 by default (override with `companionStatus`).
 */
function installFetchStream(options: {
  sessionId: string;
  /** Override the response status of the streaming endpoint. Defaults to 200. */
  streamStatus?: number;
  /** Override the body returned with a non-200 stream response. */
  streamErrorBody?: unknown;
  /** Override the response status companion POSTs return. Defaults to 200. */
  companionStatus?: number;
  /** Override the body companion POSTs return. */
  companionBody?: unknown;
}) {
  let pushChunk: ((chunk: Uint8Array) => void) | null = null;
  let closeStream: (() => void) | null = null;
  let cancelled = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      pushChunk = (chunk) => controller.enqueue(chunk);
      closeStream = () => controller.close();
    },
    cancel() {
      cancelled = true;
    }
  });

  const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/live/stream") && (init?.method ?? "GET").toUpperCase() === "POST") {
      if ((options.streamStatus ?? 200) !== 200) {
        return new Response(JSON.stringify(options.streamErrorBody ?? { error: "bad" }), {
          status: options.streamStatus,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    return new Response(JSON.stringify(options.companionBody ?? { ok: true }), {
      status: options.companionStatus ?? 200,
      headers: { "content-type": "application/json" }
    });
  });
  vi.stubGlobal("fetch", fetchSpy);

  const writeSseEvent = (type: string, data: unknown) => {
    pushChunk?.(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  const writeHandshake = () => {
    writeSseEvent("session-ready", { type: "session-ready", sessionId: options.sessionId });
  };

  return {
    fetchSpy,
    writeSseEvent,
    writeHandshake,
    closeStream: () => closeStream?.(),
    isCancelled: () => cancelled
  };
}

describe("startLiveSession", () => {
  it("POSTs the LivecastRequest to /api/live/stream and resolves the handle once session-ready arrives", async () => {
    const fake = installFetchStream({ sessionId: "session-abc" });
    const sessionPromise = startLiveSession(baseRequest, { onEvent: () => undefined });
    // Server hasn't emitted handshake yet — promise is still pending.
    fake.writeHandshake();
    const handle = await sessionPromise;
    expect(handle).toBeDefined();
    expect(handle!.sessionId).toBe("session-abc");
    // The POST included the request body with the providerMode field.
    const streamCall = fake.fetchSpy.mock.calls.find((c) => String(c[0]).endsWith("/api/live/stream"));
    expect(streamCall).toBeDefined();
    const init = streamCall![1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({ providerMode: "demo" });
  });

  it("fires onOpen once the handshake lands", async () => {
    const fake = installFetchStream({ sessionId: "session-1" });
    const onOpen = vi.fn();
    const sessionPromise = startLiveSession(baseRequest, { onEvent: () => undefined, onOpen });
    fake.writeHandshake();
    const handle = await sessionPromise;
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(handle!.isOpen()).toBe(true);
  });

  it("dispatches typed SSE events through onEvent in JSON-parsed form", async () => {
    const fake = installFetchStream({ sessionId: "session-2" });
    const events: ClientServerEvent[] = [];
    const sessionPromise = startLiveSession(baseRequest, { onEvent: (e) => events.push(e) });
    fake.writeHandshake();
    await sessionPromise;
    fake.writeSseEvent("commentary", {
      type: "commentary",
      commentary: { id: "c1", text: "hello" }
    });
    fake.writeSseEvent("market-swing", {
      type: "market-swing",
      source: "kalshi",
      externalId: "k1",
      title: "X",
      outcome: "Yes",
      fromCents: 50,
      toCents: 60,
      deltaCents: 10,
      direction: "warming"
    });
    // The drain loop is async; wait a tick for the events to land in onEvent.
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("commentary");
    expect(events[1]?.type).toBe("market-swing");
  });

  it("calls onError when /api/live/stream returns a non-2xx with a JSON error body", async () => {
    installFetchStream({
      sessionId: "n/a",
      streamStatus: 400,
      streamErrorBody: { error: "bad request" }
    });
    const onError = vi.fn();
    const handle = await startLiveSession(baseRequest, { onEvent: () => undefined, onError });
    expect(handle).toBeUndefined();
    expect(onError).toHaveBeenCalledWith("bad request");
  });

  it("calls onError when fetch itself rejects (network failure before the server responds)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const onError = vi.fn();
    const handle = await startLiveSession(baseRequest, { onEvent: () => undefined, onError });
    expect(handle).toBeUndefined();
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toMatch(/network down/);
  });

  it("calls onError when the stream closes before the handshake event arrives", async () => {
    const fake = installFetchStream({ sessionId: "n/a" });
    const onError = vi.fn();
    const sessionPromise = startLiveSession(baseRequest, { onEvent: () => undefined, onError });
    // Close the stream without writing the handshake first.
    fake.closeStream();
    const handle = await sessionPromise;
    expect(handle).toBeUndefined();
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toMatch(/session handshake/i);
  });
});

describe("sendFrame / sendCue / sendNudge", () => {
  async function openSession(sessionId: string) {
    const fake = installFetchStream({ sessionId });
    const sessionPromise = startLiveSession(baseRequest, { onEvent: () => undefined });
    fake.writeHandshake();
    const handle = await sessionPromise;
    return { fake, handle: handle! };
  }

  it("sendFrame POSTs to /api/live/frame with sessionId + frame", async () => {
    const { fake, handle } = await openSession("session-f");
    fake.fetchSpy.mockClear();
    const frame: VideoFrameSnapshot = {
      id: "f1",
      capturedAt: "2026-05-10T20:00:00Z",
      source: "screen-share",
      width: 640,
      height: 360,
      dataUrl: "data:image/jpeg;base64,QUJD"
    };
    await sendFrame(handle, frame);
    const call = fake.fetchSpy.mock.calls[0];
    expect(String(call[0])).toBe("/api/live/frame");
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).toMatchObject({ sessionId: "session-f", frame: { id: "f1" } });
  });

  it("sendCue POSTs to /api/live/cue and returns true on 2xx", async () => {
    const { fake, handle } = await openSession("session-c");
    fake.fetchSpy.mockClear();
    const cue: ListenerCue = { id: "cue-1", text: "hi", capturedAt: new Date().toISOString() };
    const ok = await sendCue(handle, cue);
    expect(ok).toBe(true);
    expect(String(fake.fetchSpy.mock.calls[0][0])).toBe("/api/live/cue");
  });

  it("sendCue returns false when the server rejects (4xx/5xx)", async () => {
    const fake = installFetchStream({
      sessionId: "session-c2",
      companionStatus: 404,
      companionBody: { error: "no" }
    });
    const sessionPromise = startLiveSession(baseRequest, { onEvent: () => undefined });
    fake.writeHandshake();
    const handle = await sessionPromise;
    const ok = await sendCue(handle!, {
      id: "cue-1",
      text: "hi",
      capturedAt: new Date().toISOString()
    });
    expect(ok).toBe(false);
  });

  it("sendNudge POSTs to /api/live/nudge with the hostId", async () => {
    const { fake, handle } = await openSession("session-n");
    fake.fetchSpy.mockClear();
    await sendNudge(handle, "cam");
    const call = fake.fetchSpy.mock.calls[0];
    expect(String(call[0])).toBe("/api/live/nudge");
    expect(JSON.parse(String((call[1] as RequestInit).body))).toMatchObject({
      sessionId: "session-n",
      hostId: "cam"
    });
  });
});

describe("onSessionLost (cross-instance 410)", () => {
  it("fires when a POST returns 410 — once, even across multiple failed POSTs", async () => {
    const fake = installFetchStream({
      sessionId: "session-410",
      companionStatus: 410,
      companionBody: { code: "WRONG_INSTANCE", error: "Session lives elsewhere" }
    });
    const onSessionLost = vi.fn();
    const sessionPromise = startLiveSession(baseRequest, {
      onEvent: () => undefined,
      onSessionLost
    });
    fake.writeHandshake();
    const handle = await sessionPromise;
    expect(handle).toBeDefined();
    // Three POSTs in quick succession — all return 410. The callback
    // is latched so only the FIRST fires the consumer's handler;
    // subsequent ones are absorbed.
    await sendCue(handle!, { id: "c1", text: "hi", capturedAt: new Date().toISOString() });
    await sendNudge(handle!, "cam");
    await sendFrame(handle!, {
      id: "f1",
      capturedAt: "2026-05-10T20:00:00Z",
      source: "screen-share",
      width: 1,
      height: 1,
      dataUrl: "data:image/jpeg;base64,QUJD"
    });
    expect(onSessionLost).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire on plain 4xx/5xx (only the 410 WRONG_INSTANCE marker)", async () => {
    const fake = installFetchStream({
      sessionId: "session-not-410",
      companionStatus: 400,
      companionBody: { error: "bad input" }
    });
    const onSessionLost = vi.fn();
    const sessionPromise = startLiveSession(baseRequest, {
      onEvent: () => undefined,
      onSessionLost
    });
    fake.writeHandshake();
    const handle = await sessionPromise;
    await sendCue(handle!, { id: "c1", text: "hi", capturedAt: new Date().toISOString() });
    expect(onSessionLost).not.toHaveBeenCalled();
  });
});

describe("closeSession", () => {
  it("aborts the streaming fetch + POSTs to /api/live/stop with the sessionId", async () => {
    const fake = installFetchStream({ sessionId: "session-x" });
    const sessionPromise = startLiveSession(baseRequest, { onEvent: () => undefined });
    fake.writeHandshake();
    const handle = await sessionPromise;
    fake.fetchSpy.mockClear();
    await closeSession(handle!);
    // The drain loop's reader.read() throws AbortError after the
    // controller aborts. Wait a tick for that microtask to complete
    // and the stop POST to land.
    await new Promise((r) => setTimeout(r, 10));
    const stopCall = fake.fetchSpy.mock.calls.find((c) => String(c[0]).endsWith("/api/live/stop"));
    expect(stopCall).toBeDefined();
    expect(handle!.isOpen()).toBe(false);
  });

  it("invokes onClose when the session closes manually", async () => {
    const fake = installFetchStream({ sessionId: "session-oc" });
    const onClose = vi.fn();
    const sessionPromise = startLiveSession(baseRequest, { onEvent: () => undefined, onClose });
    fake.writeHandshake();
    const handle = await sessionPromise;
    await closeSession(handle!);
    // Wait for the drain loop's finally block to run after abort.
    await new Promise((r) => setTimeout(r, 10));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
