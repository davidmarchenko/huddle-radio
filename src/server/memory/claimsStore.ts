/**
 * ClaimsStore implementations.
 *
 * Two backends behind the same interface:
 *
 *   - InMemoryClaimsStore — process-local Map. Survives within a
 *     warm Fluid Compute instance, lost on cold start. Default in
 *     dev + tests.
 *   - UpstashClaimsStore — Upstash Redis-backed. Persists across
 *     restarts, shareable across instances. Engaged automatically
 *     when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are
 *     configured (mirrors the sessionRegistry pattern).
 *
 * Schema (Upstash):
 *   key:   huddle:claims:<listenerId>
 *   value: JSON array of Claim (capped at PER_LISTENER_LIMIT)
 *   ttl:   30 days from last write (claims expire by maxAgeMs in
 *          findRelevant anyway, so this is a hard floor for evicting
 *          long-dormant listeners)
 *
 * The single-key-per-listener layout means save() is a get+modify+put
 * — two round trips per write. That's fine at our write rate (one
 * extractor pass per turn, mostly empty). If write volume ever
 * justifies it, switch to a Redis hash with claim-id fields and use
 * HSET for single-RTT writes.
 */

import { Redis } from "@upstash/redis";
import type { Claim, ClaimsStore } from "./types";

const PER_LISTENER_LIMIT = 200;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const DEFAULT_LIMIT = 3;

export class InMemoryClaimsStore implements ClaimsStore {
  private readonly byListener = new Map<string, Claim[]>();

  async save(claim: Claim): Promise<void> {
    const existing = this.byListener.get(claim.listenerId) ?? [];
    // Idempotent: replace if id already present, otherwise append.
    const idx = existing.findIndex((c) => c.id === claim.id);
    if (idx >= 0) {
      existing[idx] = claim;
    } else {
      existing.push(claim);
      // FIFO evict if we've blown the listener cap.
      if (existing.length > PER_LISTENER_LIMIT) {
        existing.splice(0, existing.length - PER_LISTENER_LIMIT);
      }
    }
    this.byListener.set(claim.listenerId, existing);
  }

  async findRelevant(input: {
    listenerId: string;
    playerIds: string[];
    teams: string[];
    maxAgeMs?: number;
    limit?: number;
  }): Promise<Claim[]> {
    const all = this.byListener.get(input.listenerId);
    if (!all || all.length === 0) return [];
    return rankAndFilter(all, input);
  }

  async updateOutcome(input: {
    claimId: string;
    listenerId: string;
    outcome: "right" | "wrong" | "pending";
  }): Promise<void> {
    const bucket = this.byListener.get(input.listenerId);
    if (!bucket) return;
    const idx = bucket.findIndex((c) => c.id === input.claimId);
    if (idx < 0) return;
    bucket[idx] = { ...bucket[idx], outcome: input.outcome };
  }

  async pendingFor(listenerId: string): Promise<Claim[]> {
    const bucket = this.byListener.get(listenerId) ?? [];
    return bucket.filter((c) => c.outcome === "pending" || !c.outcome);
  }

  async listAllForListener(listenerId: string, limit?: number): Promise<Claim[]> {
    const bucket = this.byListener.get(listenerId) ?? [];
    // Newest first — diagnostics readers want the most-recent claims
    // at the top.
    const sorted = [...bucket].sort(
      (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
    );
    return typeof limit === "number" ? sorted.slice(0, limit) : sorted;
  }

  reset(): void {
    this.byListener.clear();
  }
}

/** Shared ranking + filter logic used by both backends — keeps
 *  scoring consistent so swapping in/out doesn't quietly change
 *  which callbacks land in the producer's enrichment slate. */
function rankAndFilter(
  all: Claim[],
  input: {
    playerIds: string[];
    teams: string[];
    maxAgeMs?: number;
    limit?: number;
  }
): Claim[] {
  if (all.length === 0) return [];
  const maxAge = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const cutoffMs = Date.now() - maxAge;
  const playerSet = new Set(input.playerIds);
  const teamSet = new Set(input.teams.map((t) => t.toLowerCase()));
  const candidates: Array<{ claim: Claim; weight: number }> = [];
  for (const claim of all) {
    const capturedMs = new Date(claim.capturedAt).getTime();
    if (Number.isFinite(capturedMs) && capturedMs < cutoffMs) continue;
    const playerHit = claim.anchorPlayerId && playerSet.has(claim.anchorPlayerId);
    const teamHit = claim.anchorTeam && teamSet.has(claim.anchorTeam.toLowerCase());
    if (!playerHit && !teamHit) continue;
    const ageMs = Date.now() - capturedMs;
    // Recency weight in [0, 1]: 1 at capture, decaying linearly to
    // 0 at maxAge. Player hits get a +1 bias because "Wilson is
    // going off" is a more specific callback than "the Storm are
    // alive again."
    const recency = Math.max(0, 1 - ageMs / maxAge);
    const weight = recency + (playerHit ? 1 : 0);
    candidates.push({ claim, weight });
  }
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates.slice(0, limit).map((c) => c.claim);
}

const UPSTASH_KEY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const UPSTASH_KEY_PREFIX = "huddle:claims:";

export class UpstashClaimsStore implements ClaimsStore {
  // Constructor-injected so tests can stub the Upstash REST client
  // without monkey-patching the module — same pattern as
  // UpstashRedisRegistry in sessionRegistry.ts.
  constructor(private readonly redis: Pick<Redis, "get" | "set" | "del">) {}

  async save(claim: Claim): Promise<void> {
    const key = this.key(claim.listenerId);
    const existing = (await this.redis.get<Claim[]>(key)) ?? [];
    const idx = existing.findIndex((c) => c.id === claim.id);
    if (idx >= 0) existing[idx] = claim;
    else existing.push(claim);
    if (existing.length > PER_LISTENER_LIMIT) {
      existing.splice(0, existing.length - PER_LISTENER_LIMIT);
    }
    await this.redis.set(key, existing, { ex: UPSTASH_KEY_TTL_SECONDS });
  }

  async findRelevant(input: {
    listenerId: string;
    playerIds: string[];
    teams: string[];
    maxAgeMs?: number;
    limit?: number;
  }): Promise<Claim[]> {
    const all = (await this.redis.get<Claim[]>(this.key(input.listenerId))) ?? [];
    return rankAndFilter(all, input);
  }

  async updateOutcome(input: {
    claimId: string;
    listenerId: string;
    outcome: "right" | "wrong" | "pending";
  }): Promise<void> {
    const key = this.key(input.listenerId);
    const existing = (await this.redis.get<Claim[]>(key)) ?? [];
    const idx = existing.findIndex((c) => c.id === input.claimId);
    if (idx < 0) return;
    existing[idx] = { ...existing[idx], outcome: input.outcome };
    await this.redis.set(key, existing, { ex: UPSTASH_KEY_TTL_SECONDS });
  }

  async pendingFor(listenerId: string): Promise<Claim[]> {
    const all = (await this.redis.get<Claim[]>(this.key(listenerId))) ?? [];
    return all.filter((c) => c.outcome === "pending" || !c.outcome);
  }

  async listAllForListener(listenerId: string, limit?: number): Promise<Claim[]> {
    const all = (await this.redis.get<Claim[]>(this.key(listenerId))) ?? [];
    const sorted = [...all].sort(
      (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
    );
    return typeof limit === "number" ? sorted.slice(0, limit) : sorted;
  }

  async reset(): Promise<void> {
    // No-op for the typical case (we don't usually want to drop all
    // listener buckets). Tests should construct a stubbed redis with
    // its own reset semantics.
  }

  private key(listenerId: string): string {
    return `${UPSTASH_KEY_PREFIX}${listenerId}`;
  }
}

/** Process-wide singleton — same lifetime as the eval/turnSummaries
 *  ring buffers. Per-show factories should use this rather than
 *  constructing fresh stores so claims survive across show
 *  boundaries.
 *
 *  Upstash backend is engaged automatically when both env vars are
 *  set; otherwise the in-memory backend keeps tests + local dev
 *  working. Same picker pattern as getDefaultSessionRegistry. */
let sharedStore: ClaimsStore | undefined;

export function getSharedClaimsStore(): ClaimsStore {
  if (sharedStore) return sharedStore;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    sharedStore = new UpstashClaimsStore(new Redis({ url, token }));
  } else {
    sharedStore = new InMemoryClaimsStore();
  }
  return sharedStore;
}

/** Test-only — swap the singleton for an isolated instance. */
export function _setSharedClaimsStoreForTests(store: ClaimsStore): void {
  sharedStore = store;
}

export function _resetSharedClaimsStoreForTests(): void {
  sharedStore = new InMemoryClaimsStore();
}
