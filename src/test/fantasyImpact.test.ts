import { describe, expect, it } from "vitest";
import { rankFantasyImpacts } from "../engine/fantasyImpact";
import { demoLeagueState, demoPlays } from "../providers/demoData";
import type { FantasyLeagueState, FantasyPlayer, FantasyRoster, SportsPlay } from "../shared/contracts";

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
  ownerName: "Owner",
  teamName: "Team",
  starters: [],
  bench: [],
  ...overrides
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

const play = (overrides: Partial<SportsPlay> = {}): SportsPlay => ({
  id: "p1",
  type: "pass",
  excitement: 3,
  clock: "0:00",
  period: { number: 1, kind: "quarter" },
  possession: "KC",
  headline: "x",
  description: "y",
  playerIds: [],
  team: "KC",
  score: { away: 0, home: 0 },
  occurredAt: "2026-05-09T00:00:00Z",
  ...overrides
});

describe("rankFantasyImpacts", () => {
  it("ranks impacted rostered players by estimated points swing", () => {
    const impacts = rankFantasyImpacts(demoLeagueState, demoPlays[1]);
    expect(impacts[0]).toMatchObject({
      ownerName: "Maya",
      playerName: "Travis Kelce",
      isStarter: true,
      pointsDelta: 6.5
    });
    expect(impacts.some((impact) => impact.playerName === "Patrick Mahomes")).toBe(true);
  });

  it("scores quarterback turnovers as negative fantasy impact", () => {
    const impacts = rankFantasyImpacts(demoLeagueState, demoPlays[4]);
    expect(impacts[0]).toMatchObject({
      ownerName: "Alex",
      playerName: "Patrick Mahomes",
      pointsDelta: -2
    });
  });

  it("does not emit impact rows for unrostered field goals", () => {
    const impacts = rankFantasyImpacts(demoLeagueState, demoPlays[7]);
    expect(impacts).toEqual([]);
  });

  it("applies reception bonus for skill-position catches", () => {
    const impacts = rankFantasyImpacts(demoLeagueState, demoPlays[9]);
    expect(impacts[0]).toMatchObject({
      playerName: "Amon-Ra St. Brown",
      pointsDelta: 6.5
    });
  });

  it("returns empty for a play whose playerIds match nobody on any roster", () => {
    const r = roster({ starters: [player({ id: "in-roster" })] });
    expect(rankFantasyImpacts(league([r]), play({ playerIds: ["unknown"] }))).toEqual([]);
  });

  it("dampens bench impact via the 0.15 starter multiplier", () => {
    const benchPlayer = player({ id: "bench-1", position: "WR" });
    const r = roster({ starters: [], bench: [benchPlayer] });
    // Description deliberately omits the catch/hauls-in trigger words so
    // we test the bench multiplier in isolation: WR touchdown base = 6,
    // bench multiplier 0.15 → 0.9.
    const impacts = rankFantasyImpacts(league([r]), play({ playerIds: ["bench-1"], type: "touchdown", description: "Touchdown" }));
    expect(impacts[0].isStarter).toBe(false);
    expect(impacts[0].pointsDelta).toBeCloseTo(0.9, 1);
  });

  it("sorts the result by absolute points delta and caps at 5 rows", () => {
    // Build six rosters all owning the same playerId, varying positions
    // so the deltas differ; expect five back, sorted by abs delta.
    const ids = ["a", "b", "c", "d", "e", "f"];
    const rosters: FantasyRoster[] = ids.map((id, i) =>
      roster({ id: `r-${id}`, ownerName: id, teamName: id, starters: [player({ id: "shared", position: i % 2 === 0 ? "QB" : "RB" })] })
    );
    const impacts = rankFantasyImpacts(
      league(rosters),
      play({ playerIds: ["shared"], type: "touchdown", description: "Touchdown 25 yards" })
    );
    expect(impacts).toHaveLength(5);
    for (let i = 1; i < impacts.length; i++) {
      expect(Math.abs(impacts[i - 1].pointsDelta)).toBeGreaterThanOrEqual(Math.abs(impacts[i].pointsDelta));
    }
  });

  it("treats `type: turnover` as negative regardless of description wording", () => {
    const r = roster({ starters: [player({ id: "qb1", position: "QB" })] });
    const impacts = rankFantasyImpacts(league([r]), play({ playerIds: ["qb1"], type: "turnover", description: "Sacked, lost ball." }));
    expect(impacts[0].pointsDelta).toBe(-2);
  });
});
