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

  it("falls back to the first roster when rosterId doesn't match", () => {
    const result = rosterForListener(league([roster("a", "Alex"), roster("b", "Sam")]), "missing");
    expect(result?.ownerName).toBe("Alex");
  });

  it("falls back to the first roster when no rosterId is provided", () => {
    const result = rosterForListener(league([roster("a", "Alex"), roster("b", "Sam")]));
    expect(result?.ownerName).toBe("Alex");
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
