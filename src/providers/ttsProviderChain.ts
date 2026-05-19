import type { HostId, ProviderHealth, TTSAudioChunk, TTSProvider } from "../shared/contracts";

export type TtsChainOptions = {
  /** Optional callback invoked when a provider falls through to the next. Used for fallback metrics. */
  onFallback?: (failedProviderId: string, error: unknown, phase: "dialogue" | "stream-start") => void;
};

/**
 * TTS provider chain. Tries each provider in order; the first one to
 * successfully start producing audio wins for that call. On a thrown
 * error (the common case: Inworld 403 "no credit", ElevenLabs 401,
 * etc.) the chain advances to the next provider so the listener still
 * hears something instead of a silent show.
 *
 * Unlike the commentary chain, this only intercepts HARD failures —
 * not slowness. A cold ElevenLabs first-byte can take 5-15s, which is
 * legitimately the chosen provider doing its job, not a failure. The
 * engine already enforces overall tick budgets; this chain layers
 * provider-redundancy on top.
 *
 * Streaming nuance: once a provider yields its FIRST chunk, the chain
 * commits to that provider for the rest of the stream — we can't
 * safely splice mid-utterance audio from a different voice. A
 * mid-stream failure aborts the iterator (caller hears a truncated
 * line for that turn, then the show continues).
 */
export class TtsProviderChain implements TTSProvider {
  id = "tts-chain";
  /** Tracks how many times each provider has been bypassed since boot. */
  private readonly fallbackHits = new Map<string, number>();
  /** Provider that won the last successful call. Read for telemetry. */
  private _lastProviderId?: string;

  constructor(
    private readonly providers: TTSProvider[],
    private readonly options: TtsChainOptions = {}
  ) {
    if (providers.length === 0) {
      throw new Error("TtsProviderChain needs at least one provider");
    }
  }

  get lastProviderId(): string | undefined {
    return this._lastProviderId;
  }

  /** Per-provider fallback counts since boot. Surfaced in diagnostics. */
  getFallbackStats(): Record<string, number> {
    return Object.fromEntries(this.fallbackHits.entries());
  }

  async synthesizeDialogue(input: {
    commentaryId: string;
    turns: Array<{ text: string; hostId?: HostId }>;
  }): Promise<TTSAudioChunk> {
    let lastError: unknown;
    let attempted = 0;
    for (const provider of this.providers) {
      if (!provider.synthesizeDialogue) continue;
      attempted += 1;
      try {
        const chunk = await provider.synthesizeDialogue(input);
        this._lastProviderId = provider.id;
        return chunk;
      } catch (error) {
        lastError = error;
        this.recordFallback(provider.id, error, "dialogue");
      }
    }
    // No provider had synthesizeDialogue OR all of them threw. Surface
    // the last error so the engine's per-call fallback (to per-line
    // streaming) kicks in — same path it takes today when a single
    // provider's synthesizeDialogue throws.
    if (lastError) throw lastError;
    throw new Error(
      attempted === 0
        ? "tts-chain: no provider exposes synthesizeDialogue"
        : "tts-chain: every synthesizeDialogue provider failed"
    );
  }

  async *synthesize(input: {
    commentaryId: string;
    text: string;
    hostId?: HostId;
  }): AsyncIterable<TTSAudioChunk> {
    for (const provider of this.providers) {
      try {
        const iterator = provider.synthesize(input)[Symbol.asyncIterator]();
        // Pull the FIRST chunk under the chain's error guard. If the
        // provider's synthesize rejects synchronously (Inworld 403
        // hits on the very first fetch), we catch here and try the
        // next provider. Once the first chunk lands, commit — we
        // stream the rest from the same provider so no voice splicing.
        const first = await iterator.next();
        if (first.done) {
          // Empty iterator — treat as failure, try the next provider.
          this.recordFallback(provider.id, new Error("empty stream"), "stream-start");
          continue;
        }
        this._lastProviderId = provider.id;
        yield first.value;
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          yield next.value;
        }
      } catch (error) {
        this.recordFallback(provider.id, error, "stream-start");
        // Continue to the next provider — we have not yielded any
        // chunks yet, so the listener hasn't heard anything to splice
        // against.
      }
    }
    // Every provider failed before yielding a chunk. Caller gets a
    // silent turn for this line; show continues. Mock provider in
    // last position is the safest tail so this branch effectively
    // doesn't fire.
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
        label: `TTS chain → ${ready.label}`,
        status: "ready",
        detail: `Primary: ${ready.label}. Backups: ${healths.filter((entry) => entry.id !== ready.id).map(describe).join(", ") || "none"}.`
      };
    }
    return {
      id: this.id,
      label: "TTS chain",
      status: "error",
      detail: `No TTS providers ready. ${healths.map(describe).join(", ")}`
    };
  }

  private recordFallback(providerId: string, error: unknown, phase: "dialogue" | "stream-start"): void {
    this.fallbackHits.set(providerId, (this.fallbackHits.get(providerId) ?? 0) + 1);
    console.warn(JSON.stringify({
      event: "tts.chain.fallback",
      providerId,
      phase,
      error: error instanceof Error ? error.message : String(error),
      status: (error as { status?: number })?.status,
      code: (error as { code?: string })?.code
    }));
    this.options.onFallback?.(providerId, error, phase);
  }
}

function describe(health: ProviderHealth): string {
  return `${health.label}=${health.status}`;
}
