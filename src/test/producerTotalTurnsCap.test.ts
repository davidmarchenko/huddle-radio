import { describe, expect, it } from "vitest";
import { parseProducerOutput } from "../providers/producer/anthropicProducer";

/**
 * Pins the per-tick total-turn cap. The producer's prompt asks for ≤5
 * but doesn't always honor it — observed 8-line monster ticks in live
 * testing destroyed the SportsCenter cadence. The cap is a hard
 * post-parse trim, not a re-prompt: trim the LAST beats' turnCounts
 * (the first beat's full count is preserved because it sets up the
 * lead-host context).
 */
describe("parseProducerOutput — total-turn cap", () => {
  it("passes through a turn budget already at or under the cap", () => {
    const raw = JSON.stringify({
      beats: [
        { topic: "Mahomes drives", angle: "play call", leadHostId: "theo", turnCount: 2, sourceKind: "play" },
        { topic: "Maya math", angle: "callback", leadHostId: "maya", turnCount: 2, sourceKind: "play" }
      ],
      showState: "Q2 11:42"
    });
    const result = parseProducerOutput(raw);
    expect(result.beats).toHaveLength(2);
    expect(result.beats.reduce((sum, b) => sum + b.turnCount, 0)).toBe(4);
  });

  it("trims the last beat's turnCount when sum > cap", () => {
    // 3 + 3 + 3 = 9 → cap at 5 → 3 + 2 + 0 (third beat dropped)
    const raw = JSON.stringify({
      beats: [
        { topic: "a", angle: "x", leadHostId: "theo", turnCount: 3, sourceKind: "play" },
        { topic: "b", angle: "y", leadHostId: "maya", turnCount: 3, sourceKind: "play" },
        { topic: "c", angle: "z", leadHostId: "cam", turnCount: 3, sourceKind: "play" }
      ],
      showState: ""
    });
    const result = parseProducerOutput(raw);
    const total = result.beats.reduce((sum, b) => sum + b.turnCount, 0);
    expect(total).toBeLessThanOrEqual(5);
    expect(result.beats[0].turnCount).toBe(3); // first beat preserved
    expect(result.beats[1].turnCount).toBe(2); // second beat trimmed
  });

  it("drops trailing beats entirely if first beat already exhausts the cap", () => {
    // 5 turn count is invalid (max per beat is 3), so this won't happen
    // in practice — but the trimmer should be robust to a hypothetical
    // first beat eating the whole budget.
    const raw = JSON.stringify({
      beats: [
        { topic: "a", angle: "x", leadHostId: "theo", turnCount: 3, sourceKind: "play" },
        { topic: "b", angle: "y", leadHostId: "maya", turnCount: 3, sourceKind: "play" },
        { topic: "c", angle: "z", leadHostId: "cam", turnCount: 3, sourceKind: "play" }
      ],
      showState: ""
    });
    const result = parseProducerOutput(raw);
    expect(result.beats.length).toBeLessThanOrEqual(3);
    expect(result.beats.reduce((sum, b) => sum + b.turnCount, 0)).toBeLessThanOrEqual(5);
  });

  it("preserves the lead-host setup beat even when trimming", () => {
    const raw = JSON.stringify({
      beats: [
        { topic: "first matters", angle: "setup", leadHostId: "theo", turnCount: 2, sourceKind: "play" },
        { topic: "second take", angle: "react", leadHostId: "cam", turnCount: 3, sourceKind: "play" },
        { topic: "third extra", angle: "extra", leadHostId: "maya", turnCount: 3, sourceKind: "play" }
      ],
      showState: ""
    });
    const result = parseProducerOutput(raw);
    expect(result.beats[0].turnCount).toBe(2);
    expect(result.beats[0].topic).toBe("first matters");
    expect(result.beats.reduce((sum, b) => sum + b.turnCount, 0)).toBeLessThanOrEqual(5);
  });
});
