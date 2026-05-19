/**
 * Smoke tests for the new diagnostics endpoints. Imports the route
 * handlers directly and invokes them with a faked Request — no
 * Fastify boot, no Next runtime. Catches obvious wiring breakage
 * (wrong import path, broken JSON shape, missing 400 on missing
 * params).
 */

import { describe, expect, it, beforeEach } from "vitest";
import { GET as memoryGET } from "../app/api/diagnostics/memory/route";
import { GET as showArcGET } from "../app/api/diagnostics/show-arc/route";
import {
  _resetSharedClaimsStoreForTests,
  getSharedClaimsStore
} from "../server/memory/claimsStore";
import {
  _resetTurnSummariesForTests,
  recordTurn
} from "../server/turnSummaries";

describe("/api/diagnostics/memory", () => {
  beforeEach(() => {
    _resetSharedClaimsStoreForTests();
  });

  it("returns 400 when listenerId query param is missing", async () => {
    const res = await memoryGET(new Request("http://test/diagnostics/memory"));
    expect(res.status).toBe(400);
  });

  it("returns claims for the requested listener with outcome counts", async () => {
    const store = getSharedClaimsStore();
    await store.save({
      id: "c1",
      listenerId: "alex",
      hostId: "cam",
      text: "Wilson goes for 30",
      anchorPlayerId: "wilson",
      anchorPlayerName: "Wilson",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString(),
      outcome: "right"
    });
    await store.save({
      id: "c2",
      listenerId: "alex",
      hostId: "cam",
      text: "Stewart goes for 25",
      anchorPlayerId: "stewart",
      anchorPlayerName: "Stewart",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString(),
      outcome: "pending"
    });
    const res = await memoryGET(new Request("http://test/diagnostics/memory?listenerId=alex"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.listenerId).toBe("alex");
    expect(body.claims).toHaveLength(2);
    expect(body.counts).toEqual({ right: 1, wrong: 0, pending: 1, total: 2 });
  });

  it("scopes the response to one listener — never leaks others", async () => {
    const store = getSharedClaimsStore();
    await store.save({
      id: "c1",
      listenerId: "alex",
      hostId: "cam",
      text: "x",
      anchorPlayerId: "p",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString()
    });
    await store.save({
      id: "c2",
      listenerId: "bob",
      hostId: "cam",
      text: "y",
      anchorPlayerId: "p",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString()
    });
    const res = await memoryGET(new Request("http://test/diagnostics/memory?listenerId=alex"));
    const body = await res.json();
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0].listenerId).toBe("alex");
  });

  it("respects the limit query param (cap 200, default 50)", async () => {
    const store = getSharedClaimsStore();
    for (let i = 0; i < 10; i += 1) {
      await store.save({
        id: `c${i}`,
        listenerId: "alex",
        hostId: "cam",
        text: `claim ${i}`,
        anchorPlayerId: "p",
        sourceShowId: "show-1",
        capturedAt: new Date(Date.now() - i * 1000).toISOString()
      });
    }
    const res = await memoryGET(new Request("http://test/diagnostics/memory?listenerId=alex&limit=3"));
    const body = await res.json();
    expect(body.claims).toHaveLength(3);
  });
});

describe("/api/diagnostics/show-arc", () => {
  beforeEach(async () => {
    await _resetTurnSummariesForTests();
  });

  it("groups arc trajectory by sessionId, oldest → newest within session", async () => {
    recordTurn({
      turnId: "t1",
      kind: "play",
      sessionId: "sess-A",
      engineId: "eng-1",
      leadHostId: "theo",
      finalHostIds: ["theo"],
      lineCount: 1,
      commentaryProvider: "x",
      ttsEnabled: false,
      ttsChunks: 0,
      totalMs: 0,
      startedAt: "2026-05-13T00:00:00Z",
      arcPosition: "cold-open"
    });
    recordTurn({
      turnId: "t2",
      kind: "play",
      sessionId: "sess-A",
      engineId: "eng-1",
      leadHostId: "maya",
      finalHostIds: ["maya"],
      lineCount: 1,
      commentaryProvider: "x",
      ttsEnabled: false,
      ttsChunks: 0,
      totalMs: 0,
      startedAt: "2026-05-13T00:01:00Z",
      arcPosition: "build"
    });
    recordTurn({
      turnId: "t3",
      kind: "play",
      sessionId: "sess-B",
      engineId: "eng-2",
      leadHostId: "cam",
      finalHostIds: ["cam"],
      lineCount: 1,
      commentaryProvider: "x",
      ttsEnabled: false,
      ttsChunks: 0,
      totalMs: 0,
      startedAt: "2026-05-13T00:02:00Z",
      arcPosition: "climax"
    });
    const res = await showArcGET(new Request("http://test/diagnostics/show-arc"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionCount).toBe(2);
    const sessA = body.sessions.find((s: { sessionId: string }) => s.sessionId === "sess-A");
    expect(sessA.trajectory.map((t: { arcPosition: string }) => t.arcPosition)).toEqual([
      "cold-open",
      "build"
    ]);
    expect(sessA.counts).toEqual({ "cold-open": 1, build: 1 });
  });

  it("skips turns with no arcPosition (legacy / opener turns)", async () => {
    recordTurn({
      turnId: "t1",
      kind: "opener",
      sessionId: "sess-X",
      engineId: "eng",
      leadHostId: "theo",
      finalHostIds: ["theo"],
      lineCount: 1,
      commentaryProvider: "x",
      ttsEnabled: false,
      ttsChunks: 0,
      totalMs: 0,
      startedAt: "2026-05-13T00:00:00Z"
      // no arcPosition
    });
    const res = await showArcGET(new Request("http://test/diagnostics/show-arc"));
    const body = await res.json();
    expect(body.sessionCount).toBe(0);
  });
});
