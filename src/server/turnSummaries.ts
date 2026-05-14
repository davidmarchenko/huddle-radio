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
};

const BUFFER_LIMIT = 100;
const buffer: TurnSummary[] = [];

export function recordTurn(summary: TurnSummary): void {
  buffer.push(summary);
  if (buffer.length > BUFFER_LIMIT) {
    buffer.splice(0, buffer.length - BUFFER_LIMIT);
  }
  // Single grep target — `grep live.turn.summary` gives the full
  // per-turn audit trail without needing the diagnostics endpoint.
  console.log(JSON.stringify({ event: "live.turn.summary", ...summary }));
}

export function getRecentTurns(limit: number): TurnSummary[] {
  const clamped = Math.max(1, Math.min(BUFFER_LIMIT, Math.floor(limit)));
  return buffer.slice(-clamped).reverse();
}

/** Test-only — reset the buffer between integration runs. */
export function _resetTurnSummariesForTests(): void {
  buffer.length = 0;
}
