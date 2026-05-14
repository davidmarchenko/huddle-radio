/**
 * Pure function that turns a per-tick VideoObservation into
 * EnrichmentSignal[]. Not an EnrichmentProvider — vision data is
 * already fetched once per tick by the engine (the
 * MultimodalModelProvider runs inline, not on a separate poll), so
 * routing it through the provider/aggregator interface would mean
 * fetching twice. Instead we extract on the engine side and merge
 * into the aggregator via its `additionalSignals` channel.
 *
 * The extractor is conservative: only `validation.status ===
 * "sports-event"` observations contribute color (otherwise the
 * model is uncertain about what it's looking at and any color it
 * volunteered is unreliable). Generic phrases ("scoreboard
 * visible", "field markings", "stadium with crowd") are filtered —
 * they're frame-validation evidence, not commentary color.
 *
 * Each color note becomes one signal. The score blends the
 * observation's overall confidence with the note's specificity
 * (longer / more verb-heavy notes score slightly higher because
 * they're more usable as commentary).
 */

import type { EnrichmentSignal, SportsGameState, VideoObservation } from "../../shared/contracts";

const GENERIC_PHRASE_RE =
  /^(scoreboard|field markings|stadium|crowd|jersey|uniforms?|wide shot|broadcast graphic|game in progress|sports event|football game|basketball game|baseball game|hockey game)$/i;

const ACTION_VERBS_RE = /\b(running|sprinting|jumping|diving|tackling|colliding|cheering|celebrating|crying|gripping|limping|pointing|yelling|laughing|kneeling|standing|sitting|hugging|fist[- ]?pumping|head[- ]?down|holding)\b/i;

export function extractVisionSignals(
  observation: VideoObservation | undefined,
  game: SportsGameState
): EnrichmentSignal[] {
  if (!observation) return [];
  // Only emit color from confident sports-event frames. Uncertain /
  // not-sports / unavailable frames are observability noise, not
  // commentary fodder.
  if (observation.validation?.status !== "sports-event") return [];
  const notes = observation.color ?? [];
  if (notes.length === 0) return [];

  const teamRefHint = game.currentPlay?.team;
  const out: EnrichmentSignal[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < notes.length; i += 1) {
    const note = notes[i].trim();
    if (note.length < 8) continue;
    if (note.length > 200) continue;
    if (GENERIC_PHRASE_RE.test(note)) continue;
    const lowered = note.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);

    // Specificity bonus: visual notes with action verbs are more
    // narratable than static descriptors ("crowd standing" beats
    // "crowd visible"). Confidence floors at the model's reported
    // confidence; bonus tops out at +0.15.
    const confidence = observation.confidence ?? 0.5;
    const actionBonus = ACTION_VERBS_RE.test(note) ? 0.15 : 0;
    const score = Math.min(1, confidence * 0.85 + actionBonus);

    out.push({
      // Stable id — the model emits the same color note across
      // multiple ticks of the same shot. Hashing on note text + a
      // 30-second window keeps ticks within the same shot collapsing
      // while letting NEW color (a fresh sideline cut) surface.
      id: `vision-${stableHash(`${note}:${windowKey(observation.observedAt)}`)}`,
      source: "vision",
      kind: "context",
      text: note,
      score,
      occurredAt: observation.observedAt,
      refs: { teamId: teamRefHint }
    });
  }
  return out;
}

/** 30-second windowing — collapses the same color across ticks
 *  that share a shot but lets a new shot generate fresh ids. */
function windowKey(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return String(Math.floor(ms / 30_000));
}

function stableHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
