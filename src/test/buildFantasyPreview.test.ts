import { describe, expect, it } from "vitest";
import { buildFantasyPreview } from "../server/app";
import type { FantasyLeagueState, FantasyPlayer, FantasyRoster } from "../shared/contracts";

const player = (overrides: Partial<FantasyPlayer> = {}): FantasyPlayer => ({
  id: "p1",
  name: "Player",
  position: "WR",
  proTeam: "KC",
  projectedPoints: 0,
  currentPoints: 0,
  ...overrides
});

const roster = (overrides: Partial<FantasyRoster> = {}): FantasyRoster => ({
  id: "r1",
  ownerName: "Alex",
  teamName: "Alex Team",
  starters: [player()],
  bench: [],
  ...overrides
});

const league = (overrides: Partial<FantasyLeagueState> = {}): FantasyLeagueState => ({
  provider: "demo",
  leagueId: "L",
  leagueName: "Demo League",
  sport: "nfl",
  season: "2025",
  scoringSummary: "x",
  matchups: [{ id: "m1", week: 1, rosters: [roster()] }],
  updatedAt: "2026-05-09T00:00:00Z",
  ...overrides
});

describe("buildFantasyPreview", () => {
  it("returns ok=true for a fully populated league", () => {
    const preview = buildFantasyPreview(league(), "demo");
    expect(preview.ok).toBe(true);
    expect(preview.message).toMatch(/ready for livecast/);
    expect(preview.readiness.find((c) => c.id === "matchups")?.ok).toBe(true);
    expect(preview.readiness.find((c) => c.id === "players")?.ok).toBe(true);
    expect(preview.readiness.find((c) => c.id === "teams")?.ok).toBe(true);
  });

  it("flags zero rosters in the matchups check", () => {
    const preview = buildFantasyPreview(league({ matchups: [{ id: "m1", week: 1, rosters: [] }] }), "demo");
    expect(preview.ok).toBe(false);
    expect(preview.readiness.find((c) => c.id === "matchups")?.ok).toBe(false);
  });

  it("flags zero players in the players check", () => {
    const empty = roster({ starters: [], bench: [] });
    const preview = buildFantasyPreview(league({ matchups: [{ id: "m1", week: 1, rosters: [empty] }] }), "demo");
    expect(preview.readiness.find((c) => c.id === "players")?.ok).toBe(false);
  });

  it("flags missing player team (proTeam===FA) in the teams check", () => {
    const fa = roster({ starters: [player({ proTeam: "FA" })] });
    const preview = buildFantasyPreview(league({ matchups: [{ id: "m1", week: 1, rosters: [fa] }] }), "demo");
    expect(preview.readiness.find((c) => c.id === "teams")?.ok).toBe(false);
    expect(preview.summary!.missingPlayerTeams).toBe(1);
  });

  it("counts missing roster names — owner names that start with 'Roster '", () => {
    const noName = roster({ ownerName: "Roster 7" });
    const preview = buildFantasyPreview(league({ matchups: [{ id: "m1", week: 1, rosters: [noName] }] }), "demo");
    expect(preview.summary!.missingRosterNames).toBe(1);
  });

  it("uses the requested week when one is supplied, falls back to matchup[0].week otherwise", () => {
    expect(buildFantasyPreview(league(), "demo", 12).summary!.week).toBe(12);
    expect(buildFantasyPreview(league({ matchups: [{ id: "m1", week: 4, rosters: [roster()] }] }), "demo").summary!.week).toBe(4);
  });

  it("dedupes player counts by id across rosters", () => {
    const sharedPlayer = player({ id: "shared", name: "Shared" });
    const a = roster({ id: "a", starters: [sharedPlayer] });
    const b = roster({ id: "b", starters: [sharedPlayer] });
    const preview = buildFantasyPreview(league({ matchups: [{ id: "m1", week: 1, rosters: [a, b] }] }), "demo");
    expect(preview.summary!.playerCount).toBe(1);
    // starterCount sums per-roster, so it should still be 2.
    expect(preview.summary!.starterCount).toBe(2);
  });
});
