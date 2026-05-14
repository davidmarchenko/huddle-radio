/**
 * ProducerChain — try producers in order, fall through on failure.
 *
 * Mirrors the CommentaryProviderChain pattern: in production we run
 * AnthropicProducer (or any LLM-backed producer) first, with
 * LocalProducer always tail-anchoring the chain so we never go
 * silent. The chain owns the failure-isolation policy so the caller
 * (showEngine) just calls `.produce()` and gets a directive back.
 */

import type { ProviderHealth } from "../../shared/contracts";
import type { ProducerAgent, ProducerDirective, ProducerInput } from "./types";

export type ChainError = { providerId: string; message: string };

export class ProducerChain implements ProducerAgent {
  id = "producer-chain";
  label = "Producer Chain";
  /** The producer id that answered the most recent produce() call —
   *  set after each call so the engine can stamp it on the turn
   *  summary. Empty string until the first call. */
  lastProducerId = "";
  /** Errors from upstream producers in the chain that fell through
   *  on the most recent produce() call. Cleared at the start of each
   *  call. The engine reads this to surface degraded state on the
   *  turn summary. */
  lastProduceErrors: ChainError[] = [];

  constructor(private readonly producers: ProducerAgent[]) {
    if (producers.length === 0) {
      throw new Error("ProducerChain requires at least one producer");
    }
  }

  async produce(input: ProducerInput): Promise<ProducerDirective> {
    this.lastProduceErrors = [];
    let lastError: unknown;
    for (const producer of this.producers) {
      try {
        const directive = await producer.produce(input);
        this.lastProducerId = producer.id;
        return directive;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastProduceErrors.push({ providerId: producer.id, message });
        lastError = error;
      }
    }
    // Should be unreachable because LocalProducer never throws — but
    // surface a real error if every producer in the chain failed.
    throw lastError instanceof Error ? lastError : new Error("Every producer in the chain failed");
  }

  async health(): Promise<ProviderHealth> {
    const allHealth = await Promise.allSettled(this.producers.map((p) => p.health()));
    const labels = this.producers.map((p) => p.label).join(" → ");
    const errors = allHealth.filter((r) => r.status === "rejected");
    if (errors.length === this.producers.length) {
      return {
        id: this.id,
        label: this.label,
        status: "error",
        detail: `All producers in the chain reported errors. Order: ${labels}.`
      };
    }
    return {
      id: this.id,
      label: this.label,
      status: "ready",
      detail: `Order: ${labels}.`
    };
  }
}
