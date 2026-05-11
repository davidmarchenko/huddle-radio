import type { ClientServerEvent, HostId, ListenerCue, LivecastRequest, VideoFrameSnapshot } from "../shared/contracts";

/**
 * Vercel-deployable replacement for the legacy WebSocket transport.
 * Uses POST /api/live/start to spin up a session, EventSource on
 * /api/live/stream to consume the show, and POSTs to
 * /api/live/{frame,cue,nudge,stop} to push state in.
 *
 * The handle returned by startLiveSession is the only object callers
 * need to keep around — closeSession cleans up the EventSource +
 * notifies the server. Callers receive ClientServerEvent values
 * exactly like the WS path did, so the upstream message handler in
 * main.tsx stays identical.
 */

export type LiveSessionHandlers = {
  onEvent: (event: ClientServerEvent) => void;
  /** Fires once the EventSource opens, after the server has the session and is streaming. */
  onOpen?: () => void;
  /** Fires when the server sends a 4xx/5xx start error or the EventSource fails irrecoverably. */
  onError?: (message: string) => void;
  /** Fires when the EventSource closes (server disconnect, max-duration cutoff, manual close). */
  onClose?: () => void;
};

export type LiveSessionHandle = {
  sessionId: string;
  /** True once the EventSource opened at least once. False before that or after explicit close. */
  isOpen: () => boolean;
};

const KNOWN_EVENT_TYPES = [
  "snapshot",
  "play",
  "commentary",
  "observation",
  "tts",
  "health",
  "status",
  "cue-ack",
  "error"
];

export async function startLiveSession(
  request: LivecastRequest,
  handlers: LiveSessionHandlers
): Promise<LiveSessionHandle | undefined> {
  let response: Response;
  try {
    response = await fetch("/api/live/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
  } catch (error) {
    handlers.onError?.(error instanceof Error ? error.message : "Failed to start show.");
    return undefined;
  }
  if (!response.ok) {
    let message = `Show start failed (${response.status}).`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // Body wasn't JSON; keep the generic message.
    }
    handlers.onError?.(message);
    return undefined;
  }
  const { sessionId } = (await response.json()) as { sessionId: string };
  if (!sessionId) {
    handlers.onError?.("Show start returned no sessionId.");
    return undefined;
  }

  const source = new EventSource(`/api/live/stream?sessionId=${encodeURIComponent(sessionId)}`);
  let opened = false;
  let closedManually = false;

  source.addEventListener("open", () => {
    opened = true;
    handlers.onOpen?.();
  });

  // EventSource fires a generic `message` event when the server omits
  // the `event:` line. Our SSE writer always sets `event:` so we route
  // by type explicitly — but keep the generic listener as a safety net.
  source.addEventListener("message", (e: MessageEvent) => {
    safeDispatch(e.data, handlers);
  });
  for (const type of KNOWN_EVENT_TYPES) {
    source.addEventListener(type, (e: MessageEvent) => {
      safeDispatch(e.data, handlers);
    });
  }

  source.addEventListener("error", () => {
    // EventSource auto-reconnects on a network blip; only treat this
    // as a hard error if we never opened (server returned 4xx/5xx).
    if (!opened && !closedManually) {
      handlers.onError?.("Stream connection failed.");
      source.close();
      handlers.onClose?.();
    }
  });

  // Patch close() so the cleanup helper below can flag the manual
  // teardown and skip the reconnect-vs-error logic.
  const wrappedClose = () => {
    closedManually = true;
    source.close();
    handlers.onClose?.();
  };

  // Stash the wrapped close so closeSession can find it. Map is fine
  // here — sessions are short-lived and closeSession deletes its
  // entry, so leakage is bounded by the live-show count.
  closeMap.set(sessionId, wrappedClose);

  return {
    sessionId,
    isOpen: () => opened && !closedManually
  };
}

const closeMap = new Map<string, () => void>();

export async function sendFrame(handle: LiveSessionHandle, frame: VideoFrameSnapshot): Promise<void> {
  await fetch("/api/live/frame", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: handle.sessionId, frame })
  }).catch(() => undefined);
}

export async function sendCue(handle: LiveSessionHandle, cue: ListenerCue): Promise<boolean> {
  try {
    const response = await fetch("/api/live/cue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: handle.sessionId, cue })
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function sendNudge(handle: LiveSessionHandle, hostId: HostId): Promise<void> {
  await fetch("/api/live/nudge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: handle.sessionId, hostId })
  }).catch(() => undefined);
}

export async function closeSession(handle: LiveSessionHandle): Promise<void> {
  const close = closeMap.get(handle.sessionId);
  close?.();
  closeMap.delete(handle.sessionId);
  // Best effort: tell the server to evict + stop the engine.
  // We don't await — a tab close shouldn't block on this round-trip.
  void fetch("/api/live/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: handle.sessionId }),
    keepalive: true
  }).catch(() => undefined);
}

function safeDispatch(raw: unknown, handlers: LiveSessionHandlers): void {
  if (typeof raw !== "string") return;
  try {
    const parsed = JSON.parse(raw) as ClientServerEvent;
    handlers.onEvent(parsed);
  } catch {
    // Malformed event from the server; drop it silently — the
    // structured logs on the server will already record the original.
  }
}
