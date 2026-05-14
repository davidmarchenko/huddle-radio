/**
 * Synthetic-listener eval harness — types.
 *
 * Every commentary turn (opener or play) gets graded after it ships
 * so we can answer "is the show actually getting better?" with data,
 * not vibes. Eval runs ASYNCHRONOUSLY (fire-and-forget) so it never
 * adds latency to the listener-facing tick.
 *
 * Two axes:
 *
 *   1. Dimension scores (0-10) — specificity, host friction, callbacks,
 *      pacing, anti-genericity. Per-dimension lets us pinpoint
 *      regressions ("specificity dropped after we shipped the
 *      producer") instead of seeing a single blended number.
 *
 *   2. Composite "stay tuned" score (0-10) — the bottom-line judgment
 *      a synthetic listener makes: would they keep listening past this
 *      turn? Used for top-line A/B and rollout decisions.
 *
 * Plus a single-sentence rationale so a human reviewer can spot-check
 * a low score without re-running the LLM.
 */

import type { ProviderHealth } from "../../shared/contracts";

export type EvalDimension =
  | "specificity"
  | "friction"
  | "callbacks"
  | "pacing"
  | "anti_genericity";

export type TurnEvaluation = {
  /** turnId from TurnSummary — primary key for joining eval back to
   *  the turn that produced it. */
  turnId: string;
  /** Eval provider id that emitted this judgement. Lets us A/B
   *  evaluators without conflating their outputs. */
  evaluator: string;
  /** Per-dimension 0-10 scores. */
  scores: Record<EvalDimension, number>;
  /** Composite 0-10: "would a real listener keep listening past this
   *  turn?" Drives the top-line metric. */
  stayTuned: number;
  /** One-sentence reason — for human spot-checks of edge cases. */
  rationale: string;
  /** ISO timestamp the eval ran (not when the turn happened). */
  evaluatedAt: string;
};

export type EvalInput = {
  /** Same id we'll join eval back to via TurnSummary. */
  turnId: string;
  /** What the host LLM produced — joined dialogue. The eval's
   *  primary subject. */
  text: string;
  /** Recent prior turns from the same show (4-6 most recent). The
   *  evaluator uses these to detect callbacks and pacing. */
  recentCommentary: string[];
  /** Plain-English description of the moment the turn was responding
   *  to ("Wilson buzzer-beater 3 to put the Storm up by 1") so the
   *  evaluator can judge whether the energy level matched. */
  momentContext: string;
  /** What signals were available to the producer for this turn —
   *  helps the evaluator distinguish "the take was generic because
   *  there was nothing to say" from "the take was generic despite
   *  rich signals." */
  availableSources: string[];
};

export type Evaluator = {
  id: string;
  label: string;
  evaluate(input: EvalInput): Promise<TurnEvaluation>;
  health(): Promise<ProviderHealth>;
};
