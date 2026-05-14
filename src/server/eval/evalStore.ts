/**
 * Per-turn eval ring buffer. Mirrors turnSummaries — last 100
 * evaluations across all shows, queryable for the diagnostics
 * endpoint and any future trend dashboards.
 *
 * Single grep target: `grep eval.turn.summary` gives the per-turn
 * eval audit trail without needing the diagnostics endpoint.
 */

import type { TurnEvaluation } from "./types";

const BUFFER_LIMIT = 100;
const buffer: TurnEvaluation[] = [];

export function recordEvaluation(evaluation: TurnEvaluation): void {
  buffer.push(evaluation);
  if (buffer.length > BUFFER_LIMIT) {
    buffer.splice(0, buffer.length - BUFFER_LIMIT);
  }
  console.log(JSON.stringify({ event: "eval.turn.summary", ...evaluation }));
}

export function getRecentEvaluations(limit: number): TurnEvaluation[] {
  const clamped = Math.max(1, Math.min(BUFFER_LIMIT, Math.floor(limit)));
  return buffer.slice(-clamped).reverse();
}

/** Test-only — reset the buffer between integration runs. */
export function _resetEvalStoreForTests(): void {
  buffer.length = 0;
}

/** Compact rolling snapshot for the producer + arc planner feedback
 *  loop. Same numbers as summarizeRecentEvaluations but typed for
 *  programmatic consumption (vs the diagnostics endpoint payload).
 *  Returns undefined when the buffer is empty so callers can short-
 *  circuit cheaply. */
export type EvalSnapshot = {
  /** Number of evals contributing to these means. Producer should
   *  ignore the snapshot below ~3 — too small to be reliable. */
  sampleSize: number;
  meanStayTuned: number;
  meanSpecificity: number;
  meanFriction: number;
  meanCallbacks: number;
  meanPacing: number;
  meanAntiGenericity: number;
};

/** Pull a feedback-loop-friendly snapshot of the last N evals. The
 *  producer + arc planner read this each tick to decide whether to
 *  shift gears (more callbacks, more stats, change pacing). */
export function getRecentEvalSnapshot(n = 6): EvalSnapshot | undefined {
  const recent = getRecentEvaluations(n);
  if (recent.length === 0) return undefined;
  let stayTuned = 0;
  let specificity = 0;
  let friction = 0;
  let callbacks = 0;
  let pacing = 0;
  let antiGenericity = 0;
  for (const r of recent) {
    stayTuned += r.stayTuned;
    specificity += r.scores.specificity;
    friction += r.scores.friction;
    callbacks += r.scores.callbacks;
    pacing += r.scores.pacing;
    antiGenericity += r.scores.anti_genericity;
  }
  const len = recent.length;
  return {
    sampleSize: len,
    meanStayTuned: round1(stayTuned / len),
    meanSpecificity: round1(specificity / len),
    meanFriction: round1(friction / len),
    meanCallbacks: round1(callbacks / len),
    meanPacing: round1(pacing / len),
    meanAntiGenericity: round1(antiGenericity / len)
  };
}

/** Aggregate stats over the buffer for /api/diagnostics/eval — mean
 *  per dimension + mean stayTuned + count. Useful for "did the
 *  producer rollout move the needle." */
export function summarizeRecentEvaluations(limit = BUFFER_LIMIT): {
  count: number;
  meanStayTuned: number;
  meanByDimension: Record<string, number>;
} {
  const recent = getRecentEvaluations(limit);
  if (recent.length === 0) {
    return { count: 0, meanStayTuned: 0, meanByDimension: {} };
  }
  const dimensionTotals: Record<string, number> = {};
  let stayTunedSum = 0;
  for (const evaluation of recent) {
    stayTunedSum += evaluation.stayTuned;
    for (const [k, v] of Object.entries(evaluation.scores)) {
      dimensionTotals[k] = (dimensionTotals[k] ?? 0) + v;
    }
  }
  const meanByDimension: Record<string, number> = {};
  for (const [k, sum] of Object.entries(dimensionTotals)) {
    meanByDimension[k] = round1(sum / recent.length);
  }
  return {
    count: recent.length,
    meanStayTuned: round1(stayTunedSum / recent.length),
    meanByDimension
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
