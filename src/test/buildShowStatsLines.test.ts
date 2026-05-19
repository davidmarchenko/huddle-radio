import { describe, expect, it } from "vitest";
import { HUDDLE_HOSTS, buildShowStatsLines } from "../client/huddleViewModel";
import type { LivecastCommentary } from "../shared/contracts";

/**
 * The recap "Show stats" card is one of the few places a listener
 * actually pauses to read postgame, so its phrasing matters. These
 * tests pin the contract:
 *   - 0 turns degrades gracefully (recap shouldn't render but if it
 *     does, no "0 calls" line is shown).
 *   - Single turn is grammatically singular ("call", "minute").
 *   - Multi-turn shows the duration (rounded up to ≥1 minute).
 *   - Host distribution names the leader + lists the others sorted
 *     by count desc, ties broken by display order.
 */

// Minimal commentary stub — only the fields buildShowStatsLines reads.
// Casting through unknown keeps the test free of irrelevant contract
// fields that would just clutter the cases.
function turn(hostId: "cam" | "maya" | "theo", createdAt: string): LivecastCommentary {
  return { id: `t-${hostId}-${createdAt}`, hostId, createdAt } as unknown as LivecastCommentary;
}

describe("buildShowStatsLines", () => {
  it("degrades cleanly when no calls landed", () => {
    expect(buildShowStatsLines([], HUDDLE_HOSTS)).toEqual([
      "No calls landed during this show."
    ]);
  });

  it("uses singular grammar for a one-call show with no duration span", () => {
    const lines = buildShowStatsLines([turn("maya", "2026-01-01T10:00:00Z")], HUDDLE_HOSTS);
    expect(lines[0]).toBe("1 call in this show.");
    // Single turn → no leader/distribution line.
    expect(lines).toHaveLength(1);
  });

  it("reports duration in whole minutes (rounded up to at least 1)", () => {
    const lines = buildShowStatsLines(
      [
        turn("maya", "2026-01-01T10:00:00Z"),
        turn("theo", "2026-01-01T10:00:30Z") // 30s gap
      ],
      HUDDLE_HOSTS
    );
    // 30s rounds to 1 minute (not 0) so the line stays sensible.
    expect(lines[0]).toBe("2 calls across 1 minute of show.");
  });

  it("reports the lead host with their turn count, then the rest sorted desc", () => {
    const commentary: LivecastCommentary[] = [
      turn("cam", "2026-01-01T10:00:00Z"),
      turn("cam", "2026-01-01T10:01:00Z"),
      turn("cam", "2026-01-01T10:02:00Z"),
      turn("maya", "2026-01-01T10:03:00Z"),
      turn("maya", "2026-01-01T10:04:00Z"),
      turn("theo", "2026-01-01T10:05:00Z")
    ];
    const lines = buildShowStatsLines(commentary, HUDDLE_HOSTS);
    expect(lines[0]).toBe("6 calls across 5 minutes of show.");
    expect(lines[1]).toBe("Cam led with 3 turns — Maya 2, Theo 1.");
  });

  it("omits the distribution line when only one host spoke", () => {
    const lines = buildShowStatsLines(
      [
        turn("theo", "2026-01-01T10:00:00Z"),
        turn("theo", "2026-01-01T10:01:00Z")
      ],
      HUDDLE_HOSTS
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("2 calls across 1 minute of show.");
  });

  it("breaks host-count ties by HUDDLE_HOSTS display order", () => {
    // Both Maya and Theo have 2 turns. Display order is Maya, Theo, Cam
    // so the lead should be Maya.
    const lines = buildShowStatsLines(
      [
        turn("theo", "2026-01-01T10:00:00Z"),
        turn("theo", "2026-01-01T10:01:00Z"),
        turn("maya", "2026-01-01T10:02:00Z"),
        turn("maya", "2026-01-01T10:03:00Z")
      ],
      HUDDLE_HOSTS
    );
    expect(lines[1]).toBe("Maya led with 2 turns — Theo 2.");
  });
});
