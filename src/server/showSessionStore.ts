import { ShowEngine } from "./showEngine";
import {
  getDefaultSessionRegistry,
  getInstanceId,
  type SessionRegistry
} from "./sessionRegistry";

/**
 * In-process session store for the SSE-based live show.
 *
 * The companion POST routes (`/api/live/{frame,cue,nudge,stop}`) need
 * to find the same ShowEngine instance the SSE GET (`/api/live/stream`)
 * is attached to. Engines hold timers, AbortControllers, and an
 * AsyncEventQueue — none serializable — so they live on whichever
 * Function instance ran `/api/live/start`.
 *
 * Multi-instance correctness is provided by the SessionRegistry: every
 * registerSession also publishes the session id + the current
 * instance id to the registry. If a follow-up POST hits a different
 * instance and misses the local Map, the route consults the registry
 * to distinguish "session never existed" (404) from "session lives
 * elsewhere — please reconnect" (410). The client handles 410 by
 * restarting the session; the new start handshake lands on whichever
 * instance answered, restoring affinity.
 *
 * Sessions self-expire if the SSE GET never attaches: once started,
 * the engine has GRACE_MS to attract a consumer; otherwise it's
 * stopped + evicted to keep idle resources from leaking.
 */

type Entry = {
  engine: ShowEngine;
  createdAt: number;
  /** True once the SSE GET attached + began consuming events. */
  consumed: boolean;
  /** When the consumer disconnects, we set this so a quick reconnect can be detected (currently unused — the engine just stops). */
  detachedAt?: number;
  /** Repeating heartbeat that keeps the registry record alive. */
  heartbeat?: ReturnType<typeof setInterval>;
};

const SESSIONS = new Map<string, Entry>();

/** How long to wait for the SSE GET to attach before reaping a started session. */
const ATTACH_GRACE_MS = 30_000;

/** How long an engine can sit detached before we stop it for good. */
const DETACH_GRACE_MS = 5_000;

/** Registry TTL — keep generous so a brief network blip doesn't expire a live session, but short enough that an orphaned record doesn't linger. */
const REGISTRY_TTL_SECONDS = 60;

/** Heartbeat cadence — refresh ownership well before the TTL expires. */
const REGISTRY_HEARTBEAT_MS = 20_000;

function newSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function registry(): SessionRegistry {
  return getDefaultSessionRegistry();
}

export async function registerSession(engine: ShowEngine): Promise<string> {
  const id = newSessionId();
  const entry: Entry = { engine, createdAt: Date.now(), consumed: false };
  SESSIONS.set(id, entry);
  // Publish ownership to the registry so cross-instance lookups
  // succeed. Failure here is non-fatal — we still register locally and
  // the engine will work for in-instance follow-ups; cross-instance
  // routing just degrades to silent 404 in that window.
  try {
    await registry().register(id, getInstanceId(), REGISTRY_TTL_SECONDS);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "session.registry.register.failed",
      sessionId: id,
      error: error instanceof Error ? error.message : String(error)
    }));
  }
  // Heartbeat so the registry record outlives the initial TTL while
  // the engine is still ticking. Cleared in destroySession + the reaper.
  entry.heartbeat = setInterval(() => {
    void registry().heartbeat(id, REGISTRY_TTL_SECONDS).catch(() => undefined);
  }, REGISTRY_HEARTBEAT_MS);
  if (typeof entry.heartbeat.unref === "function") entry.heartbeat.unref();
  // Reaper: if no SSE GET attaches within the grace window, stop the
  // engine so it doesn't keep ticking against ESPN / Nemotron / etc.
  setTimeout(() => {
    const current = SESSIONS.get(id);
    if (!current || current.consumed) return;
    teardown(id);
  }, ATTACH_GRACE_MS);
  return id;
}

export function getSession(id: string): ShowEngine | undefined {
  return SESSIONS.get(id)?.engine;
}

export type SessionLookup =
  | { kind: "local"; engine: ShowEngine }
  | { kind: "remote"; instanceId: string }
  | { kind: "missing" };

/**
 * Look up a session with cross-instance awareness. Routes use this to
 * decide between 200 (local hit), 410 (remote — client should
 * reconnect), and 404 (truly unknown).
 */
export async function getSessionWithRoutingHint(id: string): Promise<SessionLookup> {
  const local = SESSIONS.get(id)?.engine;
  if (local) return { kind: "local", engine: local };
  let remote;
  try {
    remote = await registry().lookup(id);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "session.registry.lookup.failed",
      sessionId: id,
      error: error instanceof Error ? error.message : String(error)
    }));
    remote = undefined;
  }
  if (!remote) return { kind: "missing" };
  if (remote.instanceId === getInstanceId()) {
    // The registry says we own it, but our local Map doesn't have it.
    // Means the engine was reaped (DETACH_GRACE_MS elapsed) or the
    // process restarted between register + lookup. Treat as missing.
    return { kind: "missing" };
  }
  return { kind: "remote", instanceId: remote.instanceId };
}

export function markSessionConsumed(id: string): void {
  const entry = SESSIONS.get(id);
  if (!entry) return;
  entry.consumed = true;
  entry.detachedAt = undefined;
}

export function markSessionDetached(id: string): void {
  const entry = SESSIONS.get(id);
  if (!entry) return;
  entry.detachedAt = Date.now();
  // Give a brief grace period in case the client immediately reconnects
  // (e.g. an SSE retry after a transient network blip). If no
  // reattach, the engine + session go away.
  setTimeout(() => {
    const current = SESSIONS.get(id);
    if (!current || !current.detachedAt) return;
    if (Date.now() - current.detachedAt < DETACH_GRACE_MS) return;
    teardown(id);
  }, DETACH_GRACE_MS + 100);
}

export function destroySession(id: string): void {
  teardown(id);
}

export function sessionCount(): number {
  return SESSIONS.size;
}

/** Test-only: nuke all sessions. */
export function resetSessionStoreForTests(): void {
  for (const id of Array.from(SESSIONS.keys())) teardown(id);
}

/**
 * Maps a SessionLookup result onto an HTTP response. Routes call this
 * to keep the local-vs-remote-vs-missing branches identical across
 * all four POSTs (`cue`, `frame`, `nudge`, `stop`).
 *
 * Status mapping:
 *   - local  → return undefined; caller proceeds with engine.
 *   - remote → 410 Gone with `{ code: "WRONG_INSTANCE" }`. The client
 *     reads this, restarts via /api/live/start, and the new session
 *     lands on whichever instance answers — restoring affinity.
 *   - missing → 404 with `{ code: "NOT_FOUND" }`.
 */
export function lookupErrorResponse(
  lookup: SessionLookup,
  context: { route: string; sessionId: string }
): Response | undefined {
  if (lookup.kind === "local") return undefined;
  if (lookup.kind === "remote") {
    console.warn(JSON.stringify({
      event: "live.session.wrong-instance",
      route: context.route,
      sessionId: context.sessionId,
      ownerInstance: lookup.instanceId,
      thisInstance: getInstanceId()
    }));
    return new Response(
      JSON.stringify({
        error: "Session lives on another instance — please reconnect.",
        code: "WRONG_INSTANCE"
      }),
      { status: 410, headers: { "content-type": "application/json" } }
    );
  }
  console.warn(JSON.stringify({
    event: "live.session.missing",
    route: context.route,
    sessionId: context.sessionId
  }));
  return new Response(
    JSON.stringify({
      error: "Session not found or expired.",
      code: "NOT_FOUND"
    }),
    { status: 404, headers: { "content-type": "application/json" } }
  );
}

function teardown(id: string): void {
  const entry = SESSIONS.get(id);
  if (!entry) return;
  if (entry.heartbeat) {
    clearInterval(entry.heartbeat);
    entry.heartbeat = undefined;
  }
  entry.engine.stop();
  SESSIONS.delete(id);
  void registry().unregister(id).catch(() => undefined);
}
