/**
 * EnrichmentAggregator — fans out to every configured provider in
 * parallel, dedupes the union across two passes (identity + fuzzy),
 * picks winners by source trust, decays old signals, and returns
 * the top N most relevant items for the current tick.
 *
 * Pipeline:
 *
 *   gather() ──fan-out──> [provider.gather() x N]   (Promise.allSettled
 *                            │  │  │                  + per-call deadline)
 *                            ▼  ▼  ▼
 *                          flatten + cache (30s per provider)
 *                            │
 *                            ▼
 *                  Stage 1: identity dedup
 *                  - same id → keep newest
 *                  - same (source, refs.playId) → keep highest score
 *                  - same normalized text → keep highest trust
 *                            │
 *                            ▼
 *                  Stage 2: fuzzy dedup
 *                  - 3-gram Jaccard >= FUZZY_THRESHOLD → merge
 *                  - winner = higher source trust; loser folds in
 *                    as a `voices` entry on the winner
 *                            │
 *                            ▼
 *                  Stage 3: rank + cap
 *                  - score *= recency-decay (5 min half-life)
 *                  - score *= active-play boost (+30% if refs.playId
 *                    matches the latest played id)
 *                  - sort desc, slice to MAX_SIGNALS
 *                            │
 *                            ▼
 *                       returned signals
 *
 * Failure isolation:
 *   - Each provider's promise is wrapped in `Promise.allSettled` so
 *     one rejection doesn't poison the batch. Rejections are logged
 *     once per (providerId, error class) per process to avoid
 *     flooding when a service is down.
 *   - The 30s per-provider cache means the aggregator can still
 *     return signals from ProviderA even when ProviderB is mid-
 *     outage (we serve last known + whatever live providers gave us).
 */

import type { EnrichmentSignal, ProviderHealth, SportsGameState } from "../../shared/contracts";
import { SOURCE_TRUST, type EnrichmentProvider } from "./types";

const PROVIDER_CACHE_MS = 30_000;
const RECENCY_HALF_LIFE_MS = 5 * 60 * 1000;
const ACTIVE_PLAY_BOOST = 1.3;
const MAX_SIGNALS = 15;
const FUZZY_THRESHOLD = 0.7;
/** Stopwords stripped before n-gram comparison. Short, action-neutral
 *  words ("the", "a", "is") inflate Jaccard between unrelated texts. */
const FUZZY_STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "and", "or", "but", "is", "in", "on",
  "at", "for", "with", "by", "from", "this", "that", "it", "its", "as",
  "i", "you", "he", "she", "we", "they", "be", "been", "are", "was",
  "were", "has", "have", "had", "do", "does", "did"
]);

type AggregatorOptions = {
  providers: EnrichmentProvider[];
  /** Override the max signals returned. Default 15. */
  maxSignals?: number;
  /** Override the per-provider cache TTL. Default 30s. */
  providerCacheMs?: number;
  /** Override the recency half-life. Default 5min. */
  recencyHalfLifeMs?: number;
  /** Time source — pluggable for tests. Default Date.now. */
  now?: () => number;
};

type CacheEntry = { fetchedAt: number; signals: EnrichmentSignal[] };

export class EnrichmentAggregator {
  private readonly providers: EnrichmentProvider[];
  private readonly maxSignals: number;
  private readonly providerCacheMs: number;
  private readonly recencyHalfLifeMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  /** One-time-per-error-class log gate to keep a flapping provider
   *  from filling logs every tick. */
  private readonly loggedErrors = new Set<string>();

  constructor(options: AggregatorOptions) {
    this.providers = options.providers;
    this.maxSignals = options.maxSignals ?? MAX_SIGNALS;
    this.providerCacheMs = options.providerCacheMs ?? PROVIDER_CACHE_MS;
    this.recencyHalfLifeMs = options.recencyHalfLifeMs ?? RECENCY_HALF_LIFE_MS;
    this.now = options.now ?? Date.now;
  }

  /** Roll-up health for every configured enrichment provider. Used
   *  by the producer panel + diagnostics endpoint so a flapping
   *  Reddit / Bluesky / etc. shows up alongside fantasy + sports-data
   *  providers.
   *
   *  Enrichment is intentionally non-load-bearing: a Reddit outage
   *  costs us crowd flavor but doesn't affect whether the show can
   *  run. We downgrade upstream `error` → `degraded` here so the
   *  `payload.ok` aggregate (which is gated on no-`error`) stays
   *  truthful: the show CAN run, we're just missing color. The
   *  per-provider detail still surfaces in the producer panel for
   *  ops visibility. */
  async health(): Promise<ProviderHealth[]> {
    const settled = await Promise.allSettled(this.providers.map((p) => p.health()));
    const out: ProviderHealth[] = [];
    for (let i = 0; i < settled.length; i += 1) {
      const result = settled[i];
      const provider = this.providers[i];
      const raw =
        result.status === "fulfilled"
          ? result.value
          : {
              id: provider.id,
              label: provider.label,
              status: "error" as const,
              detail: result.reason instanceof Error ? result.reason.message : String(result.reason)
            };
      out.push({
        ...raw,
        status: raw.status === "error" ? "degraded" : raw.status,
        detail: raw.status === "error" ? `degraded (enrichment is non-blocking): ${raw.detail}` : raw.detail
      });
    }
    return out;
  }

  async gather(input: {
    game: SportsGameState;
    deadlineMs?: number;
    /** Active play ID — signals tied to it get a relevance boost.
     *  Optional; aggregator works fine without. */
    activePlayId?: string;
    /** Pre-fetched signals to merge in alongside provider results.
     *  Used for sources whose data is already available on the
     *  engine side (notably vision color, which the engine has
     *  fetched as part of the per-tick observation). The merged
     *  signals flow through the same dedup + ranking pipeline. */
    additionalSignals?: EnrichmentSignal[];
  }): Promise<EnrichmentSignal[]> {
    const deadlineMs = input.deadlineMs ?? 1_500;
    const fanOut = this.providers.map((provider) => this.gatherFromProvider(provider, input.game, deadlineMs));
    const settled = await Promise.allSettled(fanOut);
    const all: EnrichmentSignal[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") all.push(...result.value);
    }
    if (input.additionalSignals?.length) all.push(...input.additionalSignals);
    const identityDeduped = dedupeByIdentity(all);
    const fuzzyDeduped = dedupeFuzzy(identityDeduped);
    return this.rankAndCap(fuzzyDeduped, input.activePlayId);
  }

  private async gatherFromProvider(
    provider: EnrichmentProvider,
    game: SportsGameState,
    deadlineMs: number
  ): Promise<EnrichmentSignal[]> {
    const cacheKey = `${provider.id}:${game.gameId}`;
    const cached = this.cache.get(cacheKey);
    const now = this.now();
    if (cached && now - cached.fetchedAt < this.providerCacheMs) return cached.signals;
    try {
      const fresh = await Promise.race<EnrichmentSignal[]>([
        provider.gather({ game, deadlineMs }),
        new Promise<EnrichmentSignal[]>((resolve) => {
          setTimeout(() => resolve([]), deadlineMs);
        })
      ]);
      this.cache.set(cacheKey, { fetchedAt: now, signals: fresh });
      return fresh;
    } catch (error) {
      const errorKey = `${provider.id}:${error instanceof Error ? error.name : "unknown"}`;
      if (!this.loggedErrors.has(errorKey)) {
        console.warn(`[enrichment] ${provider.label} failed`, error instanceof Error ? error.message : error);
        this.loggedErrors.add(errorKey);
      }
      return cached?.signals ?? [];
    }
  }

  private rankAndCap(signals: EnrichmentSignal[], activePlayId?: string): EnrichmentSignal[] {
    const now = this.now();
    const scored = signals.map((signal) => {
      const ageMs = Math.max(0, now - new Date(signal.occurredAt).getTime());
      const recencyDecay = Math.pow(0.5, ageMs / this.recencyHalfLifeMs);
      const activeBoost = activePlayId && signal.refs?.playId === activePlayId ? ACTIVE_PLAY_BOOST : 1;
      const trust = SOURCE_TRUST[signal.source] ?? 50;
      // Combine: provider score (0..1) × trust-normalized factor × recency × play-affinity.
      // Trust contributes log-ish so it's a tiebreaker rather than a steamroller — the
      // provider's own engagement signal still drives most of the order.
      const trustFactor = 0.6 + (trust / 100) * 0.4;
      return { signal, weight: signal.score * trustFactor * recencyDecay * activeBoost };
    });
    scored.sort((a, b) => b.weight - a.weight);
    return scored.slice(0, this.maxSignals).map((entry) => entry.signal);
  }
}

/** Stage 1 — identity dedup. Three passes over the input list,
 *  each catching a different category of "obvious duplicate". Order
 *  matters: id collisions are the cheapest to resolve and the most
 *  common (re-poll picks up the same item), so we do them first. */
function dedupeByIdentity(input: EnrichmentSignal[]): EnrichmentSignal[] {
  // Pass A: collapse exact id matches. Newer occurredAt wins.
  const byId = new Map<string, EnrichmentSignal>();
  for (const signal of input) {
    const existing = byId.get(signal.id);
    if (!existing || new Date(signal.occurredAt).getTime() > new Date(existing.occurredAt).getTime()) {
      byId.set(signal.id, signal);
    }
  }
  // Pass B: collapse (source, refs.playId) — same source describing
  // the same play multiple times (e.g. multiple commentary events
  // from one provider for one play). Highest score wins.
  const byPlay = new Map<string, EnrichmentSignal>();
  const passthrough: EnrichmentSignal[] = [];
  for (const signal of byId.values()) {
    const playId = signal.refs?.playId;
    if (!playId) {
      passthrough.push(signal);
      continue;
    }
    const key = `${signal.source}:${playId}`;
    const existing = byPlay.get(key);
    if (!existing || signal.score > existing.score) byPlay.set(key, signal);
  }
  const stage = [...passthrough, ...byPlay.values()];
  // Pass C: collapse exact normalized text — different ids, different
  // sources, same words. Highest source trust wins.
  const byText = new Map<string, EnrichmentSignal>();
  for (const signal of stage) {
    const key = normalizeText(signal.text);
    if (!key) continue;
    const existing = byText.get(key);
    if (!existing || (SOURCE_TRUST[signal.source] ?? 0) > (SOURCE_TRUST[existing.source] ?? 0)) {
      byText.set(key, signal);
    }
  }
  return [...byText.values()];
}

/** Stage 2 — fuzzy dedup via 3-gram Jaccard. Catches "WILSON FROM
 *  DEEP" vs "Wilson hits a three". Loser folds into the winner's
 *  `voices` so the prompt can quote both. O(n²) on the input — fine
 *  for ~50 signals/tick, would need bucketing for ~5000. */
function dedupeFuzzy(input: EnrichmentSignal[]): EnrichmentSignal[] {
  const out: EnrichmentSignal[] = [];
  const usedIndices = new Set<number>();
  for (let i = 0; i < input.length; i += 1) {
    if (usedIndices.has(i)) continue;
    let winner = input[i];
    const winnerGrams = trigrams(winner.text);
    const folded: Array<{ source: EnrichmentSignal["source"]; text: string }> = winner.voices ? [...winner.voices] : [];
    for (let j = i + 1; j < input.length; j += 1) {
      if (usedIndices.has(j)) continue;
      const candidate = input[j];
      const similarity = jaccard(winnerGrams, trigrams(candidate.text));
      if (similarity < FUZZY_THRESHOLD) continue;
      usedIndices.add(j);
      const candidateTrust = SOURCE_TRUST[candidate.source] ?? 0;
      const winnerTrust = SOURCE_TRUST[winner.source] ?? 0;
      if (candidateTrust > winnerTrust) {
        // Candidate outranks current winner — promote and fold the
        // previous winner into the voices list.
        folded.push({ source: winner.source, text: winner.text });
        winner = candidate;
      } else {
        folded.push({ source: candidate.source, text: candidate.text });
      }
    }
    out.push(folded.length > 0 ? { ...winner, voices: folded } : winner);
  }
  return out;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercase, drop URLs/punct, drop stopwords, then build a Set of
 *  3-grams over the remaining tokens (joined as character n-grams).
 *  Returns Set<string> for O(1) intersection in jaccard(). */
function trigrams(text: string): Set<string> {
  const cleaned = normalizeText(text)
    .split(" ")
    .filter((token) => token.length > 0 && !FUZZY_STOPWORDS.has(token))
    .join(" ");
  if (cleaned.length < 3) return new Set([cleaned]);
  const grams = new Set<string>();
  for (let i = 0; i <= cleaned.length - 3; i += 1) {
    grams.add(cleaned.slice(i, i + 3));
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
