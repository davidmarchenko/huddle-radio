import type { AudioClip, SportsPlay } from "../shared/contracts";

/**
 * Shape validation for /api/asr/transcribe payloads. Kept in its own
 * module so any future asr endpoints (batch, push-to-talk, recap)
 * share the same predicate + normalization.
 */

export function isAudioClip(value: unknown): value is AudioClip {
  if (!value || typeof value !== "object") return false;
  const clip = value as Partial<AudioClip>;
  return Boolean(
    clip.id &&
    clip.capturedAt &&
    clip.source &&
    typeof clip.mimeType === "string" &&
    typeof clip.dataUrl === "string" &&
    clip.dataUrl.startsWith("data:")
  );
}

export function normalizeAsrPlay(value: unknown): SportsPlay | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<SportsPlay>;
  if (!candidate.id || !candidate.headline || !candidate.score) return undefined;
  return candidate as SportsPlay;
}
