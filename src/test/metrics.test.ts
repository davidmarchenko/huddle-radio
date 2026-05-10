import { describe, expect, it } from "vitest";
import { ShowUsageBudget } from "../server/metrics";

describe("ShowUsageBudget", () => {
  it("does not flag degradation while under the cap", () => {
    const budget = new ShowUsageBudget({ maxCommentaryTokens: 100, maxTtsCharacters: 200 });
    budget.recordCommentary("a".repeat(100)); // 100 chars / 4 = 25 tokens
    budget.recordTts("a".repeat(50));
    expect(budget.shouldDegradeCommentary()).toBe(false);
    expect(budget.shouldDegradeTts()).toBe(false);
    expect(budget.isCommentaryDegraded()).toBe(false);
    expect(budget.isTtsDegraded()).toBe(false);
  });

  it("flags commentary degradation only on the first crossing of the cap", () => {
    const budget = new ShowUsageBudget({ maxCommentaryTokens: 25 });
    budget.recordCommentary("a".repeat(100)); // 25 tokens — at cap
    expect(budget.shouldDegradeCommentary()).toBe(true);
    // Subsequent calls return false (already-degraded), but the state stays.
    expect(budget.shouldDegradeCommentary()).toBe(false);
    expect(budget.isCommentaryDegraded()).toBe(true);
  });

  it("flags TTS degradation independently of commentary", () => {
    const budget = new ShowUsageBudget({ maxCommentaryTokens: 100_000, maxTtsCharacters: 50 });
    budget.recordTts("a".repeat(60));
    expect(budget.shouldDegradeTts()).toBe(true);
    expect(budget.isCommentaryDegraded()).toBe(false);
    expect(budget.isTtsDegraded()).toBe(true);
  });

  it("snapshot reports counts and degraded flags", () => {
    const budget = new ShowUsageBudget({ maxCommentaryTokens: 25 });
    budget.recordCommentary("a".repeat(120)); // 30 tokens — over the 25 cap
    budget.shouldDegradeCommentary();
    expect(budget.snapshot()).toEqual({
      commentaryChars: 120,
      commentaryTokensApprox: 30,
      ttsChars: 0,
      commentaryDegraded: true,
      ttsDegraded: false
    });
  });
});
