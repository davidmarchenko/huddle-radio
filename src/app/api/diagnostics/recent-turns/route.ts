import { getRecentTurns } from "../../../../server/turnSummaries";

/**
 * Per-turn observability surface. Returns the last N commentary turns
 * (newest first) with the KPIs needed to diagnose "the show I just
 * stopped felt broken" without a terminal: which commentary provider
 * answered, whether TTS actually delivered chunks, first-byte latency,
 * any errors that fell through the chain.
 *
 * Storage: when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are
 * set, the underlying store reads from Upstash and sees every turn
 * regardless of which Fluid Compute instance recorded it. Without
 * those env vars (tests, local-dev-without-Upstash), falls back to
 * an in-memory ring buffer scoped to this process.
 */
export async function GET(req: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url);
    const rawN = url.searchParams.get("n");
    const parsed = rawN ? Number(rawN) : 20;
    const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
    const turns = await getRecentTurns(n);
    return new Response(JSON.stringify({ turns, count: turns.length }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        // Always fresh — these are observability snapshots, not cacheable.
        "cache-control": "no-store"
      }
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "diagnostics.recent-turns.error",
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt
      })
    );
    return new Response(
      JSON.stringify({ error: "Failed to read turn summaries." }),
      {
        status: 500,
        headers: { "content-type": "application/json", "cache-control": "no-store" }
      }
    );
  }
}
