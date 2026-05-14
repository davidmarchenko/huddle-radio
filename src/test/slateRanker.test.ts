import { describe, expect, it } from "vitest";
import { rankSlate, summarizeSlate } from "../server/slateRanker";
import type { FantasyRoster, GroupSettings, SportsGameOption } from "../shared/contracts";

function game(overrides: Partial<SportsGameOption> = {}): SportsGameOption {
  return {
    id: "g1",
    label: "Lakers at Nuggets",
    shortName: "LAL @ DEN",
    sport: "nba",
    awayTeam: "LAL",
    homeTeam: "DEN",
    score: { away: 0, home: 0 },
    status: "scheduled",
    startsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    detail: "Tonight",
    ...overrides
  };
}

function group(overrides: Partial<GroupSettings> = {}): GroupSettings {
  return {
    listener: { name: "Alex", favoriteTeam: "LV" },
    tone: "pg",
    homeTeamBias: "fantasy-first",
    friends: [],
    ...overrides
  };
}

function roster(starters: Array<{ name: string; proTeam: string; position?: string }>): FantasyRoster {
  return {
    id: "r1",
    ownerName: "Alex",
    teamName: "Storm Surge",
    starters: starters.map((s, i) => ({
      id: `p${i}`,
      name: s.name,
      position: s.position ?? "F",
      proTeam: s.proTeam,
      projectedPoints: 30,
      currentPoints: 0
    })),
    bench: []
  };
}

describe("rankSlate", () => {
  it("returns games in score order — starter > favorite team > marquee > liveness", () => {
    const ranked = rankSlate({
      candidates: [
        // Marquee-only, scheduled.
        game({ id: "g-marquee", awayTeam: "BOS", homeTeam: "NYK" }),
        // Listener has a starter on LV.
        game({ id: "g-starter", awayTeam: "LV", homeTeam: "PHX" }),
        // Listener's favorite team is LV but already scored via starter
        // — separate game with the favorite team only.
        game({ id: "g-favorite", awayTeam: "MIA", homeTeam: "ORL" })
      ],
      group: group({
        listener: { name: "Alex", favoriteTeam: "MIA" }
      }),
      listenerRoster: roster([{ name: "A'ja Wilson", proTeam: "LV" }])
    });
    expect(ranked[0].game.id).toBe("g-starter");
    expect(ranked[1].game.id).toBe("g-favorite");
    expect(ranked[2].game.id).toBe("g-marquee");
  });

  it("live games beat scheduled-soon games of equal personalization", () => {
    const ranked = rankSlate({
      candidates: [
        game({ id: "g-live", awayTeam: "MIA", homeTeam: "ORL", status: "live" }),
        game({ id: "g-soon", awayTeam: "MIA", homeTeam: "ORL", status: "scheduled", startsAt: new Date(Date.now() + 10 * 60_000).toISOString() })
      ],
      group: group()
    });
    expect(ranked[0].game.id).toBe("g-live");
  });

  it("final games sink to the bottom by default", () => {
    const ranked = rankSlate({
      candidates: [
        game({ id: "g-final", awayTeam: "MIA", homeTeam: "ORL", status: "final" }),
        game({ id: "g-scheduled", awayTeam: "ATL", homeTeam: "CHA", status: "scheduled", startsAt: new Date(Date.now() + 90 * 60_000).toISOString() })
      ],
      group: group()
    });
    expect(ranked[0].game.id).toBe("g-scheduled");
    expect(ranked[1].game.id).toBe("g-final");
  });

  it("counts a starter on EITHER team — fantasy points come from either side", () => {
    const ranked = rankSlate({
      candidates: [
        game({ id: "g-away", awayTeam: "LV", homeTeam: "ORL" }),
        game({ id: "g-home", awayTeam: "ORL", homeTeam: "LV" }),
        game({ id: "g-neither", awayTeam: "ATL", homeTeam: "CHA" })
      ],
      group: group(),
      listenerRoster: roster([{ name: "A'ja Wilson", proTeam: "LV" }])
    });
    expect(ranked[0].score).toBeGreaterThan(ranked[2].score);
    expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
  });

  it("ties broken by earliest startsAt — predictable order", () => {
    const early = new Date(Date.now() + 30 * 60_000).toISOString();
    const late = new Date(Date.now() + 90 * 60_000).toISOString();
    const ranked = rankSlate({
      candidates: [
        game({ id: "g-late", awayTeam: "ATL", homeTeam: "CHA", startsAt: late }),
        game({ id: "g-early", awayTeam: "ATL", homeTeam: "CHA", startsAt: early })
      ],
      group: group()
    });
    expect(ranked[0].game.id).toBe("g-early");
  });

  it("surfaces per-factor reasons so an editorial mismatch can be debugged", () => {
    const ranked = rankSlate({
      candidates: [game({ awayTeam: "LV", homeTeam: "LAL", status: "live" })],
      group: group({ listener: { name: "Alex", favoriteTeam: "LV" } }),
      listenerRoster: roster([{ name: "Wilson", proTeam: "LV" }])
    });
    const kinds = ranked[0].reasons.map((r) => r.kind);
    expect(kinds).toContain("starter-in-game");
    expect(kinds).toContain("favorite-team");
    expect(kinds).toContain("live-game");
  });

  it("friend-rivalry boost adds when a friend's team is in the game", () => {
    const withRivalry = rankSlate({
      candidates: [game({ id: "g-rival", awayTeam: "DAL", homeTeam: "PHI" })],
      group: group({
        friends: [{ id: "f1", name: "Sam", favoriteTeam: "DAL" }]
      })
    });
    const withoutRivalry = rankSlate({
      candidates: [game({ id: "g-rival", awayTeam: "DAL", homeTeam: "PHI" })],
      group: group()
    });
    expect(withRivalry[0].score).toBeGreaterThan(withoutRivalry[0].score);
  });
});

describe("summarizeSlate", () => {
  it("counts games where any of the listener's starter-teams plays", () => {
    const ranked = rankSlate({
      candidates: [
        game({ id: "g1", awayTeam: "LV", homeTeam: "ORL" }),
        game({ id: "g2", awayTeam: "NY", homeTeam: "CHI" }),
        game({ id: "g3", awayTeam: "ATL", homeTeam: "MIA" })
      ],
      group: group(),
      listenerRoster: roster([
        { name: "Wilson", proTeam: "LV" },
        { name: "Stewart", proTeam: "NY" }
      ])
    });
    const summary = summarizeSlate(ranked, {
      listenerStarterTeams: new Set(["LV", "NY"])
    });
    expect(summary.totalGames).toBe(3);
    expect(summary.starterGames).toBe(2);
  });

  it("upcomingHighlights names the next two games after the lead", () => {
    const ranked = rankSlate({
      candidates: [
        game({ id: "g1", awayTeam: "LAL", homeTeam: "BOS", status: "live" }),
        game({ id: "g2", awayTeam: "DEN", homeTeam: "GSW" }),
        game({ id: "g3", awayTeam: "MIA", homeTeam: "NYK" }),
        game({ id: "g4", awayTeam: "ATL", homeTeam: "CHA" })
      ],
      group: group()
    });
    const summary = summarizeSlate(ranked);
    expect(summary.upcomingHighlights).toHaveLength(2);
    expect(summary.upcomingHighlights[0]).toContain("at");
  });
});
