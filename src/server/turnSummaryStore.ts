import { Redis } from "@upstash/redis";
import type { TurnSummary } from "./turnSummaries";

/**
 * Cross-instance turn-summary store.
 *
 * Background: the per-tick turn summary used to live in an in-memory
 * ring buffer (turnSummaries.ts). That worked in dev (single process)
 * but broke under Vercel Fluid Compute autoscale — `/api/diagnostics/
 * recent-turns` would land on a different instance than the one
 * running the SSE engine, so the diagnostics request saw an empty
 * buffer even though plenty of turns had fired. Vercel log capture
 * is also lossy on long-lived SSE functions, so logs aren't a
 * reliable fallback.
 *
 * Storage shape: a single capped list at `huddle:turn-summaries`.
 * LPUSH inserts the new turn at the head; LTRIM keeps the list
 * bounded; LRANGE 0 N-1 reads newest-first. Mirrors the previous
 * in-memory ring semantics with one less consistency surprise.
 *
 * Backends:
 *   - MemoryTurnSummaryStore: process-local, used in tests and when
 *     no Upstash env vars are set.
 *   - UpstashTurnSummaryStore: REST-backed, used automatically when
 *     both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are
 *     in the env.
 */

const BUFFER_LIMIT = 100;
const REDIS_KEY = "huddle:turn-summaries";

export interface TurnSummaryStore {
  record(summary: TurnSummary): Promise<void>;
  recent(limit: number): Promise<TurnSummary[]>;
  /** Test hook — clears the store. */
  reset(): Promise<void>;
}

export class MemoryTurnSummaryStore implements TurnSummaryStore {
  private readonly buffer: TurnSummary[] = [];

  async record(summary: TurnSummary): Promise<void> {
    this.buffer.push(summary);
    if (this.buffer.length > BUFFER_LIMIT) {
      this.buffer.splice(0, this.buffer.length - BUFFER_LIMIT);
    }
  }

  async recent(limit: number): Promise<TurnSummary[]> {
    const clamped = Math.max(1, Math.min(BUFFER_LIMIT, Math.floor(limit)));
    return this.buffer.slice(-clamped).reverse();
  }

  async reset(): Promise<void> {
    this.buffer.length = 0;
  }
}

export class UpstashTurnSummaryStore implements TurnSummaryStore {
  // Same `Pick<>` pattern as UpstashRedisRegistry — narrow the type
  // so tests can stub the client without coupling to the real
  // Upstash SDK shape.
  constructor(private readonly redis: Pick<Redis, "lpush" | "ltrim" | "lrange" | "del">) {}

  async record(summary: TurnSummary): Promise<void> {
    // Upstash's typed client serializes objects to JSON on LPUSH.
    // We LTRIM immediately after to cap the list at BUFFER_LIMIT —
    // running them as separate calls is fine because we read
    // newest-first, so a transient over-cap doesn't surface to
    // callers.
    await this.redis.lpush(REDIS_KEY, summary as unknown as string);
    await this.redis.ltrim(REDIS_KEY, 0, BUFFER_LIMIT - 1);
  }

  async recent(limit: number): Promise<TurnSummary[]> {
    const clamped = Math.max(1, Math.min(BUFFER_LIMIT, Math.floor(limit)));
    // LRANGE returns head-to-tail. Since LPUSH inserts at the head,
    // index 0 is the newest record — exactly what callers want.
    const raw = await this.redis.lrange<TurnSummary>(REDIS_KEY, 0, clamped - 1);
    // The Upstash typed client deserializes JSON automatically when
    // a type parameter is supplied. Older entries written by an
    // earlier shape are tolerated — TypeScript can't enforce that;
    // callers should treat unknown fields as optional.
    return raw ?? [];
  }

  async reset(): Promise<void> {
    await this.redis.del(REDIS_KEY);
  }
}

let defaultStore: TurnSummaryStore | undefined;

export function getDefaultTurnSummaryStore(): TurnSummaryStore {
  if (defaultStore) return defaultStore;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    defaultStore = new UpstashTurnSummaryStore(new Redis({ url, token }));
  } else {
    defaultStore = new MemoryTurnSummaryStore();
  }
  return defaultStore;
}

/** Test hook to inject a custom store (e.g. a fake Upstash client). */
export function setDefaultTurnSummaryStoreForTests(store: TurnSummaryStore | undefined): void {
  defaultStore = store;
}
