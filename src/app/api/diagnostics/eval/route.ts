import { getRecentEvaluations, summarizeRecentEvaluations } from "../../../../server/eval/evalStore";

/**
 * Synthetic-listener eval surface. Returns:
 *
 *   - `evaluations`: last N per-turn judgements (newest first), each with
 *     dimension scores + composite stayTuned + one-sentence rationale.
 *   - `summary`: rolling means across the buffer — top-line metric for
 *     A/B (e.g. "did meanStayTuned move when we shipped the producer?").
 *
 * Backed by the same in-memory ring buffer pattern as recent-turns;
 * good enough for dev + Vercel Fluid Compute warm instances. Long-
 * horizon analysis would mirror these summaries into a real sink.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawN = url.searchParams.get("n");
  const parsed = rawN ? Number(rawN) : 20;
  const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
  const evaluations = getRecentEvaluations(n);
  const summary = summarizeRecentEvaluations();
  return new Response(JSON.stringify({ evaluations, summary, count: evaluations.length }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}
