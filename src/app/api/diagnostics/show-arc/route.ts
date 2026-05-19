import { getRecentTurns } from "../../../../server/turnSummaries";

/**
 * Show-arc trajectory diagnostics. Projects each recent turn's
 * `arcPosition` onto a per-session timeline so we can see how the
 * arc planner moved through cold-open → build → climax → close.
 *
 * Returns a per-session array of arc-position transitions plus
 * counts. Lets us answer "did the show ever pivot?" or "are we
 * spending too long in mid-show?" without parsing the full
 * recent-turns payload.
 *
 * Optional: ?n=<count> (default 100, max 100 — the underlying
 * ring buffer caps at 100 anyway).
 */
export async function GET(req: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url);
    const rawN = url.searchParams.get("n");
    const parsed = rawN ? Number(rawN) : 100;
    const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
    const turns = await getRecentTurns(n);

    // Group by sessionId; each session gets the ordered arc trajectory
    // (oldest → newest within the session) plus per-position counts.
    type SessionArc = {
      sessionId: string;
      trajectory: Array<{ turnId: string; arcPosition: string; startedAt: string }>;
      counts: Record<string, number>;
    };
    const bySession = new Map<string, SessionArc>();
    // Iterate oldest-first so trajectory order is chronological.
    for (const turn of [...turns].reverse()) {
      if (!turn.arcPosition || !turn.sessionId) continue;
      const session = bySession.get(turn.sessionId) ?? {
        sessionId: turn.sessionId,
        trajectory: [],
        counts: {}
      };
      session.trajectory.push({
        turnId: turn.turnId,
        arcPosition: turn.arcPosition,
        startedAt: turn.startedAt
      });
      session.counts[turn.arcPosition] = (session.counts[turn.arcPosition] ?? 0) + 1;
      bySession.set(turn.sessionId, session);
    }
    const sessions = Array.from(bySession.values()).sort((a, b) => {
      // Most-recently-active session first.
      const aLast = a.trajectory[a.trajectory.length - 1]?.startedAt ?? "";
      const bLast = b.trajectory[b.trajectory.length - 1]?.startedAt ?? "";
      return bLast.localeCompare(aLast);
    });
    return new Response(JSON.stringify({ sessions, sessionCount: sessions.length }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "diagnostics.show-arc.error",
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt
      })
    );
    return new Response(
      JSON.stringify({ error: "Failed to compute show-arc trajectory." }),
      {
        status: 500,
        headers: { "content-type": "application/json", "cache-control": "no-store" }
      }
    );
  }
}
