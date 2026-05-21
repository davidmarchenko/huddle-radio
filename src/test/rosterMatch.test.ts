import { describe, expect, it } from "vitest";
import { rosterForListener, rosterMatchKind } from "../server/rosterMatch";
import type { FantasyLeagueState, FantasyRoster } from "../shared/contracts";

const roster = (id: string, name: string): FantasyRoster => ({
  id,
  ownerName: name,
  teamName: `${name}'s team`,
  starters: [],
  bench: []
});

const league = (rosters: FantasyRoster[]): FantasyLeagueState => ({
  provider: "demo",
  leagueId: "L",
  leagueName: "Demo",
  sport: "nfl",
  season: "2025",
  scoringSummary: "x",
  matchups: [{ id: "m1", week: 1, rosters }],
  updatedAt: "2026-05-09T00:00:00Z"
});

describe("rosterForListener", () => {
  it("returns the matched roster when rosterId is found", () => {
    const result = rosterForListener(league([roster("a", "Alex"), roster("b", "Sam")]), "b");
    expect(result?.ownerName).toBe("Sam");
  });

  it("returns undefined when rosterId doesn't match — no longer invents ownership", () => {
    // History: this used to fall back to the first roster ("Alex").
    // That gave a real listener with a stale rosterId a stranger's team
    // narrated to them on-air. The fix is to refuse and let the host-
    // side prompts handle the empty-starters branch.
    const result = rosterForListener(league([roster("a", "Alex"), roster("b", "Sam")]), "missing");
    expect(result).toBeUndefined();
  });

  it("returns undefined when no rosterId is provided — anonymous listener has no roster", () => {
    // The user-reported bug: a fresh anonymous user (empty default
    // profile) heard "Fourth & Snack — Mahomes, St. Brown, McCaffrey"
    // because the first demo roster got auto-assigned. Refuse the
    // fallback so anonymous broadcast mode actually fires clean.
    const result = rosterForListener(league([roster("a", "Alex"), roster("b", "Sam")]));
    expect(result).toBeUndefined();
  });

  it("returns undefined when the league has no rosters", () => {
    expect(rosterForListener(league([]))).toBeUndefined();
  });
});

describe("rosterMatchKind", () => {
  it("returns `exact` when the rosterId resolves", () => {
    expect(rosterMatchKind(league([roster("a", "Alex")]), "a")).toBe("exact");
  });

  it("returns `fallback-first` when the rosterId is set but unknown", () => {
    expect(rosterMatchKind(league([roster("a", "Alex")]), "stranger")).toBe("fallback-first");
  });

  it("returns `no-roster-id` when rosterId is omitted", () => {
    expect(rosterMatchKind(league([roster("a", "Alex")]))).toBe("no-roster-id");
  });

  it("returns `no-rosters` when the league has none", () => {
    expect(rosterMatchKind(league([]), "a")).toBe("no-rosters");
  });
});
