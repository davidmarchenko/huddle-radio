import { describe, expect, it, vi } from "vitest";
import { EvalChain } from "../server/eval/evalChain";
import { LocalEvaluator } from "../server/eval/localEvaluator";
import { parseEvalOutput } from "../server/eval/anthropicEvaluator";
import {
  recordEvaluation,
  getRecentEvaluations,
  summarizeRecentEvaluations,
  _resetEvalStoreForTests
} from "../server/eval/evalStore";
import type { EvalInput, Evaluator, TurnEvaluation } from "../server/eval/types";

function evalInput(overrides: Partial<EvalInput> = {}): EvalInput {
  return {
    turnId: "t1",
    text: "Wilson hits a three from the wing",
    recentCommentary: [],
    momentContext: "routine play",
    availableSources: ["play"],
    ...overrides
  };
}

describe("EvalChain", () => {
  it("returns the first successful evaluator's judgement", async () => {
    const winner: Evaluator = {
      id: "winner",
      label: "Winner",
      evaluate: vi.fn(
        async () =>
          ({
            turnId: "x",
            evaluator: "winner",
            scores: { specificity: 8, friction: 6, callbacks: 5, pacing: 7, anti_genericity: 9 },
            stayTuned: 7,
            rationale: "from winner",
            evaluatedAt: new Date().toISOString()
          } satisfies TurnEvaluation)
      ),
      health: async () => ({ id: "winner", label: "Winner", status: "ready", detail: "ok" })
    };
    const chain = new EvalChain([winner, new LocalEvaluator()]);
    const r = await chain.evaluate(evalInput());
    expect(r.evaluator).toBe("winner");
    expect(chain.lastEvaluatorId).toBe("winner");
  });

  it("falls through to the next evaluator on failure", async () => {
    const flaky: Evaluator = {
      id: "flaky",
      label: "Flaky",
      evaluate: vi.fn(async () => {
        throw new Error("upstream 503");
      }),
      health: async () => ({ id: "flaky", label: "Flaky", status: "error", detail: "down" })
    };
    const chain = new EvalChain([flaky, new LocalEvaluator()]);
    const r = await chain.evaluate(evalInput());
    expect(chain.lastEvaluatorId).toBe("local-evaluator");
    expect(r.evaluator).toBe("local-evaluator");
    expect(chain.lastEvalErrors).toEqual([{ evaluatorId: "flaky", message: "upstream 503" }]);
  });

  it("requires at least one evaluator", () => {
    expect(() => new EvalChain([])).toThrow();
  });
});

describe("parseEvalOutput", () => {
  it("parses well-formed JSON", () => {
    const raw = JSON.stringify({
      scores: { specificity: 8, friction: 5, callbacks: 7, pacing: 9, anti_genericity: 8 },
      stayTuned: 7.4,
      rationale: "specific + paced well; mid friction"
    });
    const r = parseEvalOutput(raw, "join-key");
    expect(r.turnId).toBe("join-key");
    expect(r.scores.specificity).toBe(8);
    expect(r.stayTuned).toBe(7.4);
    expect(r.rationale).toContain("specific");
  });

  it("strips code fences if present", () => {
    const raw = "```json\n" + JSON.stringify({
      scores: { specificity: 5, friction: 5, callbacks: 5, pacing: 5, anti_genericity: 5 },
      stayTuned: 5,
      rationale: "average"
    }) + "\n```";
    const r = parseEvalOutput(raw, "k");
    expect(r.scores.specificity).toBe(5);
  });

  it("clamps scores to [0, 10]", () => {
    const raw = JSON.stringify({
      scores: { specificity: 99, friction: -5, callbacks: 7, pacing: 7, anti_genericity: 7 },
      stayTuned: 100,
      rationale: "x"
    });
    const r = parseEvalOutput(raw, "k");
    expect(r.scores.specificity).toBe(10);
    expect(r.scores.friction).toBe(0);
    expect(r.stayTuned).toBe(10);
  });

  it("supplies a default rationale when missing", () => {
    const raw = JSON.stringify({
      scores: { specificity: 5, friction: 5, callbacks: 5, pacing: 5, anti_genericity: 5 },
      stayTuned: 5
    });
    const r = parseEvalOutput(raw, "k");
    expect(r.rationale.length).toBeGreaterThan(0);
  });

  it("parses ruleCompliance entries with valid ruleIds + fired states", () => {
    const raw = JSON.stringify({
      scores: { specificity: 7, friction: 6, callbacks: 5, pacing: 7, anti_genericity: 7 },
      stayTuned: 6.5,
      rationale: "ok",
      ruleCompliance: [
        { ruleId: "friction_quota", fired: "yes", evidence: "Cam: 'No, that's not it'" },
        { ruleId: "steel_man_two_step", fired: "no", evidence: "Maya restated vaguely; agreed without new reason" },
        { ruleId: "no_transition_filler", fired: "yes", evidence: "no banned phrases" }
      ]
    });
    const r = parseEvalOutput(raw, "k");
    expect(r.ruleCompliance).toHaveLength(3);
    expect(r.ruleCompliance![0].ruleId).toBe("friction_quota");
    expect(r.ruleCompliance![0].fired).toBe("yes");
    expect(r.ruleCompliance![1].fired).toBe("no");
  });

  it("drops unknown ruleIds and coerces invalid fired states to n/a", () => {
    const raw = JSON.stringify({
      scores: { specificity: 5, friction: 5, callbacks: 5, pacing: 5, anti_genericity: 5 },
      stayTuned: 5,
      rationale: "x",
      ruleCompliance: [
        { ruleId: "bogus_rule", fired: "yes", evidence: "should be dropped" },
        { ruleId: "friction_quota", fired: "maybe", evidence: "invalid fired → n/a" },
        { ruleId: "turn_shape_payload", fired: "yes", evidence: "kept" }
      ]
    });
    const r = parseEvalOutput(raw, "k");
    expect(r.ruleCompliance).toHaveLength(2);
    expect(r.ruleCompliance!.find((c) => c.ruleId === "friction_quota")?.fired).toBe("n/a");
    expect(r.ruleCompliance!.find((c) => (c as { ruleId: string }).ruleId === "bogus_rule")).toBeUndefined();
  });

  it("omits ruleCompliance field entirely when judge returns no entries (back-compat)", () => {
    const raw = JSON.stringify({
      scores: { specificity: 5, friction: 5, callbacks: 5, pacing: 5, anti_genericity: 5 },
      stayTuned: 5,
      rationale: "x"
    });
    const r = parseEvalOutput(raw, "k");
    expect(r.ruleCompliance).toBeUndefined();
  });
});

describe("evalStore", () => {
  it("records and retrieves evaluations in reverse-chronological order", () => {
    _resetEvalStoreForTests();
    for (let i = 0; i < 3; i += 1) {
      recordEvaluation({
        turnId: `t${i}`,
        evaluator: "local-evaluator",
        scores: { specificity: 5, friction: 5, callbacks: 5, pacing: 5, anti_genericity: 5 },
        stayTuned: 5,
        rationale: `r${i}`,
        evaluatedAt: new Date().toISOString()
      });
    }
    const recent = getRecentEvaluations(10);
    expect(recent).toHaveLength(3);
    expect(recent[0].turnId).toBe("t2"); // most-recent first
  });

  it("aggregates means across all stored evaluations", () => {
    _resetEvalStoreForTests();
    recordEvaluation({
      turnId: "a",
      evaluator: "x",
      scores: { specificity: 8, friction: 6, callbacks: 4, pacing: 8, anti_genericity: 10 },
      stayTuned: 8,
      rationale: "",
      evaluatedAt: new Date().toISOString()
    });
    recordEvaluation({
      turnId: "b",
      evaluator: "x",
      scores: { specificity: 4, friction: 8, callbacks: 6, pacing: 6, anti_genericity: 4 },
      stayTuned: 6,
      rationale: "",
      evaluatedAt: new Date().toISOString()
    });
    const summary = summarizeRecentEvaluations();
    expect(summary.count).toBe(2);
    expect(summary.meanStayTuned).toBe(7);
    expect(summary.meanByDimension.specificity).toBe(6);
    expect(summary.meanByDimension.anti_genericity).toBe(7);
  });

  it("returns empty summary when buffer is empty", () => {
    _resetEvalStoreForTests();
    const summary = summarizeRecentEvaluations();
    expect(summary).toEqual({ count: 0, meanStayTuned: 0, meanByDimension: {} });
  });
});
