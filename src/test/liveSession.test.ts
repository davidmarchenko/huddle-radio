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
 * Tests for the client-side SSE transport (liveSession.ts).
 *
 * The module uses two browser-only globals: `fetch` (available in
 * Node 18+) and `EventSource` (NOT available in Node). We stub both
 * with controllable fakes so the test runs in the default Node
 * environment — no jsdom dependency, no real network.
 *
 * The fake EventSource lets each test inject events on demand and
 * inspect what the consumer received via the LiveSessionHandlers
 * callbacks. The fake fetch records every call so we can assert on
 * the request bodies that map to companion POST routes.
 */

type EventSourceListener = (event: { data: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  // Per-event-type listener registry. EventSource fires the named
  // listener (`addEventListener("commentary", …)`) when the server
  // wrote `event: commentary` — we mirror that exact behavior.
  private listeners = new Map<string, EventSourceListener[]>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventSourceListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  /** Test-only: simulate the EventSource emitting an `open` event. */
  fireOpen(): void {
    for (const listener of this.listeners.get("open") ?? []) listener({ data: "" });
  }

  /** Test-only: simulate the EventSource emitting an `error` event. */
  fireError(): void {
    for (const listener of this.listeners.get("error") ?? []) listener({ data: "" });
  }

  /** Test-only: simulate a server-side `event: <type>\ndata: <json>` block. */
  fireEvent(type: string, payload: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(payload) });
    }
  }

  /** Test-only: dispatch only the most-recently constructed instance. */
  static latest(): FakeEventSource {
    const last = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (!last) throw new Error("No FakeEventSource constructed yet.");
    return last;
  }

  static reset(): void {
    FakeEventSource.instances.length = 0;
  }
}

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
  FakeEventSource.reset();
});

function stubStartOk(sessionId: string) {
  const fetchSpy = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/live/start")) {
      return new Response(JSON.stringify({ sessionId }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  return fetchSpy;
}

describe("startLiveSession", () => {
  it("POSTs the LivecastRequest to /api/live/start and returns a handle with the sessionId", async () => {
    const fetchSpy = stubStartOk("session-abc");
    const handle = await startLiveSession(baseRequest, { onEvent: () => undefined });
    expect(handle).toBeDefined();
    expect(handle!.sessionId).toBe("session-abc");
    // First fetch call should be the start POST with the request body.
    const startCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith("/api/live/start"));
    expect(startCall).toBeDefined();
    const init = startCall![1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({ providerMode: "demo" });
  });

  it("opens an EventSource pointed at /api/live/stream?sessionId=…", async () => {
    stubStartOk("session-xyz");
    await startLiveSession(baseRequest, { onEvent: () => undefined });
    const source = FakeEventSource.latest();
    expect(source.url).toBe("/api/live/stream?sessionId=session-xyz");
  });

  it("fires onOpen once the EventSource opens", async () => {
    stubStartOk("session-1");
    const onOpen = vi.fn();
    const handle = await startLiveSession(baseRequest, { onEvent: () => undefined, onOpen });
    FakeEventSource.latest().fireOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(handle!.isOpen()).toBe(true);
  });

  it("dispatches typed SSE events through onEvent in JSON-parsed form", async () => {
    stubStartOk("session-2");
    const events: ClientServerEvent[] = [];
    await startLiveSession(baseRequest, { onEvent: (e) => events.push(e) });
    const source = FakeEventSource.latest();
    source.fireOpen();
    source.fireEvent("commentary", {
      type: "commentary",
      commentary: { id: "c1", text: "hello" }
    });
    source.fireEvent("market-swing", {
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
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("commentary");
    expect(events[1]?.type).toBe("market-swing");
  });

  it("calls onError when /api/live/start returns a non-2xx with a JSON error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "bad request" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    const onError = vi.fn();
    const handle = await startLiveSession(baseRequest, { onEvent: () => undefined, onError });
    expect(handle).toBeUndefined();
    expect(onError).toHaveBeenCalledWith("bad request");
  });

  it("calls onError when fetch itself rejects (network failure before the server responds)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    const onError = vi.fn();
    const handle = await startLiveSession(baseRequest, { onEvent: () => undefined, onError });
    expect(handle).toBeUndefined();
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toMatch(/network down/);
  });

  it("treats EventSource error AFTER open as a transient blip (not an onError)", async () => {
    // EventSource auto-reconnects on transient blips; we should NOT
    // tear down on every blip. onError only fires when the connection
    // never opened in the first place.
    stubStartOk("session-blip");
    const onError = vi.fn();
    await startLiveSession(baseRequest, { onEvent: () => undefined, onError });
    const source = FakeEventSource.latest();
    source.fireOpen();
    source.fireError();
    expect(onError).not.toHaveBeenCalled();
  });

  it("tears down + reports onError when EventSource fires error BEFORE open (server returned 4xx/5xx)", async () => {
    stubStartOk("session-fail");
    const onError = vi.fn();
    const onClose = vi.fn();
    const handle = await startLiveSession(baseRequest, { onEvent: () => undefined, onError, onClose });
    const source = FakeEventSource.latest();
    source.fireError(); // Never opened — treat as fatal
    expect(onError).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(source.closed).toBe(true);
    expect(handle!.isOpen()).toBe(false);
  });
});

describe("sendFrame / sendCue / sendNudge", () => {
  it("sendFrame POSTs to /api/live/frame with sessionId + frame", async () => {
    const fetchSpy = stubStartOk("session-f");
    const handle = await startLiveSession(baseRequest, { onEvent: () => undefined });
    fetchSpy.mockClear();
    const frame: VideoFrameSnapshot = {
      id: "f1",
      capturedAt: "2026-05-10T20:00:00Z",
      source: "screen-share",
      width: 640,
      height: 360,
      dataUrl: "data:image/jpeg;base64,QUJD"
    };
    await sendFrame(handle!, frame);
    const call = fetchSpy.mock.calls[0];
    expect(String(call[0])).toBe("/api/live/frame");
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body).toMatchObject({ sessionId: "session-f", frame: { id: "f1" } });
  });

  it("sendCue POSTs to /api/live/cue and returns true on 2xx", async () => {
    const fetchSpy = stubStartOk("session-c");
    const handle = await startLiveSession(baseRequest, { onEvent: () => undefined });
    fetchSpy.mockClear();
    const cue: ListenerCue = { id: "cue-1", text: "hi", capturedAt: new Date().toISOString() };
    const ok = await sendCue(handle!, cue);
    expect(ok).toBe(true);
    expect(String(fetchSpy.mock.calls[0][0])).toBe("/api/live/cue");
  });

  it("sendCue returns false when the server rejects (4xx/5xx)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ sessionId: "session-c2" }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "no" }), { status: 404 });
      })
    );
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    const handle = await startLiveSession(baseRequest, { onEvent: () => undefined });
    const ok = await sendCue(handle!, {
      id: "cue-1",
      text: "hi",
      capturedAt: new Date().toISOString()
    });
    expect(ok).toBe(false);
  });

  it("sendNudge POSTs to /api/live/nudge with the hostId", async () => {
    const fetchSpy = stubStartOk("session-n");
    const handle = await startLiveSession(baseRequest, { onEvent: () => undefined });
    fetchSpy.mockClear();
    await sendNudge(handle!, "cam");
    const call = fetchSpy.mock.calls[0];
    expect(String(call[0])).toBe("/api/live/nudge");
    expect(JSON.parse(String((call[1] as RequestInit).body))).toMatchObject({
      sessionId: "session-n",
      hostId: "cam"
    });
  });
});

describe("closeSession", () => {
  it("closes the EventSource + POSTs to /api/live/stop with the sessionId", async () => {
    const fetchSpy = stubStartOk("session-x");
    const handle = await startLiveSession(baseRequest, { onEvent: () => undefined });
    const source = FakeEventSource.latest();
    fetchSpy.mockClear();
    await closeSession(handle!);
    expect(source.closed).toBe(true);
    // closeSession calls fetch /api/live/stop fire-and-forget, so we
    // wait a tick to let the microtask flush.
    await new Promise((r) => setTimeout(r, 10));
    const stopCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith("/api/live/stop"));
    expect(stopCall).toBeDefined();
    expect(handle!.isOpen()).toBe(false);
  });

  it("invokes onClose when the session closes manually", async () => {
    stubStartOk("session-oc");
    const onClose = vi.fn();
    const handle = await startLiveSession(baseRequest, { onEvent: () => undefined, onClose });
    FakeEventSource.latest().fireOpen();
    await closeSession(handle!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
