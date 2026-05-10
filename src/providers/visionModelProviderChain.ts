import type { MultimodalModelProvider, ProviderHealth, SportsPlay, VideoFrameSnapshot, VideoObservation, VideoSourceConfig } from "../shared/contracts";

export type VisionChainOptions = {
  perProviderTimeoutMs?: number;
  onFallback?: (failedProviderId: string, error: unknown) => void;
};

/**
 * Tries vision providers in order; the first usable observation wins.
 *
 * "Usable" = the provider returned a result and the validation isn't
 * `unavailable`. Anything else (thrown, timeout, unavailable result)
 * advances to the next provider. Final provider should be a
 * never-throws path (e.g. `MockModelProvider`) so the chain always
 * returns an observation.
 */
export class VisionModelProviderChain implements MultimodalModelProvider {
  id = "vision-chain";
  private readonly fallbackHits = new Map<string, number>();

  constructor(
    private readonly providers: MultimodalModelProvider[],
    private readonly options: VisionChainOptions = {}
  ) {}

  async observe(input: { video: VideoSourceConfig; play: SportsPlay; frame?: VideoFrameSnapshot }): Promise<VideoObservation> {
    let lastObservation: VideoObservation | undefined;
    for (const provider of this.providers) {
      try {
        const observation = await this.withTimeout(provider.observe(input));
        if (observation.validation?.status && observation.validation.status !== "unavailable") {
          return observation;
        }
        lastObservation = observation;
        // Treat `unavailable` as a soft fail and try the next vendor.
        this.recordFallback(provider.id, new Error(`vision unavailable: ${observation.validation?.reason ?? "no reason"}`));
      } catch (error) {
        this.recordFallback(provider.id, error);
      }
    }
    if (lastObservation) return lastObservation;
    // Should be unreachable if a no-op terminal is configured. Fall
    // through to the first provider's unavailable observation in case
    // every provider threw.
    return await this.providers[this.providers.length - 1].observe(input);
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
        label: `Vision chain → ${ready.label}`,
        status: "ready",
        detail: `Primary: ${ready.label}. Backups: ${healths.filter((entry) => entry.id !== ready.id).map((entry) => `${entry.label}=${entry.status}`).join(", ") || "none"}.`
      };
    }
    return {
      id: this.id,
      label: "Vision chain",
      status: "error",
      detail: `No vision providers ready. ${healths.map((entry) => `${entry.label}=${entry.status}`).join(", ")}`
    };
  }

  getFallbackStats(): Record<string, number> {
    return Object.fromEntries(this.fallbackHits.entries());
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs = this.options.perProviderTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Vision provider timed out after ${timeoutMs}ms`)), timeoutMs);
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
