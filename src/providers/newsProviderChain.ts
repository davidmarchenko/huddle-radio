import type { NewsItem, NewsProvider, ProviderHealth, SportLeague } from "../shared/contracts";

export type NewsChainOptions = {
  perProviderTimeoutMs?: number;
  onFallback?: (failedProviderId: string, error: unknown) => void;
};

/**
 * Tries news providers in order; returns the first non-empty success.
 * Provider that throws or returns nothing → advance. Final provider
 * (typically `DemoNewsProvider`) is the always-succeeds terminator.
 *
 * Mirrors the commentary chain pattern from W2 so a real-news outage
 * (W4 ESPN endpoint) silently falls back to the demo storylines without
 * breaking the pregame card.
 */
export class NewsProviderChain implements NewsProvider {
  id = "news-chain";
  private readonly fallbackHits = new Map<string, number>();

  constructor(
    private readonly providers: NewsProvider[],
    private readonly options: NewsChainOptions = {}
  ) {}

  async getLatest(input: { playerIds: string[]; teams: string[]; sport?: SportLeague }): Promise<NewsItem[]> {
    for (const provider of this.providers) {
      try {
        const items = await this.withTimeout(provider.getLatest(input));
        if (items && items.length > 0) return items;
      } catch (error) {
        this.recordFallback(provider.id, error);
      }
    }
    // Every provider either threw or returned empty. The empty case is
    // legitimate (e.g. no team-relevant news today) so we don't treat
    // it as an error — just propagate the empty list.
    return [];
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
        label: `News chain → ${ready.label}`,
        status: "ready",
        detail: `Primary: ${ready.label}. Backups: ${healths.filter((entry) => entry.id !== ready.id).map((entry) => `${entry.label}=${entry.status}`).join(", ") || "none"}.`
      };
    }
    return {
      id: this.id,
      label: "News chain",
      status: "error",
      detail: `No news providers ready. ${healths.map((entry) => `${entry.label}=${entry.status}`).join(", ")}`
    };
  }

  getFallbackStats(): Record<string, number> {
    return Object.fromEntries(this.fallbackHits.entries());
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs = this.options.perProviderTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`News provider timed out after ${timeoutMs}ms`)), timeoutMs);
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
