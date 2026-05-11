import { getRecentTurns } from "../../../../server/turnSummaries";

/**
 * Per-turn observability surface. Returns the last N commentary turns
 * (newest first) with the KPIs needed to diagnose "the show I just
 * stopped felt broken" without a terminal: which commentary provider
 * answered, whether TTS actually delivered chunks, first-byte latency,
 * any errors that fell through the chain.
 *
 * Backed by an in-memory ring buffer — survives across requests on the
 * same warm function instance, resets on cold start. Good enough for
 * dev + Vercel's Fluid Compute (which reuses instances). For
 * long-horizon history, ship the same summaries to a real log sink.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawN = url.searchParams.get("n");
  const parsed = rawN ? Number(rawN) : 20;
  const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
  const turns = getRecentTurns(n);
  return new Response(JSON.stringify({ turns, count: turns.length }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // Always fresh — these are observability snapshots, not cacheable.
      "cache-control": "no-store"
    }
  });
}
