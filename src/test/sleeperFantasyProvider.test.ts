import { describe, expect, it } from "vitest";
import { normalizeSleeperRoster } from "../providers/sleeperFantasyProvider";

describe("normalizeSleeperRoster", () => {
  it("normalizes Sleeper-shaped roster payloads into shared fantasy contracts", () => {
    const roster = normalizeSleeperRoster(
      {
        roster_id: 4,
        owner_id: "user-1",
        starters: ["p1"],
        players: ["p1", "p2"],
        settings: { fpts: 90 }
      },
      { user_id: "user-1", display_name: "Sam", metadata: { team_name: "The Samwiches" } },
      { roster_id: 4, matchup_id: 2, points: 101.4, starters: ["p1"], players: ["p1", "p2"] },
      {
        p1: { full_name: "Demo Starter", position: "WR", team: "KC" },
        p2: { full_name: "Demo Bench", position: "RB", team: "DET" }
      }
    );

    expect(roster.ownerName).toBe("Sam");
    expect(roster.teamName).toBe("The Samwiches");
    expect(roster.starters[0]).toMatchObject({ name: "Demo Starter", currentPoints: 101.4 });
    expect(roster.bench[0]).toMatchObject({ name: "Demo Bench", currentPoints: 0 });
  });
});
