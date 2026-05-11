import { afterEach, describe, expect, it } from "vitest";
import { _resetTurnSummariesForTests, getRecentTurns, recordTurn, type TurnSummary } from "../server/turnSummaries";

const sample = (overrides: Partial<TurnSummary> = {}): TurnSummary => ({
  turnId: overrides.turnId ?? "t1",
  kind: overrides.kind ?? "play",
  sessionId: "sess",
  engineId: "eng",
  leadHostId: "theo",
  finalHostIds: ["theo", "maya"],
  lineCount: 2,
  commentaryProvider: "openai-commentary",
  ttsEnabled: true,
  ttsProvider: "elevenlabs",
  ttsChunks: 4,
  ttsFirstByteMs: 300,
  textGenerationMs: 1200,
  totalMs: 2100,
  startedAt: "2026-05-11T18:00:00Z",
  ...overrides
});

describe("turnSummaries ring buffer", () => {
  afterEach(() => {
    _resetTurnSummariesForTests();
  });

  it("returns the most recent turns newest-first", () => {
    recordTurn(sample({ turnId: "t1" }));
    recordTurn(sample({ turnId: "t2" }));
    recordTurn(sample({ turnId: "t3" }));
    const turns = getRecentTurns(5);
    expect(turns.map((t) => t.turnId)).toEqual(["t3", "t2", "t1"]);
  });

  it("caps the buffer at 100 entries so a long show doesn't bloat memory", () => {
    for (let i = 0; i < 120; i += 1) recordTurn(sample({ turnId: `t${i}` }));
    const turns = getRecentTurns(200);
    // Oldest 20 should be evicted; newest 100 remain.
    expect(turns).toHaveLength(100);
    expect(turns[0].turnId).toBe("t119");
    expect(turns[turns.length - 1].turnId).toBe("t20");
  });

  it("clamps the limit param to safe bounds (1..100)", () => {
    for (let i = 0; i < 30; i += 1) recordTurn(sample({ turnId: `t${i}` }));
    expect(getRecentTurns(0)).toHaveLength(1);
    expect(getRecentTurns(-5)).toHaveLength(1);
    expect(getRecentTurns(500)).toHaveLength(30);
  });
});
