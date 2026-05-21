import type { HostId, ProviderHealth, TTSAudioChunk, TTSProvider } from "../shared/contracts";
import WebSocket from "ws";
import { stripDeliveryTags } from "./commentaryPrompts";

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

  async *synthesize(input: {
    commentaryId: string;
    text: string;
    hostId?: HostId;
    signal?: AbortSignal;
  }): AsyncIterable<TTSAudioChunk> {
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
    // Strip delivery tags before sending to the WS endpoint. Eleven's
    // WS streaming model line (flash/turbo/multilingual_v2) does NOT
    // interpret bracketed audio tags — they get spoken literally. Only
    // T2D (synthesizeDialogue / HTTP eleven-text-to-dialogue) honors
    // them reliably. Tags stay in DialogueLine.text for the T2D path.
    const cleanText = stripDeliveryTags(input.text);
    const socket = new WebSocket(url, {
      headers: {
        "xi-api-key": this.apiKey
      }
    });
    // Wire AbortSignal → socket.close. Engine aborts on per-line
    // timeout or stop(); without this the WS stays open until the
    // server-side decides to close (or the iterator naturally
    // drains), which can leak the connection and the Creator-tier
    // concurrent slot for tens of seconds.
    const onAbort = () => {
      try {
        socket.close(1000, "client-aborted");
      } catch {
        // close() doesn't throw in spec'd implementations; if the
        // socket is already CLOSING/CLOSED, ignore.
      }
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }

    const queue: TTSAudioChunk[] = [];
    let done = false;
    let failure: Error | undefined;
    let notify: (() => void) | undefined;
    let messageCount = 0;
    let audioMessageCount = 0;

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          text: " ",
          voice_settings: { stability: 0.45, similarity_boost: 0.75 }
        })
      );
      socket.send(JSON.stringify({ text: cleanText, try_trigger_generation: true }));
      socket.send(JSON.stringify({ text: "" }));
    });

    socket.on("message", (data) => {
      messageCount += 1;
      try {
        const payload = JSON.parse(String(data)) as { audio?: string; isFinal?: boolean; error?: string; message?: string; code?: number };
        if (payload.error || payload.message) {
          console.warn(JSON.stringify({
            event: "tts.ws.server-error-msg",
            commentaryId: input.commentaryId,
            error: payload.error,
            message: payload.message,
            code: payload.code
          }));
        }
        if (payload.audio) {
          audioMessageCount += 1;
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
      console.warn(JSON.stringify({
        event: "tts.ws.error",
        commentaryId: input.commentaryId,
        detail
      }));
      failure = new Error(`ElevenLabs WebSocket error: ${detail}`);
      done = true;
      notify?.();
    });

    socket.on("close", (code, reason) => {
      const reasonText = reason?.length ? reason.toString() : "";
      // ElevenLabs closes with a non-1000 code + a reason body when
      // the model rejects the request (wrong model for WS, bad voice
      // id, quota). Surface those details so the show emits a useful
      // error event instead of a generic "WebSocket error." Only
      // attach detail when the close looks abnormal AND the WS error
      // handler hasn't already populated `failure` — and skip
      // entirely if `code` arrives as undefined (mock sockets in
      // tests close without a code).
      if (!done && !failure && typeof code === "number" && code !== 1000) {
        failure = new Error(`ElevenLabs WebSocket closed: ${reasonText || `code ${code}`}`);
      } else if (!failure && typeof code === "number" && audioMessageCount === 0) {
        // Silent failure mode: socket closed cleanly but we never received
        // any audio. Without this, streamDialogueAudio sees zero chunks +
        // zero errors and exits silently, leaving the listener with no
        // audio AND no diagnostic. Surface as an explicit failure so the
        // outer warn-logger fires. Skip when `code` is undefined — that's
        // the test-mock signature, not a real ElevenLabs close.
        failure = new Error(
          `ElevenLabs WebSocket closed without audio (code=${code}, ${messageCount} non-audio messages received)`
        );
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
  private async *synthesizeHttp(input: {
    commentaryId: string;
    text: string;
    hostId?: HostId;
    signal?: AbortSignal;
  }): AsyncIterable<TTSAudioChunk> {
    const start = performance.now();
    const voiceId = this.resolveVoiceId(input.hostId);
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
    // Strip delivery tags for the HTTP per-line path too — v3 reads
    // them more reliably than the WS path but plurals and unsupported
    // adjectives still leak as spoken words. Tags stay in DialogueLine.text
    // for the dedicated T2D path (synthesizeDialogue).
    const cleanText = stripDeliveryTags(input.text);
    const body = JSON.stringify({
      text: cleanText,
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
        body,
        signal: input.signal
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

  /**
   * Purpose-built multi-speaker generation via ElevenLabs Text-to-Dialogue
   * (`POST /v1/text-to-dialogue`). One call returns one seamless MP3 with
   * natural turn-taking, pacing, and (with audio tags) emotional delivery
   * across all hosts — exactly what makes this feel like a real podcast
   * instead of a sequence of robot-spliced voice clips.
   *
   * Forces `eleven_v3` regardless of the instance's configured model
   * because T2D ONLY supports v3 — the older flash / multilingual models
   * are 404'd on this endpoint. Falls back to a single retry on 429.
   * Throws on any other failure so the caller's chain logger fires.
   */
  async synthesizeDialogue(input: {
    commentaryId: string;
    turns: Array<{ text: string; hostId?: HostId }>;
  }): Promise<TTSAudioChunk> {
    if (!this.apiKey) {
      throw new Error("ELEVENLABS_API_KEY is required for text-to-dialogue.");
    }
    const start = performance.now();
    const inputs = input.turns.map((turn) => ({
      text: turn.text,
      voice_id: this.resolveVoiceId(turn.hostId)
    }));
    const body = JSON.stringify({
      inputs,
      // T2D is v3-only; the model id on this provider may be flash_v2_5
      // for the streaming WS path, but for dialogue we must hit v3.
      model_id: "eleven_v3",
      output_format: "mp3_44100_128"
    });

    const MAX_ATTEMPTS = 3;
    let response: Response | undefined;
    let lastDetail = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      response = await fetch("https://api.elevenlabs.io/v1/text-to-dialogue", {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg"
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
          /* body unreadable */
        }
        throw new Error(`ElevenLabs Text-to-Dialogue failed: ${detail}`);
      }
      // 429 path — same retry shape as the HTTP TTS fallback so backoff
      // behavior is uniform across both endpoints.
      try { lastDetail = (await response.text()).slice(0, 200); } catch { /* body unreadable */ }
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader && /^\d+(\.\d+)?$/.test(retryAfterHeader)
        ? Math.min(Number(retryAfterHeader) * 1000, 8000)
        : Math.min(500 * 2 ** attempt + Math.random() * 200, 6000);
      if (attempt === MAX_ATTEMPTS - 1) break;
      await new Promise<void>((resolve) => setTimeout(resolve, retryAfterMs));
    }
    if (!response || !response.ok) {
      throw new Error(
        `ElevenLabs Text-to-Dialogue failed: HTTP ${response?.status ?? "unknown"}${lastDetail ? `: ${lastDetail}` : ""}`
      );
    }
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    return {
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
        ? `Configured for ${transport} streaming TTS with ${this.modelId}; multi-turn falls back to v3 Text-to-Dialogue.${this.perHostVoiceSummary()}`
        : "Set ELEVENLABS_API_KEY to enable streaming TTS."
    };
  }
}
