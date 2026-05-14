import type { HostId, ProviderHealth, TTSAudioChunk, TTSProvider, WordTiming } from "../shared/contracts";
import { config } from "../server/config";

/**
 * Inworld TTS-2 provider — experimental alternative to ElevenLabs + Fish.
 *
 * What Inworld brings uniquely: best-in-class natural disfluencies (real
 * "uh" and "um" in the right places), audio tags like `[laugh]`, `[sigh]`,
 * `[breathe]`, `[clear_throat]`, `[cough]`, and sub-250ms TTFB at
 * $15-25 per 1M characters. The catch is it's single-voice — no native
 * multi-speaker dialogue. We synthesize each turn separately and the
 * engine's selectTTSStrategy already falls back to per-line streaming
 * when a provider lacks `synthesizeDialogue`.
 *
 * Off by default. Activate by setting TTS_PROVIDER=inworld in env.
 * Lives in its own file so disabling the experiment is a single
 * config flip — no other code changes.
 *
 * Protocol reference: https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech
 */

export type InworldHostVoiceMap = Partial<Record<HostId, string>>;

export class InworldTtsProvider implements TTSProvider {
  id = "inworld-tts-2";

  constructor(
    private readonly apiKey: string | undefined,
    /** Default Inworld voice id used when no per-host override is configured. */
    private readonly defaultVoiceId: string,
    /** Inworld model id. inworld-tts-2 = the expressive frontier model. */
    private readonly modelId: string = "inworld-tts-2",
    /** Per-host voice overrides. Each entry is an Inworld `voiceId` from
     *  their voice library. Falls back to `defaultVoiceId` when a host
     *  has no override configured. */
    private readonly hostVoiceMap: InworldHostVoiceMap = {},
    /** When false, skips `timestampType: "WORD"` on requests. Trades
     *  the audio-synced live transcript for faster TTS responses —
     *  Inworld doesn't have to compute word + phoneme alignments. */
    private readonly timestampsEnabled: boolean = true
  ) {}

  private resolveVoiceId(hostId?: HostId): string {
    if (hostId && this.hostVoiceMap[hostId]) return this.hostVoiceMap[hostId]!;
    return this.defaultVoiceId;
  }

  /**
   * Single-host synthesis. POSTs the text + voiceId to Inworld's REST
   * endpoint and yields ONE chunk with the full MP3. The endpoint itself
   * doesn't stream over HTTP (the realtime websocket variant does, but
   * the basic /tts/v1/voice route returns the complete audioContent in
   * a single response), so we surface a single isFinal chunk —
   * consistent with the dialogue contract elsewhere.
   *
   * For multi-host turn-sets the engine's selectTTSStrategy calls this
   * once per turn — Inworld has no native multi-speaker dialogue, so
   * each turn round-trips separately. Latency per turn is ~250-500ms
   * (Inworld's <250ms first-byte spec + network round-trip).
   */
  async *synthesize(input: { commentaryId: string; text: string; hostId?: HostId }): AsyncIterable<TTSAudioChunk> {
    if (!this.apiKey) {
      throw new Error("INWORLD_API_KEY is required when TTS_PROVIDER=inworld.");
    }
    const start = performance.now();
    const voiceId = this.resolveVoiceId(input.hostId);

    // Inworld is hard-capped at 2,000 chars per request. We're well
    // under that for individual turns (30-60 words ≈ 200-400 chars),
    // but trim defensively in case a future prompt produces a long
    // paragraph — better to truncate than to 400 the whole turn.
    const safeText = input.text.length > 1900 ? input.text.slice(0, 1900) : input.text;

    const body = JSON.stringify({
      text: safeText,
      voiceId,
      modelId: this.modelId,
      audioConfig: {
        audioEncoding: "MP3",
        sampleRateHertz: 44100
      },
      // CREATIVE delivery mode unlocks the expressive non-verbals
      // (audio tags + real disfluencies). STABLE is what we'd use if
      // we needed deterministic enterprise voice; for an entertaining
      // sports show, CREATIVE is the right default.
      deliveryMode: "CREATIVE",
      temperature: 1.0,
      // Word-level alignment fires the audio-synced live transcript
      // panel on the client. The streaming endpoint + ASYNC transport
      // strategy is what makes this affordable: audio bytes flow back
      // as fast as the model produces them, and alignment is computed
      // in parallel and arrives in a trailing message. Total server
      // wait drops from (audio_time + alignment_time) to
      // max(audio_time, alignment_time) — which is what closed the
      // audible speaker-to-speaker gap.
      ...(this.timestampsEnabled
        ? { timestampType: "WORD", timestampTransportStrategy: "ASYNC" }
        : {})
    });

    const MAX_ATTEMPTS = 3;
    let response: Response | undefined;
    let lastDetail = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      response = await fetch("https://api.inworld.ai/tts/v1/voice:stream", {
        method: "POST",
        headers: {
          // Inworld uses Basic auth where the API key IS the basic
          // credential — no username/password split, just the key.
          Authorization: `Basic ${this.apiKey}`,
          "content-type": "application/json",
          accept: "application/json"
        },
        body
      });
      if (response.ok && response.body) break;
      if (response.status !== 429 && response.status < 500) {
        let detail = `HTTP ${response.status}`;
        try {
          const text = await response.text();
          if (text) detail = `${detail}: ${text.slice(0, 200)}`;
        } catch {
          /* body unreadable */
        }
        throw new Error(`Inworld TTS failed: ${detail}`);
      }
      try { lastDetail = (await response.text()).slice(0, 200); } catch { /* body unreadable */ }
      // Exponential backoff for 429 + 5xx — Inworld doesn't document a
      // Retry-After header, so we synthesize one with jitter.
      const retryAfterMs = Math.min(400 * 2 ** attempt + Math.random() * 200, 5000);
      if (attempt === MAX_ATTEMPTS - 1) break;
      await new Promise<void>((resolve) => setTimeout(resolve, retryAfterMs));
    }
    if (!response || !response.ok || !response.body) {
      throw new Error(
        `Inworld TTS failed: HTTP ${response?.status ?? "unknown"}${lastDetail ? `: ${lastDetail}` : ""}`
      );
    }

    // The streaming endpoint returns a series of JSON objects (NOT
    // NDJSON — they're concatenated without newline separators). Each
    // frame is `{ result?: { audioContent?, timestampInfo? }, error? }`.
    // We accumulate audio bytes from every result.audioContent and
    // capture the trailing timestampInfo (ASYNC strategy delivers it
    // after the last audio frame). One MP3 buffer + one wordTimings
    // array → one TTSAudioChunk, so the rest of the engine and client
    // need no changes.
    const audioParts: Buffer[] = [];
    let lastTimingPayload: InworldTtsResponse["timestampInfo"] | undefined;
    let frameError: unknown;
    for await (const frame of parseConcatenatedJsonStream(response.body)) {
      if ((frame as { error?: unknown }).error) {
        frameError = (frame as { error: unknown }).error;
        break;
      }
      const result = (frame as { result?: InworldStreamResult }).result;
      if (!result) continue;
      if (result.audioContent) {
        audioParts.push(Buffer.from(result.audioContent, "base64"));
      }
      if (result.timestampInfo) {
        lastTimingPayload = mergeTimestampInfo(lastTimingPayload, result.timestampInfo);
      }
    }
    if (frameError) {
      const detail = typeof frameError === "string"
        ? frameError
        : (frameError as { message?: string }).message ?? JSON.stringify(frameError).slice(0, 200);
      throw new Error(`Inworld TTS stream error: ${detail}`);
    }
    if (audioParts.length === 0) {
      throw new Error("Inworld TTS stream returned no audioContent.");
    }
    const combined = Buffer.concat(audioParts);
    const wordTimings = parseInworldWordTimings({ timestampInfo: lastTimingPayload });
    yield {
      id: crypto.randomUUID(),
      commentaryId: input.commentaryId,
      provider: this.id,
      mimeType: "audio/mpeg",
      base64Audio: combined.toString("base64"),
      isFinal: true,
      latencyMs: Math.round(performance.now() - start),
      wordTimings: wordTimings.length > 0 ? wordTimings : undefined
    };
  }

  async health(): Promise<ProviderHealth> {
    const overrideHosts = (Object.keys(this.hostVoiceMap) as HostId[]).filter((id) => this.hostVoiceMap[id]);
    const overrideSummary = overrideHosts.length > 0 ? ` Per-host voices for: ${overrideHosts.join(", ")}.` : "";
    return {
      id: this.id,
      label: "Inworld TTS-2",
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey
        ? `Configured for ${this.modelId} via REST. Single-voice provider — multi-turn commentaries synth per turn.${overrideSummary}`
        : "Set INWORLD_API_KEY and TTS_PROVIDER=inworld to enable."
    };
  }
}

/**
 * Inworld streaming TTS frame shape. The streaming endpoint wraps the
 * payload in a `result` envelope and may emit many of these — audio
 * frames first, a trailing timestamp frame last (with ASYNC strategy).
 */
type InworldStreamResult = {
  audioContent?: string;
  timestampInfo?: {
    wordAlignment?: {
      words?: string[];
      wordStartTimeSeconds?: number[];
      wordEndTimeSeconds?: number[];
    };
  };
};

/**
 * Legacy alias used by `parseInworldWordTimings` — preserves the older
 * non-stream call signature so the helper works for both the streaming
 * envelope's `timestampInfo` (extracted) and any future non-stream code
 * path that hands in a full response object.
 */
type InworldTtsResponse = {
  audioContent?: string;
  timestampInfo?: InworldStreamResult["timestampInfo"];
};

/**
 * Merge two `timestampInfo` payloads. ASYNC delivery for short turns
 * collapses to a single trailing frame in practice, but Inworld is
 * free to split alignment across multiple frames — so we concatenate
 * the parallel arrays rather than overwriting. Missing arrays from
 * either side are tolerated.
 */
function mergeTimestampInfo(
  prev: InworldStreamResult["timestampInfo"] | undefined,
  next: NonNullable<InworldStreamResult["timestampInfo"]>
): InworldStreamResult["timestampInfo"] {
  if (!prev) return next;
  const prevAlign = prev.wordAlignment ?? {};
  const nextAlign = next.wordAlignment ?? {};
  return {
    wordAlignment: {
      words: [...(prevAlign.words ?? []), ...(nextAlign.words ?? [])],
      wordStartTimeSeconds: [
        ...(prevAlign.wordStartTimeSeconds ?? []),
        ...(nextAlign.wordStartTimeSeconds ?? [])
      ],
      wordEndTimeSeconds: [
        ...(prevAlign.wordEndTimeSeconds ?? []),
        ...(nextAlign.wordEndTimeSeconds ?? [])
      ]
    }
  };
}

/**
 * Parse a stream of concatenated JSON objects. Inworld's docs are
 * explicit that the streaming response is NOT NDJSON — frames are
 * just back-to-back JSON, no separator. We brace-count at the top
 * level (ignoring braces inside strings) and yield each balanced
 * object as it completes. Buffer is trimmed on every emit so memory
 * stays bounded even for long synthesis runs.
 */
async function* parseConcatenatedJsonStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let pos = 0;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let objStart = -1;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      while (pos < buf.length) {
        const ch = buf[pos];
        if (esc) {
          esc = false;
        } else if (inStr) {
          if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') {
          inStr = true;
        } else if (ch === "{") {
          if (depth === 0) objStart = pos;
          depth += 1;
        } else if (ch === "}") {
          depth -= 1;
          if (depth === 0 && objStart >= 0) {
            const slice = buf.slice(objStart, pos + 1);
            try {
              yield JSON.parse(slice) as unknown;
            } catch {
              /* malformed frame — drop and keep scanning */
            }
            buf = buf.slice(pos + 1);
            pos = -1;
            objStart = -1;
          }
        }
        pos += 1;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Convert Inworld's parallel-arrays alignment format to our
 * canonical WordTiming[] (ms-based). Drops entries where any field
 * is missing or malformed — better to lose one word's timing than to
 * inject NaN into the client's render loop.
 */
function parseInworldWordTimings(payload: InworldTtsResponse): WordTiming[] {
  const alignment = payload.timestampInfo?.wordAlignment;
  if (!alignment) return [];
  const words = alignment.words ?? [];
  const starts = alignment.wordStartTimeSeconds ?? [];
  const ends = alignment.wordEndTimeSeconds ?? [];
  const out: WordTiming[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const text = words[i];
    const startSec = starts[i];
    const endSec = ends[i];
    if (typeof text !== "string" || typeof startSec !== "number" || typeof endSec !== "number") continue;
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    out.push({
      text,
      startMs: Math.round(startSec * 1000),
      endMs: Math.round(endSec * 1000)
    });
  }
  return out;
}

/**
 * Per-host Inworld voice IDs from env. Mirrors buildHostVoiceMap and
 * buildFishHostVoiceMap — each provider owns its own host→voice map.
 */
export function buildInworldHostVoiceMap(): InworldHostVoiceMap {
  const map: InworldHostVoiceMap = {};
  if (config.INWORLD_VOICE_ID_MAYA) map.maya = config.INWORLD_VOICE_ID_MAYA;
  if (config.INWORLD_VOICE_ID_THEO) map.theo = config.INWORLD_VOICE_ID_THEO;
  if (config.INWORLD_VOICE_ID_CAM) map.cam = config.INWORLD_VOICE_ID_CAM;
  return map;
}
