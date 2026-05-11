import { useEffect, useState } from "react";

/**
 * Cmd+D (or Ctrl+D outside macOS) toggles a compact overlay showing
 * the last 20 commentary turns with the KPIs we'd grep the dev log
 * for: which provider answered, line count, TTS chunks, latencies,
 * any error reason. Hits /api/diagnostics/recent-turns — the same
 * surface available in prod via curl, so the panel doubles as a
 * smoke test for the observability endpoint.
 *
 * Designed to be invisible until invoked. No tab order intrusion,
 * no theme dependence, no auto-refresh — it polls when open and
 * stops when closed so a stuck panel can't burn a request loop.
 */
export type TurnSummary = {
  turnId: string;
  kind: "opener" | "play";
  sessionId: string;
  engineId: string;
  leadHostId: string;
  finalHostIds: string[];
  lineCount: number;
  commentaryProvider: string;
  ttsEnabled: boolean;
  ttsProvider?: string;
  ttsChunks: number;
  ttsFirstByteMs?: number;
  textGenerationMs?: number;
  totalMs: number;
  errorReason?: string;
  startedAt: string;
};

export function DebugPanel() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<TurnSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Cmd+D on macOS, Ctrl+D elsewhere. Capture before browser
      // (default browser action is "bookmark this page" — preventDefault).
      if (event.key === "d" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const fetchTurns = async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/diagnostics/recent-turns?n=20", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { turns: TurnSummary[] };
        if (!cancelled) {
          setTurns(body.turns);
          setFetchError(undefined);
        }
      } catch (error) {
        if (!cancelled) {
          setFetchError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchTurns();
    // Poll every 3s while open so the panel stays current during a
    // running show. Stopped immediately when the panel closes.
    const interval = window.setInterval(fetchTurns, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="debug-panel" role="dialog" aria-label="Recent turn diagnostics">
      <div className="debug-panel__header">
        <strong>Recent turns</strong>
        <span className="debug-panel__hint">⌘D to close · /api/diagnostics/recent-turns</span>
        <button type="button" onClick={() => setOpen(false)} className="debug-panel__close" aria-label="Close debug panel">×</button>
      </div>
      {fetchError && <div className="debug-panel__error">Fetch failed: {fetchError}</div>}
      {!fetchError && turns.length === 0 && (
        <div className="debug-panel__empty">{loading ? "Loading..." : "No turns recorded yet — start a show."}</div>
      )}
      {turns.length > 0 && (
        <ol className="debug-panel__turns">
          {turns.map((turn) => (
            <li key={turn.turnId} className={`debug-panel__turn ${turn.errorReason ? "debug-panel__turn--error" : ""}`}>
              <div className="debug-panel__row">
                <span className="debug-panel__badge">{turn.kind}</span>
                <span className="debug-panel__provider">{turn.commentaryProvider}</span>
                <span className="debug-panel__hosts">{turn.finalHostIds.join(" → ") || turn.leadHostId}</span>
              </div>
              <div className="debug-panel__row debug-panel__row--meta">
                <span>{turn.lineCount} lines</span>
                <span>{turn.ttsEnabled ? `${turn.ttsChunks} chunks` : "tts off"}</span>
                {turn.ttsFirstByteMs !== undefined && <span>fb {turn.ttsFirstByteMs}ms</span>}
                {turn.textGenerationMs !== undefined && <span>txt {turn.textGenerationMs}ms</span>}
                <span>total {turn.totalMs}ms</span>
              </div>
              {turn.errorReason && <div className="debug-panel__error-reason">{turn.errorReason}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
