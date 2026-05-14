/**
 * EvalChain — try evaluators in order, fall through on failure.
 *
 * Same chain pattern as ProducerChain + CommentaryProviderChain. In
 * production: AnthropicEvaluator first, LocalEvaluator always tail-
 * anchored so the eval ring buffer never goes empty when Claude is
 * down.
 */

import type { ProviderHealth } from "../../shared/contracts";
import type { EvalInput, Evaluator, TurnEvaluation } from "./types";

export type EvalChainError = { evaluatorId: string; message: string };

export class EvalChain implements Evaluator {
  id = "eval-chain";
  label = "Evaluator Chain";
  /** Evaluator id that answered the most recent evaluate() call. */
  lastEvaluatorId = "";
  /** Errors from upstream evaluators that fell through on the most
   *  recent call. Cleared at the start of each call. */
  lastEvalErrors: EvalChainError[] = [];

  constructor(private readonly evaluators: Evaluator[]) {
    if (evaluators.length === 0) {
      throw new Error("EvalChain requires at least one evaluator");
    }
  }

  async evaluate(input: EvalInput): Promise<TurnEvaluation> {
    this.lastEvalErrors = [];
    let lastError: unknown;
    for (const ev of this.evaluators) {
      try {
        const result = await ev.evaluate(input);
        this.lastEvaluatorId = ev.id;
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastEvalErrors.push({ evaluatorId: ev.id, message });
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("All evaluators failed");
  }

  async health(): Promise<ProviderHealth> {
    const labels = this.evaluators.map((e) => e.label).join(" → ");
    const probes = await Promise.allSettled(this.evaluators.map((e) => e.health()));
    const errors = probes.filter((p) => p.status === "rejected");
    if (errors.length === this.evaluators.length) {
      return { id: this.id, label: this.label, status: "error", detail: `All evaluators errored. Order: ${labels}.` };
    }
    return { id: this.id, label: this.label, status: "ready", detail: `Order: ${labels}.` };
  }
}
