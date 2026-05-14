import { getSharedClaimsStore } from "../../../../server/memory/claimsStore";

/**
 * Cross-show memory diagnostics. Surfaces every claim stored for a
 * given listener — newest first — so we can answer "why didn't a
 * callback fire?" or "what predictions has the show actually
 * captured for me?" without grepping logs or re-deriving from
 * /api/diagnostics/recent-turns.
 *
 * Required: ?listenerId=<id>. Returns 400 when missing — claims are
 * scoped per-listener and dumping the entire store would be both
 * useless and a privacy footgun.
 *
 * Optional: ?limit=N (default 50, max 200).
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const listenerId = url.searchParams.get("listenerId")?.trim();
  if (!listenerId) {
    return new Response(
      JSON.stringify({ error: "listenerId query param is required" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }
  const rawLimit = url.searchParams.get("limit");
  const parsedLimit = rawLimit ? Number(rawLimit) : 50;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(200, Math.floor(parsedLimit))
    : 50;
  const store = getSharedClaimsStore();
  const claims = await store.listAllForListener(listenerId, limit);
  // Roll up outcome counts so the dashboard can show "12 right / 4
  // wrong / 27 pending" at a glance.
  const counts = { right: 0, wrong: 0, pending: 0, total: claims.length };
  for (const claim of claims) {
    const outcome = claim.outcome ?? "pending";
    if (outcome === "right") counts.right += 1;
    else if (outcome === "wrong") counts.wrong += 1;
    else counts.pending += 1;
  }
  return new Response(JSON.stringify({ listenerId, counts, claims }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
