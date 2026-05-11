/**
 * Cross-tab leader election for live shows.
 *
 * Problem: a user can accidentally have two shows running by opening
 * a second tab (or reloading mid-show before the previous engine
 * fully tore down). Each engine independently fires real-vendor TTS
 * + commentary calls — so a forgotten tab silently doubles every
 * commentary turn's credit burn.
 *
 * Solution: BroadcastChannel announces "I just took leadership" with
 * the local tab id and the new sessionId. Other tabs listening on
 * the same channel detect the takeover and fire their `onUsurped`
 * callback — which closes their session, stops the engine on the
 * server, and clears the local UI. Latest-started tab always wins.
 *
 * BroadcastChannel scope: same browser profile, same origin. Covers
 * the common accidental case (Cmd+T in the same Chrome window). Does
 * NOT cover: different browsers, different profiles, mobile + desktop
 * on the same account. For those, the server-side per-cookie
 * deduplication is the next layer (see backlog).
 *
 * Falls back to a no-op handle in environments without
 * BroadcastChannel (older Safari, older Firefox in private mode).
 */

const CHANNEL_NAME = "huddle-radio:leader";

type LeaderMessage = {
  kind: "took-leadership";
  tabId: string;
  sessionId: string;
  startedAt: number;
};

export type LeaderHandle = {
  /** Tell other tabs in the same browser profile that this tab now owns the active show. */
  release(): void;
};

/**
 * Claim leadership for the given sessionId. Other tabs that already
 * announced leadership will receive a takeover message and call their
 * `onUsurped` callback. Returns a handle whose `release()` should be
 * invoked when the show ends naturally so future startups don't
 * mistakenly believe the slot is still held.
 *
 * Idempotent against rapid calls — the latest invocation wins.
 */
export function claimShowLeadership(sessionId: string, tabId: string): LeaderHandle {
  if (typeof BroadcastChannel === "undefined") {
    return { release: () => undefined };
  }
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const message: LeaderMessage = {
    kind: "took-leadership",
    tabId,
    sessionId,
    startedAt: Date.now()
  };
  channel.postMessage(message);
  channel.close();
  return {
    release: () => undefined
  };
}

/**
 * Subscribe to leadership announcements from sibling tabs. The
 * `onUsurped` callback fires when ANOTHER tab (different tabId) takes
 * leadership. The tab id is generated per page load so reloads count
 * as a different "tab" — desired, since the reloaded page must close
 * the pre-reload session anyway.
 */
export function watchForLeadershipChange(localTabId: string, onUsurped: (sessionId: string) => void): () => void {
  if (typeof BroadcastChannel === "undefined") {
    return () => undefined;
  }
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as LeaderMessage | undefined;
    if (!data || data.kind !== "took-leadership") return;
    if (data.tabId === localTabId) return; // Echo of our own postMessage.
    onUsurped(data.sessionId);
  });
  return () => channel.close();
}

/** Generate a per-page-load tab identifier. Stable for the lifetime of this document. */
export function newTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
