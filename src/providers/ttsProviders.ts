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

    // ElevenLabs eleven_v3 (the SOTA expressive model) does NOT
    // support WebSocket streaming — only HTTP. Older models
    // (flash_v2_5, multilingual_v2, turbo_v2) support both.
    // Pick the right transport up-front: HTTP for v3, WebSocket
    // streaming for everything else (lower latency for first byte).
    if (this.modelId === "eleven_v3" || this.modelId.startsWith("eleven_v3_")) {
      yield* this.synthesizeHttp(input);
      return;
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

    socket.on("error", (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      failure = new Error(`ElevenLabs WebSocket error: ${detail}`);
      done = true;
      notify?.();
    });

    socket.on("close", (code, reason) => {
      // ElevenLabs closes with a non-1000 code + a reason body when
      // the model rejects the request (wrong model for WS, bad voice
      // id, quota). Surface those details so the show emits a useful
      // error event instead of a generic "WebSocket error." Only
      // attach detail when the close looks abnormal AND the WS error
      // handler hasn't already populated `failure` — and skip
      // entirely if `code` arrives as undefined (mock sockets in
      // tests close without a code).
      if (!done && !failure && typeof code === "number" && code !== 1000) {
        const reasonText = reason?.length ? reason.toString() : `code ${code}`;
        failure = new Error(`ElevenLabs WebSocket closed: ${reasonText}`);
      }
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

  /**
   * HTTP-based TTS for models that don't support the WebSocket
   * streaming endpoint (eleven_v3 and the v3 alpha variants). One
   * POST per turn; the entire MP3 comes back in the response body
   * and is yielded as a single chunk. Higher first-byte latency than
   * WS streaming but compatible with v3's expressive output.
   */
  private async *synthesizeHttp(input: { commentaryId: string; text: string; hostId?: HostId }): AsyncIterable<TTSAudioChunk> {
    const start = performance.now();
    const voiceId = this.resolveVoiceId(input.hostId);
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
    const body = JSON.stringify({
      text: input.text,
      model_id: this.modelId,
      voice_settings: { stability: 0.45, similarity_boost: 0.75 }
    });

    // ElevenLabs' lower subscription tiers cap concurrent requests
    // (3 on Creator). When the engine ticks faster than v3 HTTP TTS
    // generates audio, back-to-back turns can race past the lock and
    // hit 429. Retry the rate-limit case with exponential backoff so
    // the show stays narrated even when the quota is tight. Other
    // failures fall through immediately — no point retrying 401s.
    const MAX_ATTEMPTS = 4;
    let response: Response | undefined;
    let lastDetail = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey!,
          "content-type": "application/json",
          "accept": "audio/mpeg"
        },
        body
      });
      if (response.ok) break;
      if (response.status !== 429) {
        let detail = `HTTP ${response.status}`;
        try {
          const text = await response.text();
          if (text) detail = `${detail}: ${text.slice(0, 200)}`;
        } catch {
          // body unreadable — keep status-only detail
        }
        throw new Error(`ElevenLabs HTTP TTS failed: ${detail}`);
      }
      // 429: drain the body so the connection releases cleanly, then
      // back off. ElevenLabs sometimes returns a `Retry-After` header
      // in seconds — honor it when present; otherwise exponential
      // backoff (250ms * 2^attempt) with a small jitter so parallel
      // engines don't all retry at the same instant.
      try { lastDetail = (await response.text()).slice(0, 200); } catch { /* body unreadable */ }
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader && /^\d+(\.\d+)?$/.test(retryAfterHeader)
        ? Math.min(Number(retryAfterHeader) * 1000, 8000)
        : Math.min(250 * 2 ** attempt + Math.random() * 150, 4000);
      if (attempt === MAX_ATTEMPTS - 1) break;
      await new Promise<void>((resolve) => setTimeout(resolve, retryAfterMs));
    }
    if (!response || !response.ok) {
      throw new Error(`ElevenLabs HTTP TTS failed: HTTP ${response?.status ?? "unknown"}${lastDetail ? `: ${lastDetail}` : ""}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    yield {
      id: crypto.randomUUID(),
      commentaryId: input.commentaryId,
      provider: this.id,
      mimeType: "audio/mpeg",
      base64Audio: base64,
      isFinal: true,
      latencyMs: Math.round(performance.now() - start)
    };
  }

  async health(): Promise<ProviderHealth> {
    const transport = this.modelId === "eleven_v3" || this.modelId.startsWith("eleven_v3_") ? "HTTP" : "WebSocket";
    return {
      id: this.id,
      label: "ElevenLabs TTS",
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey
        ? `Configured for ${transport} streaming TTS with ${this.modelId}.${this.perHostVoiceSummary()}`
        : "Set ELEVENLABS_API_KEY to enable streaming TTS."
    };
  }
}
