import { ShowEngine } from "./showEngine";

/**
 * In-memory session store for the SSE-based live show.
 *
 * The companion POST routes (`/api/live/{frame,cue,nudge,stop}`) need
 * to find the same ShowEngine instance the SSE GET (`/api/live/stream`)
 * is attached to. On Vercel that means subsequent requests must hit
 * the same Function instance — typically true under low traffic /
 * single user, but NOT guaranteed under autoscaling. Productionizing
 * this requires backing the store with Upstash Redis (see
 * `docs/nim-on-prem.md` for the multi-instance migration sketch).
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
};

const SESSIONS = new Map<string, Entry>();

/** How long to wait for the SSE GET to attach before reaping a started session. */
const ATTACH_GRACE_MS = 30_000;

/** How long an engine can sit detached before we stop it for good. */
const DETACH_GRACE_MS = 5_000;

function newSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function registerSession(engine: ShowEngine): string {
  const id = newSessionId();
  SESSIONS.set(id, { engine, createdAt: Date.now(), consumed: false });
  // Reaper: if no SSE GET attaches within the grace window, stop the
  // engine so it doesn't keep ticking against ESPN / Nemotron / etc.
  setTimeout(() => {
    const entry = SESSIONS.get(id);
    if (!entry || entry.consumed) return;
    entry.engine.stop();
    SESSIONS.delete(id);
  }, ATTACH_GRACE_MS);
  return id;
}

export function getSession(id: string): ShowEngine | undefined {
  return SESSIONS.get(id)?.engine;
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
    current.engine.stop();
    SESSIONS.delete(id);
  }, DETACH_GRACE_MS + 100);
}

export function destroySession(id: string): void {
  const entry = SESSIONS.get(id);
  if (!entry) return;
  entry.engine.stop();
  SESSIONS.delete(id);
}

export function sessionCount(): number {
  return SESSIONS.size;
}

/** Test-only: nuke all sessions. */
export function resetSessionStoreForTests(): void {
  for (const entry of SESSIONS.values()) entry.engine.stop();
  SESSIONS.clear();
}
