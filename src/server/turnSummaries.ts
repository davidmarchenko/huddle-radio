import { getDefaultTurnSummaryStore } from "./turnSummaryStore";

/**
 * Per-turn observability ring buffer.
 *
 * Every commentary turn (opener or tick) ends with a single
 * `recordTurn` call that captures the KPIs we'd want to see if the
 * show feels broken: which commentary provider answered, how many
 * dialogue lines, how many TTS chunks reached the listener, first-byte
 * latency, end-to-end latency, and any error reason. The buffer holds
 * the last 100 turns across all shows — enough to debug "the show I
 * just stopped" without a tail -F.
 *
 * The companion route `/api/diagnostics/recent-turns` reads from this
 * buffer so debugging doesn't require terminal access to the dev
 * server (or Vercel runtime logs in prod).
 *
 * Storage: when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are
 * set in env, summaries are persisted to Upstash so the diagnostics
 * endpoint sees every turn regardless of which Fluid Compute instance
 * recorded it. Without those env vars (tests, local dev without
 * Upstash), falls back to an in-memory ring buffer.
 */
export type TurnSummary = {
  /** Commentary id — also the turn id. Sortable with the buffer order. */
  turnId: string;
  kind: "opener" | "play";
  sessionId: string;
  engineId: string;
  /** Host who led the turn. Subsequent lines may route to peers. */
  leadHostId: string;
  /** All host ids that ended up speaking, in line order. */
  finalHostIds: string[];
  lineCount: number;
  /** Provider id that answered the draft (e.g., "openai-commentary", "local-commentary"). */
  commentaryProvider: string;
  ttsEnabled: boolean;
  ttsProvider?: string;
  ttsChunks: number;
  ttsFirstByteMs?: number;
  textGenerationMs?: number;
  totalMs: number;
  /** Short reason when the turn degraded. Examples: "openai 429 → local fallback", "tts WS closed without audio". */
  errorReason?: string;
  /** ISO timestamp at the start of the turn. */
  startedAt: string;
  /** How many enrichment signals (Reddit, Bluesky, …) the producer
   *  passed to the host prompt for this turn. 0 means either no
   *  providers fired or every signal was deduped/filtered out — both
   *  worth distinguishing from "the feature is broken." */
  enrichmentSignalCount?: number;
  /** Distinct sources that contributed at least one signal — sorted
   *  for stable diff. Helps answer "is Reddit ever firing?" from the
   *  diagnostics endpoint without parsing logs. */
  enrichmentSources?: string[];
  /** Producer agent id that emitted the directive for this turn.
   *  Suffixed with `:error` when the producer threw and the engine
   *  fell back to the legacy raw-field host prompt. */
  producer?: string;
  /** Ordered `sourceKind` of every beat the producer emitted —
   *  ["market", "enrichment", "play"] etc. Lets us answer "did the
   *  producer ever lead with an enrichment beat?" from logs. */
  producerBeats?: string[];
  /** Show-arc position the planner was in for this tick (cold-open /
   *  build / mid-show / climax / act-break / pivot / close). Lets us
   *  answer "what fraction of the show happened in pivot mode?"
   *  without joining external tables. */
  arcPosition?: string;
  /** Full transcript of the turn — one entry per dialogue line, in
   *  speak order. Captured so the diagnostics endpoint can answer
   *  "show me the actual words the hosts said this turn" without a
   *  separate log scrape. Optional so legacy summaries (and tests
   *  that only assert telemetry) keep working. */
  lines?: { hostId: string; text: string }[];
  /** SHA-256 (first 12 hex chars) of the rendered system prompt the
   *  host LLM saw for this turn. Lets eval scores join back to the
   *  exact prompt-version that produced the turn — without this,
   *  every prompt iteration is unattributable ("did stayTuned drop
   *  because of last week's prompt change, or this morning's?").
   *  Computed at engine boot for the active commentary chain;
   *  embedded per-turn so a mid-show prompt deploy is visible too.
   *  Optional for back-compat with summaries written before the
   *  versioning landed. */
  promptVersion?: string;
};

export function recordTurn(summary: TurnSummary): void {
  // Single grep target — `grep live.turn.summary` gives the full
  // per-turn audit trail without needing the diagnostics endpoint.
  console.log(JSON.stringify({ event: "live.turn.summary", ...summary }));
  // Async persist to the configured store (Upstash in prod, memory
  // in tests + local-no-upstash). Fire-and-forget so the engine
  // doesn't pay a Redis round-trip on the hot path; a failed write
  // logs to stderr instead of breaking the turn.
  void getDefaultTurnSummaryStore()
    .record(summary)
    .catch((err) => {
      console.warn(
        JSON.stringify({
          event: "turn-summary.store.error",
          err: err instanceof Error ? err.message : String(err)
        })
      );
    });
}

export async function getRecentTurns(limit: number): Promise<TurnSummary[]> {
  return getDefaultTurnSummaryStore().recent(limit);
}

/** Test-only — reset the buffer between integration runs. */
export async function _resetTurnSummariesForTests(): Promise<void> {
  await getDefaultTurnSummaryStore().reset();
}
