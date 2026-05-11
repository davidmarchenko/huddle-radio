import type { ClientServerEvent, HostId, ListenerCue, LivecastRequest, VideoFrameSnapshot } from "../shared/contracts";

/**
 * Vercel-deployable replacement for the legacy WebSocket transport.
 *
 * POSTs the LivecastRequest to /api/live/stream and consumes the SSE
 * response via fetch + ReadableStream. The server creates the engine
 * on the same Function instance that answers this request, then emits
 * a `session-ready` event with the sessionId. This colocation
 * guarantees the SSE consumer always finds its engine — no
 * cross-instance race like the previous start/stream split had.
 *
 * Companion POSTs (cue/frame/nudge/stop) still target their own
 * routes; they use the registry to detect cross-instance hits and
 * return 410 (`code: WRONG_INSTANCE`). The client surfaces 410 via
 * onSessionLost, which restarts the show with a fresh engine.
 *
 * Callers receive ClientServerEvent values exactly like the WS path
 * did, so the upstream message handler in main.tsx stays identical.
 */

export type LiveSessionHandlers = {
  onEvent: (event: ClientServerEvent) => void;
  /** Fires once the server has acknowledged the session (first SSE event arrived). */
  onOpen?: () => void;
  /** Fires when the server returns a 4xx/5xx, the fetch fails, or the stream errors irrecoverably. */
  onError?: (message: string) => void;
  /** Fires when the stream closes (server disconnect, max-duration cutoff, manual close). */
  onClose?: () => void;
  /**
   * Fires when a companion POST returns 410 (`code: WRONG_INSTANCE`) —
   * the session lives on a different Function instance than the one
   * that answered. Consumers should treat this as "session is
   * irrecoverably orphaned" and restart the show via startLiveSession
   * with the original request. Without a handler, the POST silently
   * no-ops.
   */
  onSessionLost?: () => void;
};

export type LiveSessionHandle = {
  sessionId: string;
  /** True once the session-ready handshake landed. False before that or after explicit close. */
  isOpen: () => boolean;
};

export async function startLiveSession(
  request: LivecastRequest,
  handlers: LiveSessionHandlers
): Promise<LiveSessionHandle | undefined> {
  const abortController = new AbortController();

  let response: Response;
  try {
    response = await fetch("/api/live/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: abortController.signal
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

  if (!response.body) {
    handlers.onError?.("Stream response has no body.");
    return undefined;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Drain buffered SSE blocks. Each block becomes 0 or 1 events
  // (skipping comments and the `retry:` preamble). Returns the parsed
  // objects in arrival order.
  const drainBlocks = (chunk: string): Array<{ type?: string; [k: string]: unknown }> => {
    buffer += chunk;
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    const out: Array<{ type?: string; [k: string]: unknown }> = [];
    for (const block of parts) {
      if (!block.trim()) continue;
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        out.push(JSON.parse(dataLine.slice("data:".length).trim()));
      } catch (error) {
        // Drop unparseable blocks (server keepalive comments, malformed lines).
        // Log to console so we can tell whether a tts event with a
        // huge base64 payload is silently failing JSON.parse.
        console.warn("[huddle.sse] JSON.parse failed", {
          dataLineLen: dataLine.length,
          firstChars: dataLine.slice(0, 80),
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return out;
  };

  // Wait for the first event — must be `session-ready` with the
  // sessionId. The server emits the snapshot + opener commentary
  // synchronously after the handshake, so any of those events may
  // arrive in the SAME TCP chunk as session-ready. We extract the
  // handshake but pass the rest along to the consumer once the
  // drain loop is set up.
  let sessionId: string | undefined;
  let pendingPostHandshake: Array<{ type?: string; [k: string]: unknown }> = [];
  while (!sessionId) {
    const { value, done } = await reader.read();
    if (done) {
      handlers.onError?.("Stream closed before session handshake.");
      return undefined;
    }
    const events = drainBlocks(decoder.decode(value, { stream: true }));
    const handshakeIndex = events.findIndex(
      (evt) => evt?.type === "session-ready" && typeof evt.sessionId === "string"
    );
    if (handshakeIndex < 0) {
      // Defensive: per the protocol, session-ready is always first
      // — but if this chunk had only preamble/comments, just keep
      // reading. A non-session-ready event arriving before the
      // handshake would land at handshakeIndex 0 (rejected here).
      if (events.length > 0) {
        handlers.onError?.("Server emitted an event before session handshake.");
        try { await reader.cancel(); } catch { /* swallow */ }
        return undefined;
      }
      continue;
    }
    sessionId = events[handshakeIndex].sessionId as string;
    // Anything that arrived in the same chunk after session-ready
    // (typically the snapshot + opener commentary) needs to reach
    // the consumer. Stash for the drain loop to flush first.
    pendingPostHandshake = events.slice(handshakeIndex + 1);
  }

  let opened = true;
  let closedManually = false;
  handlers.onOpen?.();

  // Background drain loop. Flushes any same-chunk-as-handshake
  // events first, then keeps pumping events until the server
  // closes the stream or the consumer aborts.
  const drainLoop = async () => {
    try {
      for (const evt of pendingPostHandshake) {
        if (evt?.type === "session-ready") continue;
        // Diagnostic: surface every parsed event type at the transport
        // boundary so we can tell "event never arrived" apart from
        // "event arrived but dispatcher swallowed it."
        console.log("[huddle.sse]", evt?.type, "(post-handshake)");
        handlers.onEvent(evt as ClientServerEvent);
      }
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const events = drainBlocks(decoder.decode(value, { stream: true }));
        for (const evt of events) {
          // Ignore the handshake event if the server ever re-emits it
          // (defensive — current protocol fires it exactly once).
          if (evt?.type === "session-ready") continue;
          console.log("[huddle.sse]", evt?.type);
          handlers.onEvent(evt as ClientServerEvent);
        }
      }
    } catch (error) {
      // AbortError from manual close is expected; surface anything else.
      if (!closedManually) {
        const message = error instanceof Error ? error.message : "Stream interrupted.";
        // Only treat as a hard error — not a routine close — when the
        // disconnect was unexpected.
        handlers.onError?.(message);
      }
    } finally {
      opened = false;
      handlers.onClose?.();
    }
  };
  void drainLoop();

  // Stash the abort fn so closeSession can find it. Map is fine here
  // — sessions are short-lived and closeSession deletes its entry, so
  // leakage is bounded by the live-show count.
  //
  // We both abort the fetch (closes the connection at the network
  // layer) AND cancel the reader (forces any in-flight read() to
  // resolve `done: true`, exiting the drain loop). Cancel-without-
  // abort would leak the connection; abort-without-cancel sometimes
  // doesn't propagate to the reader synchronously in some runtimes.
  closeMap.set(sessionId, () => {
    closedManually = true;
    abortController.abort();
    void reader.cancel().catch(() => undefined);
  });

  // Stash the session-lost handler so the POST helpers can route 410
  // responses back to the consumer without each call site needing to
  // pass the callback explicitly. One latch per session is enough —
  // we want exactly one reconnect attempt, not one per failed POST.
  if (handlers.onSessionLost) {
    sessionLostMap.set(sessionId, () => {
      const callback = sessionLostMap.get(sessionId);
      if (!callback) return;
      sessionLostMap.delete(sessionId);
      handlers.onSessionLost?.();
    });
  }

  return {
    sessionId,
    isOpen: () => opened && !closedManually
  };
}

const closeMap = new Map<string, () => void>();
const sessionLostMap = new Map<string, () => void>();

/** Detect the WRONG_INSTANCE 410 marker and fire the session-lost callback exactly once. */
function maybeReportSessionLost(sessionId: string, response: Response): boolean {
  if (response.status !== 410) return false;
  const callback = sessionLostMap.get(sessionId);
  callback?.();
  return true;
}

export async function sendFrame(handle: LiveSessionHandle, frame: VideoFrameSnapshot): Promise<void> {
  try {
    const response = await fetch("/api/live/frame", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: handle.sessionId, frame })
    });
    maybeReportSessionLost(handle.sessionId, response);
  } catch {
    // Network failure: leave the engine to handle the next tick. We
    // don't escalate to onSessionLost here because a transient network
    // blip shouldn't trigger a full restart.
  }
}

export async function sendCue(handle: LiveSessionHandle, cue: ListenerCue): Promise<boolean> {
  try {
    const response = await fetch("/api/live/cue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: handle.sessionId, cue })
    });
    maybeReportSessionLost(handle.sessionId, response);
    return response.ok;
  } catch {
    return false;
  }
}

export async function sendNudge(handle: LiveSessionHandle, hostId: HostId): Promise<void> {
  try {
    const response = await fetch("/api/live/nudge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: handle.sessionId, hostId })
    });
    maybeReportSessionLost(handle.sessionId, response);
  } catch {
    // See sendFrame — transient network failures do not trigger reconnect.
  }
}

export async function closeSession(handle: LiveSessionHandle): Promise<void> {
  const close = closeMap.get(handle.sessionId);
  close?.();
  closeMap.delete(handle.sessionId);
  sessionLostMap.delete(handle.sessionId);
  // Best effort: tell the server to evict + stop the engine.
  // We don't await — a tab close shouldn't block on this round-trip.
  void fetch("/api/live/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: handle.sessionId }),
    keepalive: true
  }).catch(() => undefined);
}
