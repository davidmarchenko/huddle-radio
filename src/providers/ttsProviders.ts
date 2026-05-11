import type { HostId, ProviderHealth, TTSAudioChunk, TTSProvider } from "../shared/contracts";
import WebSocket from "ws";

export class MockTTSProvider implements TTSProvider {
  id = "mock-tts";

  async *synthesize(input: { commentaryId: string; text: string; hostId?: HostId }): AsyncIterable<TTSAudioChunk> {
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 45));
    yield {
      id: crypto.randomUUID(),
      commentaryId: input.commentaryId,
      provider: this.id,
      mimeType: "application/json",
      isFinal: true,
      latencyMs: Math.round(performance.now() - start)
    };
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Mock TTS",
      status: "ready",
      detail: "Browser can speak generated text locally; no TTS API key required."
    };
  }
}

export type HostVoiceMap = Partial<Record<HostId, string>>;

export class ElevenLabsTTSProvider implements TTSProvider {
  id = "elevenlabs";

  constructor(
    private readonly apiKey: string | undefined,
    /** Default voice used when no per-host override is configured. */
    private readonly defaultVoiceId = "Xb7hH8MSUJpSbSDYk0k2",
    private readonly modelId = "eleven_flash_v2_5",
    /**
     * Per-host voice overrides. When set, the matching `hostId` on
     * synthesize() routes to that voice — so Maya / Theo / Cam can sound
     * distinct instead of all sharing one voice. Falls back to
     * `defaultVoiceId` for any host without an override.
     */
    private readonly hostVoiceMap: HostVoiceMap = {}
  ) {}

  private resolveVoiceId(hostId?: HostId): string {
    if (hostId && this.hostVoiceMap[hostId]) return this.hostVoiceMap[hostId]!;
    return this.defaultVoiceId;
  }

  private perHostVoiceSummary(): string {
    const hosts = (Object.keys(this.hostVoiceMap) as HostId[]).filter((id) => this.hostVoiceMap[id]);
    if (hosts.length === 0) return "";
    return ` Per-host voices configured for: ${hosts.join(", ")}.`;
  }

  async *synthesize(input: { commentaryId: string; text: string; hostId?: HostId }): AsyncIterable<TTSAudioChunk> {
    if (!this.apiKey) {
      throw new Error("ELEVENLABS_API_KEY is required when TTS_PROVIDER=elevenlabs.");
    }

    const start = performance.now();
    const voiceId = this.resolveVoiceId(input.hostId);
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${this.modelId}&auto_mode=true`;
    const socket = new WebSocket(url, {
      headers: {
        "xi-api-key": this.apiKey
      }
    });

    const queue: TTSAudioChunk[] = [];
    let done = false;
    let failure: Error | undefined;
    let notify: (() => void) | undefined;

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          text: " ",
          voice_settings: { stability: 0.45, similarity_boost: 0.75 }
        })
      );
      socket.send(JSON.stringify({ text: input.text, try_trigger_generation: true }));
      socket.send(JSON.stringify({ text: "" }));
    });

    socket.on("message", (data) => {
      try {
        const payload = JSON.parse(String(data)) as { audio?: string; isFinal?: boolean };
        if (payload.audio) {
          queue.push({
            id: crypto.randomUUID(),
            commentaryId: input.commentaryId,
            provider: this.id,
            mimeType: "audio/mpeg",
            base64Audio: payload.audio,
            isFinal: Boolean(payload.isFinal),
            latencyMs: Math.round(performance.now() - start)
          });
        }
        if (payload.isFinal) done = true;
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Unable to parse ElevenLabs audio chunk.");
        done = true;
      }
      notify?.();
    });

    socket.on("error", () => {
      failure = new Error("ElevenLabs WebSocket error.");
      done = true;
      notify?.();
    });

    socket.on("close", () => {
      done = true;
      notify?.();
    });

    while (true) {
      // Failure check first — must run before the loop-exit guard so a
      // socket error that arrives between yields surfaces to the
      // caller instead of being swallowed by `done = true`.
      if (failure) throw failure;
      const item = queue.shift();
      if (item) {
        yield item;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "ElevenLabs TTS",
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey
        ? `Configured for WebSocket streaming TTS with ${this.modelId}.${this.perHostVoiceSummary()}`
        : "Set ELEVENLABS_API_KEY to enable streaming TTS."
    };
  }
}
