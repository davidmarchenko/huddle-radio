import { describe, expect, it, beforeEach } from "vitest";
import {
  pickRelevantMarketsForGame,
  resetMarketsProviderState
} from "../server/marketsProvider";
import type { MarketSnapshot } from "../shared/contracts";

const market = (overrides: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  source: "kalshi",
  externalId: overrides.externalId ?? "test-1",
  sport: "nfl",
  marketKind: "moneyline",
  title: "Will the Chiefs win Sunday?",
  outcomeLabel: "Chiefs",
  yesPriceCents: 60,
  observedAt: "2026-05-10T20:00:00Z",
  ...overrides
});

beforeEach(() => {
  resetMarketsProviderState();
});

describe("pickRelevantMarketsForGame", () => {
  it("picks markets that mention the game's teams", () => {
    const snapshots = [
      market({ externalId: "match", title: "Will the Chiefs beat the Lions?", outcomeLabel: "Chiefs" }),
      market({ externalId: "miss", title: "Will Eagles win the NFC East?", outcomeLabel: "Yes" })
    ];
    const picks = pickRelevantMarketsForGame(snapshots, { sport: "nfl", teams: ["Chiefs", "Lions"] });
    expect(picks.map((p) => p.externalId)).toEqual(["match"]);
  });

  it("ranks moneyline above totals when both match", () => {
    const snapshots = [
      market({ externalId: "ml", marketKind: "moneyline", title: "Chiefs win?" }),
      market({ externalId: "tot", marketKind: "total", title: "Chiefs over 27.5 points?" })
    ];
    const picks = pickRelevantMarketsForGame(snapshots, { sport: "nfl", teams: ["Chiefs"] });
    expect(picks[0]!.externalId).toBe("ml");
  });

  it("boosts player-prop matches when a player name is supplied", () => {
    const snapshots = [
      market({ externalId: "team", marketKind: "moneyline", title: "Chiefs win?" }),
      market({ externalId: "prop", marketKind: "player-prop", title: "Mahomes over 285 pass yds?" })
    ];
    const picks = pickRelevantMarketsForGame(
      snapshots,
      { sport: "nfl", teams: ["Chiefs"], players: ["Mahomes"] }
    );
    expect(picks[0]!.externalId).toBe("prop");
  });

  it("filters by sport — NBA markets ignored for an NFL game", () => {
    const snapshots = [
      market({ externalId: "nfl", sport: "nfl", title: "Chiefs win?" }),
      market({ externalId: "nba", sport: "nba", title: "Chiefs basketball edition" })
    ];
    const picks = pickRelevantMarketsForGame(snapshots, { sport: "nfl", teams: ["Chiefs"] });
    expect(picks.map((p) => p.externalId)).toEqual(["nfl"]);
  });

  it("respects the limit parameter", () => {
    const snapshots = Array.from({ length: 6 }, (_, i) =>
      market({ externalId: `m${i}`, title: `Chiefs market ${i}` })
    );
    const picks = pickRelevantMarketsForGame(snapshots, { sport: "nfl", teams: ["Chiefs"] }, 2);
    expect(picks).toHaveLength(2);
  });
});
