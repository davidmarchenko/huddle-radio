import type { SportsPlay, StreamValidation, VideoFrameSnapshot, VideoObservation, VideoSourceConfig } from "../shared/contracts";

export type VisionPayload = {
  isSportsEvent?: boolean;
  sport?: StreamValidation["sport"];
  confidence?: number;
  summary?: string;
  evidence?: string[];
  reason?: string;
  /** Visual color the model noticed worth narrating — bench
   *  reactions, body language, sideline drama, crowd intensity.
   *  Empty/absent on most frames (generic shots have no distinctive
   *  color). The aggregator consumes this via VisionEnrichmentProvider. */
  color?: string[];
};

export const VISION_INSTRUCTIONS =
  "You validate a user-provided sports stream frame for a fantasy livecast. Return only compact JSON. Determine whether the image appears to show a live or replayed sporting event. Do not infer official stats. Official play-by-play is the source of truth.";

/**
 * Same JSON payload every vision provider asks the model to fill out.
 * Shared across vendors so the parser/validator paths can stay generic.
 */
export function buildVisionTaskPayload(play: SportsPlay): string {
  return JSON.stringify({
    task: "Validate if this frame is a sporting event and describe only visible context useful for commentary.",
    currentPlay: {
      type: play.type,
      headline: play.headline,
      description: play.description,
      score: play.score,
      clock: play.clock,
      quarter: play.quarter
    },
    requiredJsonShape: {
      isSportsEvent: "boolean",
      sport: "football|basketball|baseball|soccer|hockey|other",
      confidence: "number 0..1",
      summary: "one short sentence",
      evidence: "array of 1-4 visible clues",
      reason: "short explanation",
      color:
        "array of 0-3 SHORT phrases (5-12 words each) describing visible color worth narrating in commentary: bench reactions, body language, sideline drama, crowd intensity, coach demeanor, jersey/fashion details. Skip generic frames — empty array is the correct answer when the shot is a wide field view, scoreboard, or anything without distinctive human moments. Be concrete and visual: 'star player limping back to bench gripping his hamstring' beats 'player looks tired'."
    }
  });
}

export function parseVisionPayload(text: string): VisionPayload {
  const trimmed = text.trim();
  const jsonText = trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  try {
    const parsed = JSON.parse(jsonText) as VisionPayload;
    return {
      ...parsed,
      confidence: clampConfidence(parsed.confidence),
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String).slice(0, 4) : [],
      color: Array.isArray(parsed.color)
        ? parsed.color.map(String).map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 3)
        : []
    };
  } catch {
    return {
      isSportsEvent: undefined,
      confidence: 0.25,
      summary: trimmed.slice(0, 240),
      evidence: [],
      reason: "Model returned non-JSON validation text."
    };
  }
}

export function unavailableObservation(video: VideoSourceConfig, frame: VideoFrameSnapshot | undefined, start: number): VideoObservation {
  const reason = frame?.blockedReason ?? "No browser frame has been captured yet.";
  return {
    id: cryptoUuid(),
    source: video.mode,
    summary: reason,
    confidence: 0,
    observedAt: new Date().toISOString(),
    latencyMs: Math.round(performance.now() - start),
    usedFrame: false,
    validation: {
      status: "unavailable",
      confidence: 0,
      evidence: [reason],
      reason,
      validatedAt: new Date().toISOString(),
      frameAgeMs: frame ? Date.now() - Date.parse(frame.capturedAt) : undefined
    }
  };
}

export function validationFromPayload(payload: VisionPayload, frame: VideoFrameSnapshot): StreamValidation {
  const confidence = clampConfidence(payload.confidence);
  const status: StreamValidation["status"] =
    payload.isSportsEvent === true && confidence >= 0.62
      ? "sports-event"
      : payload.isSportsEvent === false && confidence >= 0.62
        ? "not-sports"
        : "uncertain";
  return {
    status,
    confidence,
    sport: payload.sport,
    evidence: payload.evidence?.length ? payload.evidence : ["Model inspected the captured frame."],
    reason: payload.reason || payload.summary || "Frame validation completed.",
    validatedAt: new Date().toISOString(),
    frameAgeMs: Date.now() - Date.parse(frame.capturedAt)
  };
}

export function buildSuccessfulObservation(
  payload: VisionPayload,
  input: { video: VideoSourceConfig; frame: VideoFrameSnapshot },
  start: number
): VideoObservation {
  const validation = validationFromPayload(payload, input.frame);
  return {
    id: cryptoUuid(),
    source: input.video.mode,
    summary: payload.summary || validation.reason,
    confidence: validation.confidence,
    observedAt: new Date().toISOString(),
    latencyMs: Math.round(performance.now() - start),
    validation,
    usedFrame: true,
    color: payload.color ?? []
  };
}

export function buildFailedObservation(
  base: VideoObservation,
  error: unknown,
  start: number
): VideoObservation {
  return {
    ...base,
    summary: error instanceof Error ? `Vision validation failed: ${error.message}` : "Vision validation failed.",
    latencyMs: Math.round(performance.now() - start),
    validation: {
      ...(base.validation ?? {
        status: "unavailable",
        confidence: 0,
        evidence: [],
        reason: "Vision validation failed.",
        validatedAt: new Date().toISOString()
      }),
      status: "unavailable",
      reason: error instanceof Error ? error.message : "Vision request failed.",
      evidence: ["The frame was captured but the model request did not complete."]
    }
  };
}

export function clampConfidence(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value ?? 0.25);
  if (!Number.isFinite(number)) return 0.25;
  return Math.max(0, Math.min(1, number));
}

function cryptoUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `obs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function dataUrlToBase64(dataUrl: string): { mediaType: string; data: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) {
    return { mediaType: "image/jpeg", data: dataUrl };
  }
  return { mediaType: match[1], data: match[2] };
}
