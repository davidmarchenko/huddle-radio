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

  describe("slate mode", () => {
    it("ranks the slate and boots the show on the top entry", async () => {
      const engine = createEngine();
      // A 2-game slate where the listener's favorite team (KC) is in
      // the SECOND entry — the ranker should reorder so KC@DET wins
      // even though BUF@CIN was passed first.
      void engine.start({
        ...baseRequest,
        sportsGameId: undefined,
        group: {
          ...baseRequest.group,
          listener: { ...baseRequest.group.listener, favoriteTeam: "KC" }
        },
        slate: [
          {
            id: "demo-buf-cin",
            label: "Bills at Bengals",
            shortName: "BUF @ CIN",
            sport: "nfl",
            awayTeam: "BUF",
            homeTeam: "CIN",
            score: { away: 0, home: 0 },
            status: "scheduled",
            detail: "Tonight"
          },
          {
            id: "demo-kc-det",
            label: "Chiefs at Lions",
            shortName: "KC @ DET",
            sport: "nfl",
            awayTeam: "KC",
            homeTeam: "DET",
            score: { away: 0, home: 0 },
            status: "scheduled",
            detail: "Tonight"
          }
        ]
      });
      const events = await collectEvents(engine, { count: 1, timeoutMs: 8000 });
      const snapshot = events.find(
        (e): e is Extract<ClientServerEvent, { type: "snapshot" }> => e.type === "snapshot"
      );
      expect(snapshot).toBeDefined();
      // The boot game is the top-ranked entry — KC@DET, not BUF@CIN.
      expect(snapshot!.game.gameId).toBe("demo-kc-det");
    });

    it("falls through to single-game mode when the slate has fewer than 2 entries", async () => {
      const engine = createEngine();
      // A 1-entry "slate" is just a single game — engine should
      // ignore the slate and honor `sportsGameId`.
      void engine.start({
        ...baseRequest,
        slate: [
          {
            id: "demo-buf-cin",
            label: "Bills at Bengals",
            shortName: "BUF @ CIN",
            sport: "nfl",
            awayTeam: "BUF",
            homeTeam: "CIN",
            score: { away: 0, home: 0 },
            status: "scheduled",
            detail: "Tonight"
          }
        ]
      });
      const events = await collectEvents(engine, { count: 1, timeoutMs: 8000 });
      const snapshot = events.find(
        (e): e is Extract<ClientServerEvent, { type: "snapshot" }> => e.type === "snapshot"
      );
      // sportsGameId from baseRequest is "demo-kc-det" — that wins
      // because the 1-entry slate doesn't trigger slate mode.
      expect(snapshot!.game.gameId).toBe("demo-kc-det");
    });
  });

  describe("switchGame", () => {
    it("no-ops when the engine hasn't started yet", () => {
      const engine = createEngine();
      // Pre-start switchGame is a no-op — there's no broadcast to
      // switch yet, the listener should set the game via start().
      expect(() => {
        engine.switchGame({ video: { mode: "stream-url", url: "" } });
      }).not.toThrow();
      // Nothing is queued because switchGame bailed before pushing
      // the status event.
      expect(engine.pendingEventCount()).toBe(0);
    });

    it("no-ops after stop()", () => {
      const engine = createEngine();
      engine.stop();
      engine.switchGame({ video: { mode: "stream-url", url: "" } });
      expect(engine.pendingEventCount()).toBe(0);
    });

    it("queues a status event signalling the pivot when called mid-show", async () => {
      const engine = createEngine();
      void engine.start(baseRequest);
      // Drain through the opener so the engine is in the tick loop.
      await collectEvents(engine, { count: 2, timeoutMs: 8000 });
      engine.switchGame({
        sportsGameId: "demo-buf-cin",
        video: { mode: "stream-url", url: "" },
        toSummaryHint: "the late game"
      });
      const events = await collectEvents(engine, { count: 1, timeoutMs: 2000 });
      const status = events.find(
        (e): e is Extract<ClientServerEvent, { type: "status" }> => e.type === "status"
      );
      expect(status).toBeDefined();
      expect(status!.message).toContain("the late game");
    });

    it(
      "a handoff commentary lands after switchGame is called mid-show",
      async () => {
        const engine = createEngine();
        void engine.start(baseRequest);
        // Drain through opener + the first tick (which fires
        // synchronously inside start()) so we're solidly inside the
        // tick loop before triggering the switch.
        await collectEvents(engine, { count: 5, timeoutMs: 12000 });
        engine.switchGame({
          sportsGameId: "demo-buf-cin",
          video: { mode: "stream-url", url: "" },
          toSummaryHint: "Bills at Bengals"
        });
        // Collect a healthy window of post-switch events. The
        // handoff fires at the top of the NEXT scheduled tick —
        // with 3s cadence we want enough budget for that tick to
        // run plus the producer + commentary draft.
        const events = await collectEvents(engine, { count: 25, timeoutMs: 15000 });
        const handoff = events.find(
          (e): e is Extract<ClientServerEvent, { type: "commentary" }> =>
            e.type === "commentary" && (e.commentary.producerBeats ?? []).includes("handoff")
        );
        expect(handoff).toBeDefined();
        // act-break is the arc framing for a structural transition
        // — not a close, not a fresh open.
        expect(handoff!.commentary.arcPosition).toBe("act-break");
      },
      // Tick cadence + producer + commentary = comfortably under 20s,
      // but the default 5s vitest timeout is too tight. Bump for this
      // single integration test only.
      20000
    );
  });
});
