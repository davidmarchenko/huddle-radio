import OpenAI from "openai";
import type { AsrProvider, AsrTranscript, AsrWord, AudioClip, ProviderHealth, SportsPlay } from "../shared/contracts";
import { dataUrlToBase64 } from "./visionShared";

/**
 * Nemotron Nano Omni ASR provider.
 *
 * Uses the same Nvidia OpenAI-compatible endpoint as the vision
 * provider — Nano Omni is omni-modal so audio rides through
 * chat.completions with an `input_audio` content part. We ask the
 * model to return JSON containing the plain transcript plus
 * word-level timestamps (Nano Omni's headline ASR feature) so the
 * "Clip-it" workstream (W21) can render karaoke-style subtitles
 * without a second pass.
 *
 * Audio chunks come in as data URLs from MediaRecorder
 * (audio/webm;codecs=opus by default). We strip the prefix and pass
 * the base64 payload + a Nvidia-recognised format string. WebM/Opus
 * is the lowest-latency capture format the browser produces; the
 * Nvidia ASR pipeline accepts it directly.
 */

const ASR_INSTRUCTIONS =
  "You transcribe a short clip of sports broadcast or microphone audio for a live fantasy show. Return only compact JSON. Do NOT invent commentary. If the audio is silence or unintelligible noise, return an empty transcript with confidence 0.";

const MAX_OUTPUT_TOKENS = 600;

function inferAudioFormat(mimeType: string, dataUrl: string): string {
  // Nvidia/OpenAI accept "wav" | "mp3" | "ogg" | "flac" | "webm" | "m4a".
  // MediaRecorder defaults to "audio/webm;codecs=opus".
  const lowered = (mimeType || "").toLowerCase();
  if (lowered.includes("webm")) return "webm";
  if (lowered.includes("ogg")) return "ogg";
  if (lowered.includes("wav")) return "wav";
  if (lowered.includes("mp3") || lowered.includes("mpeg")) return "mp3";
  if (lowered.includes("m4a") || lowered.includes("mp4") || lowered.includes("aac")) return "m4a";
  if (lowered.includes("flac")) return "flac";
  // Fall back to the mediaType embedded in the data URL prefix.
  const prefix = dataUrl.match(/^data:audio\/([^;]+)/)?.[1]?.toLowerCase();
  if (prefix?.includes("webm")) return "webm";
  if (prefix === "ogg" || prefix === "wav" || prefix === "mp3" || prefix === "flac" || prefix === "m4a") return prefix;
  return "webm";
}

function buildAsrTaskPayload(audio: AudioClip, play?: SportsPlay): string {
  const context = play
    ? {
        currentPlay: {
          type: play.type,
          headline: play.headline,
          team: play.team,
          quarter: play.quarter,
          clock: play.clock,
          score: play.score
        },
        rosterHints: Array.isArray(play.playerIds) ? play.playerIds.slice(0, 8) : []
      }
    : null;
  return JSON.stringify({
    task:
      audio.source === "microphone"
        ? "Transcribe the listener's spoken request to the show host."
        : "Transcribe the broadcast audio for the on-screen sporting event.",
    durationMs: audio.durationMs,
    context,
    requiredJsonShape: {
      text: "plain transcript with normal casing and light punctuation",
      language: "BCP-47 tag e.g. en",
      confidence: "number 0..1",
      words: "array of {text, startMs, endMs, confidence?} with timestamps in milliseconds from the start of the clip"
    }
  });
}

type AsrPayload = {
  text?: string;
  language?: string;
  confidence?: number;
  words?: Array<{ text?: string; startMs?: number; endMs?: number; confidence?: number }>;
};

function clamp01(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function parseAsrPayload(raw: string): AsrPayload {
  const trimmed = raw.trim();
  const jsonText = trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  try {
    const parsed = JSON.parse(jsonText) as AsrPayload;
    return parsed;
  } catch {
    return { text: trimmed.slice(0, 1000), confidence: 0.3 };
  }
}

function normalizeWords(words: AsrPayload["words"]): AsrWord[] | undefined {
  if (!Array.isArray(words) || words.length === 0) return undefined;
  const cleaned = words
    .map<AsrWord | undefined>((w) => {
      const text = typeof w?.text === "string" ? w.text.trim() : "";
      const startMs = Number(w?.startMs);
      const endMs = Number(w?.endMs);
      if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
      return {
        text,
        startMs: Math.max(0, Math.round(startMs)),
        endMs: Math.max(0, Math.round(endMs)),
        confidence: clamp01(w?.confidence)
      };
    })
    .filter((w): w is AsrWord => Boolean(w));
  return cleaned.length ? cleaned : undefined;
}

export class NemotronAsrProvider implements AsrProvider {
  id = "nemotron-asr";
  private readonly client?: OpenAI;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    private readonly baseUrl = "https://integrate.api.nvidia.com/v1",
    fetcher?: typeof fetch
  ) {
    this.client = apiKey
      ? new OpenAI({
          apiKey,
          baseURL: baseUrl,
          fetch: fetcher as unknown as OpenAI["fetch"]
        })
      : undefined;
  }

  async transcribe(input: { audio: AudioClip; play?: SportsPlay }): Promise<AsrTranscript> {
    const start = performance.now();
    const observedAt = new Date().toISOString();

    if (!this.client) {
      return {
        id: cryptoUuid(),
        text: "",
        provider: this.id,
        observedAt,
        latencyMs: Math.round(performance.now() - start),
        confidence: 0,
        raw: { reason: "No NEMOTRON_API_KEY configured." }
      };
    }
    if (!input.audio?.dataUrl) {
      return {
        id: cryptoUuid(),
        text: "",
        provider: this.id,
        observedAt,
        latencyMs: Math.round(performance.now() - start),
        confidence: 0,
        raw: { reason: "Audio clip missing dataUrl." }
      };
    }

    try {
      const { data } = dataUrlToBase64(input.audio.dataUrl);
      const format = inferAudioFormat(input.audio.mimeType, input.audio.dataUrl);

      // Use chat.completions for parity with the vision provider so
      // both modalities live behind one model + one billing account.
      // The OpenAI SDK doesn't yet ship a typed `input_audio` content
      // part for chat.completions, so we cast the message payload —
      // the wire format is what Nvidia's gateway expects regardless.
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.0,
        messages: [
          { role: "system", content: ASR_INSTRUCTIONS },
          {
            role: "user",
            content: [
              { type: "text", text: buildAsrTaskPayload(input.audio, input.play) },
              {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                type: "input_audio" as any,
                input_audio: { data, format }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any
            ]
          }
        ]
      });

      const text = response.choices?.[0]?.message?.content ?? "";
      const flat = typeof text === "string" ? text : JSON.stringify(text);
      const payload = parseAsrPayload(flat);
      const words = normalizeWords(payload.words);
      const transcriptText = (payload.text ?? "").trim();
      return {
        id: cryptoUuid(),
        text: transcriptText,
        words,
        language: typeof payload.language === "string" ? payload.language : undefined,
        confidence: clamp01(payload.confidence) ?? (transcriptText ? 0.7 : 0),
        provider: this.id,
        observedAt,
        latencyMs: Math.round(performance.now() - start),
        raw: response
      };
    } catch (error) {
      return {
        id: cryptoUuid(),
        text: "",
        provider: this.id,
        observedAt,
        latencyMs: Math.round(performance.now() - start),
        confidence: 0,
        raw: { error: error instanceof Error ? error.message : String(error) }
      };
    }
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Nemotron Nano Omni ASR",
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey
        ? `Configured for audio transcription with ${this.model} via ${this.baseUrl}.`
        : "Set NEMOTRON_API_KEY (NVIDIA build.nvidia.com key) to enable Nemotron Nano Omni ASR."
    };
  }
}

function cryptoUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `asr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
