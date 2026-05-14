import { describe, expect, it } from "vitest";
import { extractVisionSignals } from "../providers/enrichment/visionExtractor";
import type { SportsGameState, VideoObservation } from "../shared/contracts";

function game(): SportsGameState {
  return {
    provider: "espn-scoreboard",
    gameId: "wnba-1",
    sport: "wnba",
    awayTeam: "SEA",
    homeTeam: "LV",
    status: "live",
    currentPlay: {
      id: "p1",
      type: "other",
      excitement: 3,
      clock: "5:00",
      quarter: "Q3",
      possession: "LV",
      headline: "play",
      description: "play",
      playerIds: ["wilson"],
      team: "LV",
      score: { away: 60, home: 65 },
      occurredAt: new Date().toISOString()
    },
    recentPlays: [],
    updatedAt: new Date().toISOString()
  };
}

function obs(overrides: Partial<VideoObservation> = {}): VideoObservation {
  return {
    id: "obs-1",
    source: "stream-url",
    summary: "live action",
    confidence: 0.85,
    observedAt: new Date().toISOString(),
    latencyMs: 100,
    usedFrame: true,
    validation: {
      status: "sports-event",
      confidence: 0.9,
      sport: "basketball",
      evidence: ["scoreboard visible"],
      reason: "ok",
      validatedAt: new Date().toISOString()
    },
    color: [],
    ...overrides
  };
}

describe("extractVisionSignals", () => {
  it("emits a signal per non-generic color note", () => {
    const signals = extractVisionSignals(
      obs({
        color: [
          "Aces bench standing and pumping fists after the bucket",
          "Storm coach pacing the sideline with arms crossed",
          "Wilson celebrating with a low-key nod walking back upcourt"
        ]
      }),
      game()
    );
    expect(signals).toHaveLength(3);
    expect(signals[0].source).toBe("vision");
    expect(signals[0].kind).toBe("context");
    expect(signals[0].id).toMatch(/^vision-/);
  });

  it("filters generic frame-validation phrases ('scoreboard', 'crowd', 'stadium')", () => {
    const signals = extractVisionSignals(
      obs({ color: ["scoreboard", "crowd", "stadium", "wide shot", "Aces bench standing"] }),
      game()
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].text).toContain("Aces bench");
  });

  it("returns [] when validation isn't sports-event (uncertain frames are unreliable)", () => {
    const uncertain = extractVisionSignals(
      obs({
        validation: {
          status: "uncertain",
          confidence: 0.3,
          evidence: ["unclear"],
          reason: "low confidence",
          validatedAt: new Date().toISOString()
        },
        color: ["Aces bench standing and pumping fists"]
      }),
      game()
    );
    expect(uncertain).toEqual([]);

    const notSports = extractVisionSignals(
      obs({
        validation: {
          status: "not-sports",
          confidence: 0.9,
          evidence: ["news anchor"],
          reason: "talking heads",
          validatedAt: new Date().toISOString()
        },
        color: ["news anchor at desk gesturing"]
      }),
      game()
    );
    expect(notSports).toEqual([]);
  });

  it("returns [] when observation is undefined", () => {
    expect(extractVisionSignals(undefined, game())).toEqual([]);
  });

  it("returns [] when color array is empty/missing", () => {
    expect(extractVisionSignals(obs({ color: [] }), game())).toEqual([]);
    expect(extractVisionSignals(obs({ color: undefined }), game())).toEqual([]);
  });

  it("dedupes color notes that are textually identical (case-insensitive)", () => {
    const signals = extractVisionSignals(
      obs({
        color: [
          "Aces bench standing and pumping fists",
          "ACES BENCH STANDING AND PUMPING FISTS"
        ]
      }),
      game()
    );
    expect(signals).toHaveLength(1);
  });

  it("scores action-verb notes higher than static descriptors", () => {
    const action = extractVisionSignals(
      obs({ confidence: 0.7, color: ["Aces bench jumping and celebrating after the shot"] }),
      game()
    );
    const static_ = extractVisionSignals(
      obs({ confidence: 0.7, color: ["coach with a clipboard near the bench"] }),
      game()
    );
    expect(action[0].score).toBeGreaterThan(static_[0].score);
  });

  it("attaches the active play's team as refs.teamId", () => {
    const signals = extractVisionSignals(
      obs({ color: ["Aces bench going wild after the bucket"] }),
      game()
    );
    expect(signals[0].refs?.teamId).toBe("LV");
  });

  it("collapses signals across ticks within the same 30s shot window", () => {
    // Two observations 5 seconds apart with the same color — should
    // produce signals with the same id (so the aggregator's
    // identity-dedup pass collapses them across ticks).
    const t1 = "2026-05-13T17:00:05Z";
    const t2 = "2026-05-13T17:00:15Z";
    const a = extractVisionSignals(obs({ observedAt: t1, color: ["Aces bench standing"] }), game());
    const b = extractVisionSignals(obs({ observedAt: t2, color: ["Aces bench standing"] }), game());
    expect(a[0].id).toBe(b[0].id);
  });

  it("emits a fresh id when the same color appears in a NEW shot window", () => {
    // 60s apart — different windows.
    const t1 = "2026-05-13T17:00:05Z";
    const t2 = "2026-05-13T17:01:15Z";
    const a = extractVisionSignals(obs({ observedAt: t1, color: ["Aces bench standing and waving towels"] }), game());
    const b = extractVisionSignals(obs({ observedAt: t2, color: ["Aces bench standing and waving towels"] }), game());
    expect(a[0].id).not.toBe(b[0].id);
  });
});
