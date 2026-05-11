/**
 * Cross-instance session registry.
 *
 * Background: a `ShowEngine` is a stateful in-process object — it owns
 * timers, AbortControllers, an AsyncEventQueue, and in-flight provider
 * requests. None of that is serializable, so the engine itself MUST
 * live on a single Function instance.
 *
 * Vercel Fluid Compute keeps low-concurrency traffic on the same warm
 * instance the vast majority of the time, but under autoscale or after
 * a cold-start eviction, a follow-up POST (`/api/live/cue`, `frame`,
 * etc.) may land on a different instance than the one running the
 * SSE stream. Without a registry, the second instance can't tell
 * "session never existed" from "session is alive elsewhere", so the
 * miss looks like a 404 and the client silently degrades.
 *
 * The registry's job is just to record "session X exists, owned by
 * instance Y" with a short TTL. Routes use it to:
 *   1. Distinguish 404 (truly unknown) from 410 (wrong instance,
 *      please reconnect).
 *   2. Let the client recover deterministically — startLiveSession
 *      can re-issue the start handshake on 410 and the new session
 *      lands on whichever instance answered the reconnect.
 *
 * Backends:
 *   - MemoryRegistry: single-process default. Fine for `npm run dev`
 *     and for any deploy that pins traffic to one instance.
 *   - UpstashRedisRegistry: REST-backed Upstash. Used automatically
 *     when both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
 *     are set in the environment.
 */

import { Redis } from "@upstash/redis";

export type SessionRegistration = {
  sessionId: string;
  instanceId: string;
  registeredAt: number;
  lastSeenAt: number;
};

export interface SessionRegistry {
  register(sessionId: string, instanceId: string, ttlSeconds: number): Promise<void>;
  lookup(sessionId: string): Promise<SessionRegistration | undefined>;
  heartbeat(sessionId: string, ttlSeconds: number): Promise<void>;
  unregister(sessionId: string): Promise<void>;
  /** Test hook: dump every record. Not part of the production contract. */
  _dumpForTests?(): Promise<SessionRegistration[]>;
}

export class MemoryRegistry implements SessionRegistry {
  // Why a Map plus a parallel timer Map: Map holds the record, the
  // timer Map holds the auto-expire setTimeout so we honor TTL even
  // without an external store. Calling `register` on an existing id
  // resets the timer, mirroring Redis SETEX semantics.
  private readonly records = new Map<string, SessionRegistration>();
  private readonly expirations = new Map<string, ReturnType<typeof setTimeout>>();

  async register(sessionId: string, instanceId: string, ttlSeconds: number): Promise<void> {
    const now = Date.now();
    this.records.set(sessionId, { sessionId, instanceId, registeredAt: now, lastSeenAt: now });
    this.scheduleExpiry(sessionId, ttlSeconds);
  }

  async lookup(sessionId: string): Promise<SessionRegistration | undefined> {
    return this.records.get(sessionId);
  }

  async heartbeat(sessionId: string, ttlSeconds: number): Promise<void> {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.lastSeenAt = Date.now();
    this.scheduleExpiry(sessionId, ttlSeconds);
  }

  async unregister(sessionId: string): Promise<void> {
    this.records.delete(sessionId);
    const timer = this.expirations.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.expirations.delete(sessionId);
    }
  }

  async _dumpForTests(): Promise<SessionRegistration[]> {
    return Array.from(this.records.values());
  }

  private scheduleExpiry(sessionId: string, ttlSeconds: number): void {
    const previous = this.expirations.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.records.delete(sessionId);
      this.expirations.delete(sessionId);
    }, ttlSeconds * 1000);
    // Don't keep the process alive just to tick a registry expiry —
    // sessions naturally clean themselves up on shutdown anyway.
    if (typeof timer.unref === "function") timer.unref();
    this.expirations.set(sessionId, timer);
  }
}

export class UpstashRedisRegistry implements SessionRegistry {
  // The redis instance is constructor-injected so tests can stub the
  // Upstash REST client without monkey-patching the module.
  // Using `unknown` keeps the type narrow without coupling tests to
  // the real `@upstash/redis` Redis class shape.
  constructor(private readonly redis: Pick<Redis, "set" | "get" | "del" | "expire">) {}

  async register(sessionId: string, instanceId: string, ttlSeconds: number): Promise<void> {
    const record: SessionRegistration = {
      sessionId,
      instanceId,
      registeredAt: Date.now(),
      lastSeenAt: Date.now()
    };
    // SETEX semantics via `set` + `ex` — Upstash's typed client
    // serializes the JSON for us.
    await this.redis.set(this.key(sessionId), record, { ex: ttlSeconds });
  }

  async lookup(sessionId: string): Promise<SessionRegistration | undefined> {
    const value = await this.redis.get<SessionRegistration>(this.key(sessionId));
    return value ?? undefined;
  }

  async heartbeat(sessionId: string, ttlSeconds: number): Promise<void> {
    const existing = await this.lookup(sessionId);
    if (!existing) return;
    existing.lastSeenAt = Date.now();
    await this.redis.set(this.key(sessionId), existing, { ex: ttlSeconds });
  }

  async unregister(sessionId: string): Promise<void> {
    await this.redis.del(this.key(sessionId));
  }

  private key(sessionId: string): string {
    // Namespaced so we don't collide with other apps sharing the
    // Upstash instance.
    return `huddle:session:${sessionId}`;
  }
}

let defaultRegistry: SessionRegistry | undefined;

export function getDefaultSessionRegistry(): SessionRegistry {
  if (defaultRegistry) return defaultRegistry;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    defaultRegistry = new UpstashRedisRegistry(new Redis({ url, token }));
  } else {
    defaultRegistry = new MemoryRegistry();
  }
  return defaultRegistry;
}

export function resetDefaultSessionRegistryForTests(registry?: SessionRegistry): void {
  defaultRegistry = registry;
}

/**
 * Stable id for the current Function/Node instance. Survives multiple
 * requests on the same warm instance; differs across instances. Used
 * by the registry to track ownership.
 */
let cachedInstanceId: string | undefined;
export function getInstanceId(): string {
  if (cachedInstanceId) return cachedInstanceId;
  // Vercel Functions expose nothing identifying the worker. We mint
  // a per-process id so two warm instances are distinguishable.
  cachedInstanceId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return cachedInstanceId;
}
