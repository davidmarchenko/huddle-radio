import { NextResponse } from "next/server";
import { createAsrProvider } from "@/server/asrProviderFactory";
import { isAudioClip, normalizeAsrPlay } from "@/server/asrRequest";
import { buildWebVtt } from "@/shared/webvtt";

/**
 * W21: Subtitles for the "Clip-it" share flow.
 *
 * Accepts a short audio clip (typically the TTS audio from a single
 * commentary turn), runs it through Nemotron Nano Omni ASR, and
 * returns a WebVTT track plus the raw word array. The client can
 * either attach the VTT to a `<track>` element on the share page or
 * burn-in captions for a video export.
 *
 * Why this lives outside /api/asr/transcribe: it formats the result
 * specifically for sharing (WebVTT + a stable filename) and may
 * later host the .vtt as its own Blob URL; keeping the surfaces
 * separate avoids overloading the raw transcription endpoint with
 * caption-formatting concerns.
 *
 * Body shape:
 *   {
 *     audio: AudioClip,           // dataUrl + meta
 *     play?: SportsPlay           // optional context for prompt biasing
 *   }
 *
 * Response shape:
 *   {
 *     transcriptId: string,
 *     text: string,
 *     vtt: string,
 *     words: AsrWord[],
 *     latencyMs: number
 *   }
 */

export const runtime = "nodejs";
export const maxDuration = 90;

type SubtitlesPayload = {
  audio?: unknown;
  play?: unknown;
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  let body: SubtitlesPayload;
  try {
    body = (await request.json()) as SubtitlesPayload;
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
    const words = transcript.words ?? [];
    const vtt = buildWebVtt(words);
    console.log(JSON.stringify({
      event: "clip.subtitles.ok",
      provider: transcript.provider,
      chars: transcript.text.length,
      words: words.length,
      cues: vtt.split("\n\n").length - 1,
      latencyMs: Date.now() - startedAt
    }));
    return NextResponse.json({
      transcriptId: transcript.id,
      text: transcript.text,
      vtt,
      words,
      latencyMs: Date.now() - startedAt
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: "clip.subtitles.failed",
      latencyMs: Date.now() - startedAt,
      error: message
    }));
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
