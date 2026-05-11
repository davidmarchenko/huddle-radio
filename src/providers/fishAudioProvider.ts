import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import WebSocket from "ws";
import type { HostId, ProviderHealth, TTSAudioChunk, TTSProvider } from "../shared/contracts";
import { config } from "../server/config";

/**
 * Fish Audio S2-Pro TTS provider — experimental alternative to ElevenLabs.
 *
 * Why we care: Fish supports MULTI-SPEAKER dialogue AND true streaming in
 * the same WebSocket. Sub-200ms time-to-first-byte even with three
 * voices in one stream, vs ElevenLabs Text-to-Dialogue which buffers
 * the whole MP3 (~15-30s in practice). The protocol is MessagePack over
 * WebSocket — start event with `reference_id` array, then text events
 * containing `[speaker_0]`, `[speaker_1]`, `[speaker_2]` inline markers
 * to route each segment to the right voice.
 *
 * Off by default. Activate by setting TTS_PROVIDER=fish in env.
 * Lives in its own file so disabling the experiment is a single
 * config flip — no other code changes.
 *
 * Protocol reference: https://docs.fish.audio/api-reference/endpoint/websocket/tts-live
 */

export type FishHostVoiceMap = Partial<Record<HostId, string>>;

export class FishAudioTTSProvider implements TTSProvider {
  id = "fish-audio";

  constructor(
    private readonly apiKey: string | undefined,
    /** Default Fish voice model id used when no per-host override is configured. */
    private readonly defaultVoiceId: string,
    /** Fish model id. s2-pro for multi-speaker dialogue; s2 for single-host streaming. */
    private readonly modelId: string = "s2-pro",
    /**
     * Per-host voice overrides. Each entry is a Fish "model id" (their term
     * for a cloned voice's reference). When set, multi-speaker dialogue uses
     * these as the reference_id array. Single-host calls fall back to the
     * default when a host has no override.
     */
    private readonly hostVoiceMap: FishHostVoiceMap = {}
  ) {}

  private resolveVoiceId(hostId?: HostId): string {
    if (hostId && this.hostVoiceMap[hostId]) return this.hostVoiceMap[hostId]!;
    return this.defaultVoiceId;
  }

  /**
   * Single-host streaming. Yields audio chunks as Fish sends them.
   * For multi-host turn-sets, use synthesizeDialogue instead — it
   * routes voices natively in one WS connection.
   */
  async *synthesize(input: { commentaryId: string; text: string; hostId?: HostId }): AsyncIterable<TTSAudioChunk> {
    if (!this.apiKey) {
      throw new Error("FISH_API_KEY is required when TTS_PROVIDER=fish.");
    }
    const voiceId = this.resolveVoiceId(input.hostId);
    yield* this.runStream({
      commentaryId: input.commentaryId,
      referenceIds: [voiceId],
      text: input.text
    });
  }

  /**
   * Multi-speaker dialogue: ALL turns delivered through ONE WebSocket
   * stream. Fish routes each `[speaker_N]` tag to the matching voice
   * from the `reference_id` array, and turn-taking + inter-speaker
   * pacing is handled by the model. First audio chunk lands in
   * ~150-300ms regardless of turn count.
   */
  async synthesizeDialogue(input: {
    commentaryId: string;
    turns: Array<{ text: string; hostId?: HostId }>;
  }): Promise<TTSAudioChunk> {
    if (!this.apiKey) {
      throw new Error("FISH_API_KEY is required when TTS_PROVIDER=fish.");
    }
    // Stable ordering of unique voices — `[speaker_0]` is the first
    // distinct hostId encountered in the turn list, `[speaker_1]` the
    // second, and so on. This keeps the tag → voice mapping
    // deterministic regardless of which hosts appear in this turn-set.
    const voiceOrder: string[] = [];
    const hostToSpeakerIdx = new Map<string, number>();
    for (const turn of input.turns) {
      const voiceId = this.resolveVoiceId(turn.hostId);
      const hostKey = turn.hostId ?? "default";
      if (!hostToSpeakerIdx.has(hostKey)) {
        hostToSpeakerIdx.set(hostKey, voiceOrder.length);
        voiceOrder.push(voiceId);
      }
    }
    const scriptParts: string[] = [];
    for (const turn of input.turns) {
      const hostKey = turn.hostId ?? "default";
      const speakerIdx = hostToSpeakerIdx.get(hostKey) ?? 0;
      scriptParts.push(`[speaker_${speakerIdx}] ${turn.text}`);
    }
    const fullScript = scriptParts.join(" ");

    // Collect all chunks then concatenate — preserves the same
    // single-chunk contract synthesizeDialogue has elsewhere (caller
    // expects ONE TTSAudioChunk back). Streaming chunks are still
    // useful internally for measuring TTFB.
    const chunks: TTSAudioChunk[] = [];
    for await (const chunk of this.runStream({
      commentaryId: input.commentaryId,
      referenceIds: voiceOrder,
      text: fullScript
    })) {
      chunks.push(chunk);
    }
    if (chunks.length === 0) {
      throw new Error("FishAudio dialogue stream produced no audio chunks.");
    }
    // Concatenate base64 audio. Fish sends raw audio frames per
    // AudioEvent; concatenating the decoded base64s gives a valid
    // MP3 if the format is mp3 (Fish chunks are valid container
    // pieces).
    const combinedBuffer = Buffer.concat(
      chunks.map((c) => Buffer.from(c.base64Audio ?? "", "base64"))
    );
    return {
      id: crypto.randomUUID(),
      commentaryId: input.commentaryId,
      provider: this.id,
      mimeType: "audio/mpeg",
      base64Audio: combinedBuffer.toString("base64"),
      isFinal: true,
      latencyMs: chunks[0].latencyMs
    };
  }

  /**
   * Open a WS to Fish, send start + text + stop, yield each AudioEvent
   * as a TTSAudioChunk. Both `synthesize` and `synthesizeDialogue`
   * route through here — the only difference is how the script
   * (single-speaker text vs `[speaker_N]`-tagged dialogue) and the
   * reference_id list (one vs many) are prepared.
   */
  private async *runStream(input: {
    commentaryId: string;
    referenceIds: string[];
    text: string;
  }): AsyncIterable<TTSAudioChunk> {
    const start = performance.now();
    const socket = new WebSocket("wss://api.fish.audio/v1/tts/live", {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        model: this.modelId
      }
    });

    // Fish wire format is MessagePack-only. ws delivers messages as
    // Buffer; we decode each one and dispatch on `event`.
    const queue: TTSAudioChunk[] = [];
    let done = false;
    let failure: Error | undefined;
    let notify: (() => void) | undefined;
    const ping = () => {
      const cb = notify;
      notify = undefined;
      cb?.();
    };

    const send = (payload: Record<string, unknown>) => {
      try {
        socket.send(msgpackEncode(payload));
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Fish send failed.");
        done = true;
        ping();
      }
    };

    socket.on("open", () => {
      // Start the session. `text: ""` per docs — actual text comes
      // in subsequent TextEvent messages.
      send({
        event: "start",
        request: {
          text: "",
          reference_id: input.referenceIds,
          format: "mp3",
          // chunk_length 300 is the doc default; smaller chunks give
          // earlier first-byte at the cost of slightly more overhead.
          chunk_length: 200,
          latency: "normal",
          temperature: 0.7,
          top_p: 0.7,
          repetition_penalty: 1.2,
          prosody: { speed: 1, volume: 0, normalize_loudness: true }
        }
      });
      send({ event: "text", text: input.text });
      send({ event: "stop" });
    });

    socket.on("message", (data: Buffer) => {
      let payload: { event?: string; audio?: Buffer | Uint8Array; reason?: string } = {};
      try {
        payload = msgpackDecode(data) as typeof payload;
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Fish msgpack decode failed.");
        done = true;
        ping();
        return;
      }
      if (payload.event === "audio" && payload.audio) {
        const audioBuf = Buffer.isBuffer(payload.audio)
          ? payload.audio
          : Buffer.from(payload.audio as Uint8Array);
        queue.push({
          id: crypto.randomUUID(),
          commentaryId: input.commentaryId,
          provider: this.id,
          mimeType: "audio/mpeg",
          base64Audio: audioBuf.toString("base64"),
          isFinal: false,
          latencyMs: Math.round(performance.now() - start)
        });
        ping();
      } else if (payload.event === "finish") {
        // Fish closes after this; reason="stop" is clean, anything else
        // surfaces as a failure so the engine logs it.
        if (payload.reason && payload.reason !== "stop") {
          failure = new Error(`Fish finished with reason "${payload.reason}"`);
        }
        done = true;
        ping();
      }
    });

    socket.on("error", (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      failure = new Error(`Fish WebSocket error: ${detail}`);
      done = true;
      ping();
    });

    socket.on("close", (code, reason) => {
      // Fish sometimes closes without a FinishEvent on transport
      // errors. Surface non-1000 closes as failures unless we already
      // have one from `error` or finish-with-error.
      if (!done && !failure && typeof code === "number" && code !== 1000) {
        const reasonText = reason?.length ? reason.toString() : `code ${code}`;
        failure = new Error(`Fish WebSocket closed: ${reasonText}`);
      }
      done = true;
      ping();
    });

    try {
      while (true) {
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
    } finally {
      // Make sure we don't leave half-open sockets around if the
      // consumer breaks out of the for-await early.
      try { socket.close(); } catch { /* already closed */ }
    }
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Fish Audio TTS",
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey
        ? `Configured for ${this.modelId} WebSocket streaming with native multi-speaker dialogue.`
        : "Set FISH_API_KEY and TTS_PROVIDER=fish to enable."
    };
  }
}

/**
 * Per-host Fish voice IDs from env. Mirrors buildHostVoiceMap for
 * ElevenLabs — kept here (not in showFactories) so the Fish module
 * fully owns its own configuration surface.
 */
export function buildFishHostVoiceMap(): FishHostVoiceMap {
  const map: FishHostVoiceMap = {};
  if (config.FISH_VOICE_ID_MAYA) map.maya = config.FISH_VOICE_ID_MAYA;
  if (config.FISH_VOICE_ID_THEO) map.theo = config.FISH_VOICE_ID_THEO;
  if (config.FISH_VOICE_ID_CAM) map.cam = config.FISH_VOICE_ID_CAM;
  return map;
}
