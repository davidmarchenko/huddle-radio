import { describe, expect, it } from "vitest";
import { LocalEvaluator } from "../server/eval/localEvaluator";
import type { EvalInput } from "../server/eval/types";

function input(overrides: Partial<EvalInput> = {}): EvalInput {
  return {
    turnId: "t1",
    text: "default text",
    recentCommentary: [],
    momentContext: "routine play",
    availableSources: ["play"],
    ...overrides
  };
}

describe("LocalEvaluator", () => {
  it("rewards specificity (named players + numbers)", async () => {
    const ev = new LocalEvaluator();
    const generic = await ev.evaluate(input({ text: "yeah it was a good play tonight" }));
    const specific = await ev.evaluate(
      input({ text: "Wilson hit her 4th three from the wing — Aces lead 64 to 58 with 5 minutes left." })
    );
    expect(specific.scores.specificity).toBeGreaterThan(generic.scores.specificity);
  });

  it("rewards friction markers (push-back, callbacks)", async () => {
    const ev = new LocalEvaluator();
    const flat = await ev.evaluate(input({ text: "yeah I think she's playing well" }));
    const friction = await ev.evaluate(
      input({ text: "No, actually wait — last week you predicted Wilson would cool off, and she's gone for 22 since." })
    );
    expect(friction.scores.friction).toBeGreaterThan(flat.scores.friction);
  });

  it("detects callbacks via shingle overlap with prior turns", async () => {
    const ev = new LocalEvaluator();
    const noPrior = await ev.evaluate(input({ text: "Wilson keeps hitting from deep" }));
    const withCallback = await ev.evaluate(
      input({
        text: "Wilson keeps hitting from deep — same shot Cam predicted earlier",
        recentCommentary: ["Cam: Wilson keeps hitting from deep, that's three in a row"]
      })
    );
    expect(withCallback.scores.callbacks).toBeGreaterThan(noPrior.scores.callbacks);
  });

  it("scales pacing to the moment context", async () => {
    const ev = new LocalEvaluator();
    const shortRoutine = await ev.evaluate(input({ text: "Quick reaction here, two-pointer falls.", momentContext: "routine play" }));
    const longRoutine = await ev.evaluate(input({ text: "x ".repeat(300), momentContext: "routine play" }));
    expect(shortRoutine.scores.pacing).toBeGreaterThan(longRoutine.scores.pacing);

    const shortBuzzer = await ev.evaluate(input({ text: "Quick.", momentContext: "buzzer-beater game-winner" }));
    const apppropriateBuzzer = await ev.evaluate(
      input({
        text:
          "Wilson rises and releases that three at the very top of the key as the buzzer is going off and it bangs through the net for the win to put the Aces up by 1 over the Storm in this Western Conference rematch tonight. " +
          "The Storm bench cannot believe what they just saw, the crowd at Michelob Ultra Arena is on its feet absolutely losing it and that is the entire season for these two teams sitting right there in that one shot. " +
          "What a moment for Wilson, what a closer she is becoming this year, the Storm have to live with the consequences of giving her that look one more time.",
        momentContext: "buzzer-beater game-winner"
      })
    );
    expect(apppropriateBuzzer.scores.pacing).toBeGreaterThan(shortBuzzer.scores.pacing);
  });

  it("penalises generic filler ('big slate tonight', 'welcome back')", async () => {
    const ev = new LocalEvaluator();
    const generic = await ev.evaluate(
      input({ text: "Welcome back folks, big slate tonight, big play here, what a play." })
    );
    const clean = await ev.evaluate(input({ text: "Wilson opens the quarter on a screen action." }));
    expect(generic.scores.anti_genericity).toBeLessThan(clean.scores.anti_genericity);
  });

  it("emits a stayTuned composite that's the rounded mean of dimensions", async () => {
    const ev = new LocalEvaluator();
    const evalResult = await ev.evaluate(
      input({
        text: "Wilson with the dagger three to put the Aces up 4. That's her fourth from deep tonight.",
        recentCommentary: ["earlier Wilson was struggling from outside"]
      })
    );
    const dims = Object.values(evalResult.scores);
    const expectedMean = Math.round((dims.reduce((a, b) => a + b, 0) / dims.length) * 10) / 10;
    expect(evalResult.stayTuned).toBe(expectedMean);
  });

  it("emits a one-sentence rationale highlighting strong + weak dimensions", async () => {
    const ev = new LocalEvaluator();
    const r = await ev.evaluate(input({ text: "yeah" }));
    expect(r.rationale.length).toBeGreaterThan(0);
    expect(r.rationale.toLowerCase()).toContain("weak"); // very short text → multiple lows expected
  });

  it("preserves the turnId for join-back to TurnSummary", async () => {
    const ev = new LocalEvaluator();
    const r = await ev.evaluate(input({ turnId: "join-key-xyz" }));
    expect(r.turnId).toBe("join-key-xyz");
    expect(r.evaluator).toBe("local-evaluator");
  });

  it("reports ready health", async () => {
    const ev = new LocalEvaluator();
    const h = await ev.health();
    expect(h.status).toBe("ready");
  });
});
