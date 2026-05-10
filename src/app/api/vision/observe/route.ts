import { NextResponse } from "next/server";
import type { FrameValidationResponse } from "@/shared/contracts";
import { createVisionProvider } from "@/server/visionProviderFactory";
import { isVideoFrameSnapshot, normalizeValidationPlay } from "@/server/visionRequest";

/**
 * Single-frame vision analysis. The browser's frame-capture loop
 * (W16) and the YouTube extraction worker (W16.5) both POST one
 * frame at a time here — keeps the surface tiny and the latency
 * predictable.
 *
 * For continuous frame ingestion the caller polls every ~5s; we
 * don't need a streaming response because each frame is its own
 * request/response. The "Nemotron sees" panel (W20) just renders
 * the latest observation as it arrives.
 *
 * Body shape:
 *   {
 *     frame: VideoFrameSnapshot,    // dataUrl + meta
 *     video?: { mode, url? },       // optional source context
 *     play?: SportsPlay             // optional game context for prompt
 *   }
 *
 * Response shape: FrameValidationResponse, identical to the legacy
 * /api/video/validate-frame route so consumers can swap endpoints
 * without changing parsing.
 */

// Node runtime: vision providers use the OpenAI SDK + Buffer for
// dataUrl decoding. Edge runtime is too restrictive.
export const runtime = "nodejs";

// Frames carry base64 image data — we already raised
// serverActions bodySizeLimit in next.config.ts to 8mb. This
// matches the assumption.
export const maxDuration = 60;

type ObservePayload = {
  frame?: unknown;
  video?: { mode?: "stream-url" | "screen-share" | "vod"; url?: string };
  play?: unknown;
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  let body: ObservePayload;
  try {
    body = (await request.json()) as ObservePayload;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  if (!isVideoFrameSnapshot(body.frame)) {
    return NextResponse.json(
      { error: "A valid frame snapshot is required." },
      { status: 400 }
    );
  }

  try {
    const provider = createVisionProvider();
    const observation = await provider.observe({
      video: { mode: body.video?.mode ?? body.frame.source, url: body.video?.url },
      play: normalizeValidationPlay(body.play),
      frame: body.frame
    });
    console.log(JSON.stringify({
      event: "vision.observe.ok",
      validationStatus: observation.validation?.status ?? "unknown",
      confidence: observation.confidence,
      usedFrame: observation.usedFrame ?? false,
      latencyMs: Date.now() - startedAt
    }));
    const payload: FrameValidationResponse = { observation };
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: "vision.observe.failed",
      latencyMs: Date.now() - startedAt,
      error: message
    }));
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
