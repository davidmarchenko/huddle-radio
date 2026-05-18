import type { SportsPlay, VideoFrameSnapshot } from "../shared/contracts";

/**
 * Shared request-validation + default-play helpers for any
 * frame-analysis endpoint. Both the legacy Fastify route
 * (/api/video/validate-frame) and the new Next.js Route Handler
 * (POST /api/vision/observe) call these so request shape stays
 * consistent across the migration.
 */

export function isVideoFrameSnapshot(value: unknown): value is VideoFrameSnapshot {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<VideoFrameSnapshot>;
  return Boolean(
    frame.id &&
    frame.capturedAt &&
    frame.source &&
    typeof frame.width === "number" &&
    typeof frame.height === "number" &&
    (frame.dataUrl || frame.blockedReason)
  );
}

export function normalizeValidationPlay(value: unknown): SportsPlay {
  const candidate = value as Partial<SportsPlay> | undefined;
  if (candidate?.id && candidate.headline && candidate.description && candidate.score) {
    return candidate as SportsPlay;
  }
  return {
    id: "manual-validation",
    type: "other",
    excitement: 1,
    clock: "n/a",
    period: { number: 0, kind: "quarter", shortDetail: "Validation" },
    possession: "n/a",
    headline: "Manual stream validation",
    description: "Manual frame validation outside a live play tick.",
    playerIds: [],
    team: "n/a",
    score: { away: 0, home: 0 },
    occurredAt: new Date().toISOString()
  };
}
