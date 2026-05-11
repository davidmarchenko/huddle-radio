import type { HostId, ProviderHealth, TTSAudioChunk, TTSProvider } from "../shared/contracts";
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
    private readonly hostVoiceMap: InworldHostVoiceMap = {}
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
      temperature: 1.0
    });

    const MAX_ATTEMPTS = 3;
    let response: Response | undefined;
    let lastDetail = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      response = await fetch("https://api.inworld.ai/tts/v1/voice", {
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
      if (response.ok) break;
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
    if (!response || !response.ok) {
      throw new Error(
        `Inworld TTS failed: HTTP ${response?.status ?? "unknown"}${lastDetail ? `: ${lastDetail}` : ""}`
      );
    }

    // Inworld returns JSON with audioContent as a base64 string (NOT
    // raw bytes like ElevenLabs HTTP). The audioContent is already
    // base64 — no double-encoding needed.
    const payload = (await response.json()) as { audioContent?: string };
    if (!payload.audioContent) {
      throw new Error("Inworld TTS returned no audioContent.");
    }
    yield {
      id: crypto.randomUUID(),
      commentaryId: input.commentaryId,
      provider: this.id,
      mimeType: "audio/mpeg",
      base64Audio: payload.audioContent,
      isFinal: true,
      latencyMs: Math.round(performance.now() - start)
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
