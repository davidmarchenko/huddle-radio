import type { ProviderHealth } from "../shared/contracts";
import type { CommentaryDraftInput } from "./commentaryPrompts";
import type { CommentaryProvider } from "./openAICommentaryProvider";

export type CommentaryChainOptions = {
  /**
   * Hard timeout per provider. Past this, the chain treats the provider
   * as a failure and advances. Default: 8s — long enough for reasoning
   * models on a slow path, short enough that listeners don't notice the
   * fallback.
   */
  perProviderTimeoutMs?: number;
  /** Optional callback invoked when a provider falls through to the next. Used for fallback metrics. */
  onFallback?: (failedProviderId: string, error: unknown) => void;
};

/**
 * Tries commentary providers in order; the first non-empty success
 * wins. On error or timeout, advances to the next provider. The final
 * provider should be a never-throws path (LocalCommentaryProvider) so
 * the chain always returns a string.
 */
export class CommentaryProviderChain implements CommentaryProvider {
  id = "commentary-chain";
  private readonly fallbackHits = new Map<string, number>();

  constructor(
    private readonly providers: CommentaryProvider[],
    private readonly options: CommentaryChainOptions = {}
  ) {}

  async draft(input: CommentaryDraftInput): Promise<string> {
    let lastError: unknown;
    for (const provider of this.providers) {
      try {
        const text = await this.withTimeout(provider.draft(input));
        if (text && text.length > 0) return text;
      } catch (error) {
        lastError = error;
        this.recordFallback(provider.id, error);
      }
    }
    if (lastError) throw lastError;
    return input.fallbackText;
  }

  async health(): Promise<ProviderHealth> {
    const healths = await Promise.all(
      this.providers.map(async (provider) => {
        try {
          return await provider.health();
        } catch (error) {
          return {
            id: provider.id,
            label: provider.id,
            status: "error" as const,
            detail: error instanceof Error ? error.message : "Health check failed."
          };
        }
      })
    );
    const ready = healths.find((entry) => entry.status === "ready");
    if (ready) {
      return {
        id: this.id,
        label: `Commentary chain → ${ready.label}`,
        status: "ready",
        detail: `Primary: ${ready.label}. Backups: ${healths.filter((entry) => entry.id !== ready.id).map(describe).join(", ") || "none"}.`
      };
    }
    return {
      id: this.id,
      label: "Commentary chain",
      status: "error",
      detail: `No commentary providers ready. ${healths.map(describe).join(", ")}`
    };
  }

  /** Per-provider fallback hits since process start. */
  getFallbackStats(): Record<string, number> {
    return Object.fromEntries(this.fallbackHits.entries());
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs = this.options.perProviderTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Commentary provider timed out after ${timeoutMs}ms`)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  private recordFallback(providerId: string, error: unknown): void {
    this.fallbackHits.set(providerId, (this.fallbackHits.get(providerId) ?? 0) + 1);
    this.options.onFallback?.(providerId, error);
  }
}

function describe(health: ProviderHealth): string {
  return `${health.label}=${health.status}`;
}
