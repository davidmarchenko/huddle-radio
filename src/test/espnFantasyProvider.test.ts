import { describe, expect, it } from "vitest";
import { normalizeEspnLeague } from "../providers/espnFantasyProvider";

describe("normalizeEspnLeague", () => {
  it("normalizes ESPN league payloads into shared fantasy contracts", () => {
    const league = normalizeEspnLeague(
      {
        id: 123,
        seasonId: 2026,
        settings: {
          name: "ESPN Crew",
          scoringSettings: { scoringItems: [{ statId: 1, points: 1 }] }
        },
        members: [{ id: "owner-1", displayName: "Taylor" }],
        teams: [
          {
            id: 1,
            location: "Taylor",
            nickname: "Touchdowns",
            owners: ["owner-1"],
            roster: {
              entries: [
                {
                  lineupSlotId: 0,
                  playerId: 3139477,
                  playerPoolEntry: {
                    appliedStatTotal: 18.4,
                    player: { id: 3139477, fullName: "Patrick Mahomes", defaultPositionId: 1, proTeamId: 12 }
                  }
                },
                {
                  lineupSlotId: 20,
                  playerId: 4362628,
                  playerPoolEntry: {
                    appliedStatTotal: 4.2,
                    player: { id: 4362628, fullName: "Bench Runner", defaultPositionId: 2, proTeamId: 8 }
                  }
                }
              ]
            }
          },
          {
            id: 2,
            location: "Jordan",
            nickname: "Yards",
            owners: [],
            roster: { entries: [] }
          }
        ],
        schedule: [
          {
            matchupPeriodId: 7,
            home: { teamId: 1, totalPoints: 100 },
            away: { teamId: 2, totalPoints: 95 }
          }
        ]
      },
      "123",
      2026,
      7
    );

    expect(league).toMatchObject({
      provider: "espn",
      leagueId: "123",
      leagueName: "ESPN Crew",
      season: "2026"
    });
    expect(league.matchups[0].rosters).toHaveLength(2);
    expect(league.matchups[0].rosters[0]).toMatchObject({
      ownerName: "Taylor",
      teamName: "Taylor Touchdowns"
    });
    expect(league.matchups[0].rosters[0].starters[0]).toMatchObject({
      id: "3139477",
      name: "Patrick Mahomes",
      position: "QB",
      proTeam: "KC",
      currentPoints: 18.4
    });
    expect(league.matchups[0].rosters[0].bench[0]).toMatchObject({
      name: "Bench Runner",
      position: "RB",
      proTeam: "DET"
    });
  });
});
