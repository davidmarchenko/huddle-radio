import { getRecentEvaluations, summarizeRecentEvaluations } from "../../../../server/eval/evalStore";
import { getCommentaryPromptVersion } from "../../../../providers/commentaryPrompts";
import { getRecentTurns } from "../../../../server/turnSummaries";

/**
 * Synthetic-listener eval surface. Returns:
 *
 *   - `currentPromptVersion`: SHA-derived tag of the commentary prompt
 *     code currently shipping. Compare against per-evaluation
 *     `promptVersion` to attribute score deltas to specific prompt
 *     iterations — without this, every change is "did stayTuned drop
 *     because of last week's edit or this morning's?"
 *   - `evaluations`: last N per-turn judgements (newest first), each with
 *     dimension scores + composite stayTuned + one-sentence rationale,
 *     plus the `promptVersion` from the TurnSummary that produced the
 *     evaluated turn (joined via turnId).
 *   - `summary`: rolling means across the buffer — top-line metric for
 *     A/B (e.g. "did meanStayTuned move when we shipped the producer?").
 *
 * Backed by the same in-memory ring buffer pattern as recent-turns;
 * good enough for dev + Vercel Fluid Compute warm instances. Long-
 * horizon analysis would mirror these summaries into a real sink.
 */
export async function GET(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const rawN = url.searchParams.get("n");
  const parsed = rawN ? Number(rawN) : 20;
  const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
  try {
    const evaluations = getRecentEvaluations(n);
    const summary = summarizeRecentEvaluations();
    // Join each evaluation to the prompt version it was produced under
    // via turnId. getRecentTurns is async (Upstash-backed in prod);
    // pull a wider window than evaluations.length so a recent turn
    // pushed out of the eval buffer can still be matched. Wrapped in
    // a try/catch so a transient Upstash hiccup degrades to "no
    // promptVersion field" rather than 500-ing the diagnostics page.
    let promptVersionByTurn = new Map<string, string | undefined>();
    try {
      const turns = await getRecentTurns(Math.max(n * 2, 40));
      for (const turn of turns) promptVersionByTurn.set(turn.turnId, turn.promptVersion);
    } catch (joinErr) {
      console.warn(JSON.stringify({
        event: "diagnostics.eval.turn-join.failed",
        message: joinErr instanceof Error ? joinErr.message : String(joinErr)
      }));
      promptVersionByTurn = new Map();
    }
    const evaluationsWithVersion = evaluations.map((evaluation) => ({
      ...evaluation,
      promptVersion: promptVersionByTurn.get(evaluation.turnId)
    }));
    const body = JSON.stringify({
      currentPromptVersion: getCommentaryPromptVersion(),
      evaluations: evaluationsWithVersion,
      summary,
      count: evaluationsWithVersion.length
    });
    console.log(JSON.stringify({
      event: "diagnostics.eval.ok",
      requestedN: n,
      returned: evaluationsWithVersion.length,
      durationMs: Date.now() - startedAt
    }));
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store"
      }
    });
  } catch (err) {
    console.error(JSON.stringify({
      event: "diagnostics.eval.error",
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt
    }));
    return new Response(JSON.stringify({ error: "Internal error." }), {
      status: 500,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }
}
