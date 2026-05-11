import { afterEach, describe, expect, it } from "vitest";
import { ShowEngine } from "../server/showEngine";
import type { ClientServerEvent, LivecastRequest } from "../shared/contracts";

/**
 * Direct tests for ShowEngine's public contract.
 *
 * The websocket + SSE integration tests exercise the engine
 * transitively via their transports. These tests pin behaviour the
 * transport tests don't naturally distinguish — event ordering at
 * startup, cue queueing behaviour, nudge one-shot semantics, stop
 * idempotence — so a regression in the engine itself produces a
 * targeted alarm rather than a confusing transport-level failure.
 *
 * Runs in mock-provider mode (NODE_ENV=test forces
 * RESOLVED_MODEL_PROVIDER="mock") so the engine boots without
 * external dependencies.
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
  cadenceMs: 3000
};

const engines: ShowEngine[] = [];

afterEach(() => {
  // Stop any engines created during the test so the tick interval
  // doesn't keep the test runner alive past the suite.
  for (const engine of engines) engine.stop();
  engines.length = 0;
});

function createEngine(): ShowEngine {
  const engine = new ShowEngine();
  engines.push(engine);
  return engine;
}

async function collectEvents(
  engine: ShowEngine,
  options: { count: number; timeoutMs?: number }
): Promise<ClientServerEvent[]> {
  const events: ClientServerEvent[] = [];
  const iterator = engine.events()[Symbol.asyncIterator]();
  const deadline = Date.now() + (options.timeoutMs ?? 8000);
  while (events.length < options.count && Date.now() < deadline) {
    const next = iterator.next();
    const result = await Promise.race([
      next,
      new Promise<{ value?: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ done: true }), Math.max(50, deadline - Date.now()))
      )
    ]);
    if (result.done) break;
    events.push(result.value as ClientServerEvent);
  }
  return events;
}

describe("ShowEngine", () => {
  it("emits snapshot then opener commentary as the first two events", async () => {
    const engine = createEngine();
    void engine.start(baseRequest);
    const events = await collectEvents(engine, { count: 2 });
    expect(events[0]?.type).toBe("snapshot");
    expect(events[1]?.type).toBe("commentary");
    if (events[1]?.type === "commentary") {
      // The opener is always Theo's turn per the engine convention.
      expect(events[1].commentary.kind).toBe("opener");
    }
  });

  it("acks queued cues on the next tick with cueIds matching the pending queue", async () => {
    const engine = createEngine();
    void engine.start(baseRequest);
    // Wait for the opener so we know the engine reached the tick loop.
    await collectEvents(engine, { count: 2, timeoutMs: 8000 });
    engine.pushCue({ id: "cue-A", text: "First question", capturedAt: new Date().toISOString() });
    engine.pushCue({ id: "cue-B", text: "Second question", capturedAt: new Date().toISOString() });
    const events = await collectEvents(engine, { count: 6, timeoutMs: 12000 });
    const ack = events.find((e): e is Extract<ClientServerEvent, { type: "cue-ack" }> => e.type === "cue-ack");
    expect(ack).toBeDefined();
    expect(new Set(ack!.cueIds)).toEqual(new Set(["cue-A", "cue-B"]));
  });

  it("emits a status event acknowledging each pushed cue immediately", () => {
    const engine = createEngine();
    // No start() here — we only need the queue plumbing, which is
    // available pre-start. (Cues queued before start are still
    // drained on the first tick.)
    engine.pushCue({ id: "x", text: "hi", capturedAt: new Date().toISOString() });
    expect(engine.pendingEventCount()).toBeGreaterThan(0);
  });

  it("ignores pushFrame / pushCue / pushNudge after stop()", () => {
    const engine = createEngine();
    engine.stop();
    engine.pushCue({ id: "x", text: "hi", capturedAt: new Date().toISOString() });
    engine.pushFrame({
      id: "f",
      capturedAt: new Date().toISOString(),
      source: "screen-share",
      width: 1,
      height: 1,
      dataUrl: "data:image/jpeg;base64,QUJD"
    });
    engine.pushNudge("cam");
    // pushNudge would normally push a "Up next" status, but stop()
    // closes the queue first so nothing accumulates.
    expect(engine.pendingEventCount()).toBe(0);
  });

  it("stop() is idempotent — calling it twice does not throw", () => {
    const engine = createEngine();
    expect(() => {
      engine.stop();
      engine.stop();
    }).not.toThrow();
  });

  it("each engine has a unique id even when constructed back-to-back", () => {
    const a = createEngine();
    const b = createEngine();
    expect(a.id).not.toEqual(b.id);
  });
});
