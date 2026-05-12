import { describe, expect, it } from "vitest";
import { buildPickSlate, parseMarketTitle } from "../server/picksGenerator";
import type { MarketSnapshot } from "../shared/contracts";

function makeMarket(overrides: Partial<MarketSnapshot>): MarketSnapshot {
  return {
    source: "polymarket",
    externalId: "x",
    sport: "nba",
    marketKind: "player-prop",
    title: "Will Jokic record over 28.5 points?",
    outcomeLabel: "Yes",
    yesPriceCents: 50,
    observedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("parseMarketTitle", () => {
  it("parses NBA points", () => {
    const parsed = parseMarketTitle("Will Jokic record over 28.5 points?", "nba");
    expect(parsed).toEqual({ playerName: "Jokic", statType: "points", line: 28.5 });
  });

  it("parses NFL passing yards with multi-word player", () => {
    const parsed = parseMarketTitle("Will Patrick Mahomes throw for 250+ yards?", "nfl");
    expect(parsed?.playerName).toBe("Patrick Mahomes");
    expect(parsed?.statType).toBe("passing-yards");
    // 250 (integer) → 249.5 to avoid push.
    expect(parsed?.line).toBe(249.5);
  });

  it("parses NFL receptions", () => {
    const parsed = parseMarketTitle("CeeDee Lamb over 5.5 receptions", "nfl");
    expect(parsed).toEqual({ playerName: "CeeDee Lamb", statType: "receptions", line: 5.5 });
  });

  it("parses MLB hits", () => {
    const parsed = parseMarketTitle("Will Aaron Judge get over 1.5 hits?", "mlb");
    expect(parsed?.playerName).toBe("Aaron Judge");
    expect(parsed?.statType).toBe("hits");
    expect(parsed?.line).toBe(1.5);
  });

  it("does not match cross-sport stat keywords", () => {
    // "yards" is NFL only — should not parse as an NBA prop
    const parsed = parseMarketTitle("Will the team total over 200.5 yards?", "nba");
    expect(parsed).toBeNull();
  });

  it("returns null for non-prop questions", () => {
    expect(parseMarketTitle("Will the Lakers win the title?", "nba")).toBeNull();
    expect(parseMarketTitle("", "nfl")).toBeNull();
  });

  it("rejects single-word player names too short to be real", () => {
    const parsed = parseMarketTitle("KC over 250.5 yards", "nfl");
    expect(parsed).toBeNull();
  });
});

describe("buildPickSlate", () => {
  it("builds a balanced slate from real markets", () => {
    const markets: MarketSnapshot[] = [
      makeMarket({ externalId: "a", title: "Will Jokic record over 28.5 points?" }),
      makeMarket({ externalId: "b", title: "Will Murray record over 6.5 assists?" }),
      makeMarket({ externalId: "c", title: "Will Edwards record over 4.5 rebounds?" }),
      makeMarket({ externalId: "d", title: "Will Edwards record over 1.5 threes?" }) // dropped: dupe player
    ];
    const slate = buildPickSlate({
      gameId: "nba-1",
      sport: "nba",
      teams: ["DEN", "MIN"],
      markets
    });
    expect(slate.props.map((p) => p.playerName)).toEqual(["Jokic", "Murray", "Edwards"]);
    expect(slate.synthetic).toBe(false);
  });

  it("caps stat-type frequency to 2 per slate", () => {
    const markets: MarketSnapshot[] = [
      makeMarket({ externalId: "a", title: "Will Jokic over 28.5 points?" }),
      makeMarket({ externalId: "b", title: "Will Murray over 18.5 points?" }),
      makeMarket({ externalId: "c", title: "Will Edwards over 22.5 points?" }) // dropped: 3rd "points"
    ];
    const slate = buildPickSlate({
      gameId: "nba-1",
      sport: "nba",
      teams: ["DEN", "MIN"],
      markets
    });
    const pointsProps = slate.props.filter((p) => p.statType === "points");
    expect(pointsProps).toHaveLength(2);
  });

  it("falls back to synthetic from roster when real markets are sparse", () => {
    const slate = buildPickSlate({
      gameId: "nba-2",
      sport: "nba",
      teams: ["LAL", "BOS"],
      markets: [makeMarket({ externalId: "a", title: "Will Davis over 22.5 points?" })],
      rosterStarters: [
        {
          id: "lebron",
          name: "LeBron James",
          position: "SF",
          proTeam: "LAL",
          projectedPoints: 30,
          currentPoints: 0
        },
        {
          id: "tatum",
          name: "Jayson Tatum",
          position: "SF",
          proTeam: "BOS",
          projectedPoints: 28,
          currentPoints: 0
        }
      ]
    });
    expect(slate.synthetic).toBe(true);
    expect(slate.props.length).toBeGreaterThanOrEqual(2);
    const sources = new Set(slate.props.map((p) => p.source));
    expect(sources.has("polymarket")).toBe(true);
    expect(sources.has("synthetic")).toBe(true);
  });

  it("returns empty when no markets and no roster", () => {
    const slate = buildPickSlate({
      gameId: "nba-3",
      sport: "nba",
      teams: ["LAL", "BOS"],
      markets: []
    });
    expect(slate.props).toHaveLength(0);
    expect(slate.synthetic).toBe(false);
  });
});
