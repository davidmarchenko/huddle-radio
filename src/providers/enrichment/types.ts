/**
 * Enrichment providers fetch non-play-by-play context (fan reactions,
 * deep stats, news blurbs, AI-grounded storyline) that the aggregator
 * dedupes and threads into the commentary prompt. The aggregator is
 * the SOLE consumer — engine code never calls a provider directly.
 *
 * Design notes:
 *
 *   - `gather` takes a `deadlineMs` because we race providers in
 *     parallel against a tick budget; a slow Wikipedia or Reddit
 *     search shouldn't delay the whole turn. Providers are expected
 *     to honour the deadline (use AbortController + Promise.race
 *     against a timer) and return whatever they have, possibly empty.
 *
 *   - Providers MUST never throw past their public surface. Wrap I/O
 *     in try/catch and return [] on failure — the aggregator uses
 *     `Promise.allSettled` but a thrown rejection still costs us a
 *     log line. Bad creds, missing env, 429s → return [] silently;
 *     log once at startup if the provider is disabled by config.
 *
 *   - `id` returned must be stable + unique within the source so the
 *     aggregator's identity-dedup pass can detect repeats across
 *     ticks (we re-poll every 30s; same Reddit comment shouldn't
 *     surface twice as a new signal).
 */

import type { EnrichmentSignal, ProviderHealth, SportsGameState } from "../../shared/contracts";

export type EnrichmentProvider = {
  /** Stable id used for cache keys + trust ranking. */
  id: string;
  /** Human label for diagnostics. */
  label: string;
  /** Returns signals for the current game state, never throws. Empty
   *  array is the correct response on any failure mode. */
  gather(input: { game: SportsGameState; deadlineMs: number }): Promise<EnrichmentSignal[]>;
  /** Lightweight reachability check — pinged by the producer panel
   *  health endpoint. Should be fast (well under a second) and must
   *  not consume meaningful upstream quota. Returns `disabled` when
   *  the provider is intentionally off (missing config, etc). */
  health(): Promise<ProviderHealth>;
};

/** Source-trust ranking used by the aggregator when two signals
 *  collide. Higher number wins. Official deep stats outrank social
 *  takes; beat reporters outrank random fans. New providers slot
 *  in here when added. */
export const SOURCE_TRUST: Record<EnrichmentSignal["source"], number> = {
  "nba-stats": 100,
  "mlb-stats": 100,
  "nhl-stats": 100,
  /** Vision color — the model literally saw it in this tick's frame.
   *  Higher trust than third-party news because it's first-party
   *  observation tied to the current moment. Outranks callbacks
   *  because what's visible RIGHT NOW beats a stale prior take. */
  vision: 85,
  /** Cross-show callbacks are very high-trust because they're
   *  literally things the show's own hosts said — when one matches
   *  the current play, we want it to outrank fan reactions and most
   *  news. */
  callback: 75,
  "espn-news": 70,
  perplexity: 65,
  wiki: 60,
  bluesky: 40,
  reddit: 35
};
