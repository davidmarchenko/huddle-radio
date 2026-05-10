import { NextResponse } from "next/server";
import type { AsrTranscript } from "@/shared/contracts";
import { createAsrProvider } from "@/server/asrProviderFactory";
import { isAudioClip, normalizeAsrPlay } from "@/server/asrRequest";

/**
 * Single-clip ASR endpoint. The browser captures short audio chunks
 * from screen-share (broadcast) or the mic (W18 voice input) via
 * MediaRecorder and POSTs them here. We send the clip to Nemotron
 * Nano Omni and return a transcript with optional word-level
 * timestamps.
 *
 * Body shape:
 *   {
 *     audio: AudioClip,           // dataUrl + meta
 *     play?: SportsPlay           // optional context for prompt biasing
 *   }
 *
 * Response shape: AsrTranscript
 *
 * Each clip is its own request — no streaming. Clips are short
 * (≤30s) so a single fetch is the lowest-latency path; if we ever
 * need true streaming ASR the Nemotron WebSocket endpoint slots in
 * behind the same provider interface.
 */

// Node runtime: provider uses the OpenAI SDK which depends on Node's
// Buffer for multipart audio. Edge is too restrictive.
export const runtime = "nodejs";

// Generous because audio inference can take longer than vision when
// Nano Omni emits per-word timestamps for a 20-30s clip.
export const maxDuration = 90;

type TranscribePayload = {
  audio?: unknown;
  play?: unknown;
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  let body: TranscribePayload;
  try {
    body = (await request.json()) as TranscribePayload;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  if (!isAudioClip(body.audio)) {
    return NextResponse.json(
      { error: "A valid audio clip is required (id, capturedAt, source, mimeType, dataUrl)." },
      { status: 400 }
    );
  }

  try {
    const provider = createAsrProvider();
    const transcript = await provider.transcribe({
      audio: body.audio,
      play: normalizeAsrPlay(body.play)
    });
    console.log(JSON.stringify({
      event: "asr.transcribe.ok",
      provider: transcript.provider,
      source: body.audio.source,
      chars: transcript.text.length,
      words: transcript.words?.length ?? 0,
      confidence: transcript.confidence ?? 0,
      latencyMs: Date.now() - startedAt
    }));
    // Strip the raw provider response from the wire payload — we
    // only need it for server logs. Keeping it client-side balloons
    // payloads with full chat-completion JSON the UI never reads.
    const { raw: _raw, ...wirePayload } = transcript;
    void _raw;
    const payload: AsrTranscript = wirePayload;
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: "asr.transcribe.failed",
      latencyMs: Date.now() - startedAt,
      error: message
    }));
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
