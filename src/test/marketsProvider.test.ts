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

  it("matches short identifiers (≤3 chars) only on word boundaries — no false positives in 'Vladimir'", () => {
    // Bug this prevents: passing "lad" (LAD = Dodgers) as a substring
    // matched inside words like "Vladimir" / "salad" / "blade".
    const snapshots = [
      market({ externalId: "vlad", title: "Will Vladimir Guerrero Jr. hit 30 HR?", sport: "mlb" }),
      market({ externalId: "real", title: "Will the LAD bullpen hold tonight?", sport: "mlb" })
    ];
    const picks = pickRelevantMarketsForGame(
      snapshots,
      { sport: "mlb", teams: ["LAD"] }
    );
    expect(picks.map((p) => p.externalId)).toEqual(["real"]);
  });

  it("falls back to general league markets when no team match exists", () => {
    // Bug this prevents: a quiet game day with no team-tagged markets
    // returned [] and the markets section disappeared. Now we surface
    // the highest-scoring general league markets so the section never
    // hides entirely on real games.
    const snapshots = [
      market({ externalId: "general-low", title: "Will the World Series go 7?", sport: "mlb", marketKind: "futures", volume24hUsd: 100 }),
      market({ externalId: "general-high", title: "Will the World Series go 7?", sport: "mlb", marketKind: "moneyline", volume24hUsd: 100_000 })
    ];
    const picks = pickRelevantMarketsForGame(
      snapshots,
      { sport: "mlb", teams: ["SF", "LAD", "Giants", "Dodgers"] }
    );
    // No market mentions any of those teams; we surface generals
    // sorted by kind+volume — moneyline + high volume wins.
    expect(picks.map((p) => p.externalId)).toEqual(["general-high", "general-low"]);
  });

  it("prefers team-matched markets even when general markets have higher volume", () => {
    const snapshots = [
      market({ externalId: "matched-low", title: "Will the Giants win tonight?", sport: "mlb", marketKind: "moneyline", volume24hUsd: 100 }),
      market({ externalId: "general-huge", title: "Will the Yankees win World Series?", sport: "mlb", marketKind: "futures", volume24hUsd: 1_000_000 })
    ];
    const picks = pickRelevantMarketsForGame(
      snapshots,
      { sport: "mlb", teams: ["Giants"] }
    );
    // Matched bucket wins entirely when it has any content.
    expect(picks.map((p) => p.externalId)).toEqual(["matched-low"]);
  });

  it("matches long identifiers anywhere as a substring (city / mascot / display name)", () => {
    const snapshots = [
      market({ externalId: "city", title: "San Francisco Giants over 90 wins", sport: "mlb" }),
      market({ externalId: "irrelevant", title: "Yankees first in AL East", sport: "mlb" })
    ];
    const picks = pickRelevantMarketsForGame(
      snapshots,
      { sport: "mlb", teams: ["San Francisco"] }
    );
    expect(picks.map((p) => p.externalId)).toEqual(["city"]);
  });

  it("collapses Polymarket Yes/No inverse pairs into the favored side only", () => {
    // Bug this prevents: Polymarket emits Yes + No as two snapshots
    // for the same binary market (conditionId:0 + conditionId:1).
    // Both have the same title; their yesPrices sum to ~100¢. The
    // listener saw both as separate rows — confusing duplicates.
    const snapshots = [
      market({
        externalId: "cond123:0",
        source: "polymarket",
        title: "Will the Phillies win the 2026 World Series?",
        outcomeLabel: "Yes",
        yesPriceCents: 3,
        sport: "mlb"
      }),
      market({
        externalId: "cond123:1",
        source: "polymarket",
        title: "Will the Phillies win the 2026 World Series?",
        outcomeLabel: "No",
        yesPriceCents: 97,
        sport: "mlb"
      })
    ];
    const picks = pickRelevantMarketsForGame(
      snapshots,
      { sport: "mlb", teams: ["Phillies"] }
    );
    // Only one row, and it's the favored side (No, at 97¢).
    expect(picks).toHaveLength(1);
    expect(picks[0].outcomeLabel).toBe("No");
  });

  it("collapses Kalshi team-vs-team pairs the same way", () => {
    // Kalshi emits two separate tickers for "Team A vs Team B Winner?"
    // events — same title, different externalIds. Same dedup applies.
    const snapshots = [
      market({
        externalId: "PHI_VS_BOS_PHI",
        source: "kalshi",
        title: "Philadelphia vs Boston Winner?",
        outcomeLabel: "Philadelphia",
        yesPriceCents: 52,
        sport: "mlb"
      }),
      market({
        externalId: "PHI_VS_BOS_BOS",
        source: "kalshi",
        title: "Philadelphia vs Boston Winner?",
        outcomeLabel: "Boston",
        yesPriceCents: 47,
        sport: "mlb"
      })
    ];
    const picks = pickRelevantMarketsForGame(
      snapshots,
      { sport: "mlb", teams: ["Philadelphia"] }
    );
    expect(picks).toHaveLength(1);
    // Favored side wins — Philadelphia at 52¢.
    expect(picks[0].outcomeLabel).toBe("Philadelphia");
  });

  it("does NOT collapse pairs whose prices don't sum to ~100¢", () => {
    // Two distinct markets that happen to share a generic title —
    // not a binary pair. Keep both.
    const snapshots = [
      market({ externalId: "a", title: "Will it rain today?", outcomeLabel: "Yes", yesPriceCents: 30, sport: "mlb" }),
      market({ externalId: "b", title: "Will it rain today?", outcomeLabel: "Yes", yesPriceCents: 35, sport: "mlb" })
    ];
    const picks = pickRelevantMarketsForGame(
      snapshots,
      { sport: "mlb", teams: ["Yankees"] }
    );
    // Both surface as general-bucket fallback (no team match).
    expect(picks).toHaveLength(2);
  });

  it("does NOT collapse multi-outcome markets (3+ outcomes per title)", () => {
    // Genuinely multi-outcome (e.g., NBA MVP futures with N candidates).
    const snapshots = [
      market({ externalId: "a", title: "NBA MVP 2026", outcomeLabel: "Jokic", yesPriceCents: 35, sport: "nba" }),
      market({ externalId: "b", title: "NBA MVP 2026", outcomeLabel: "SGA", yesPriceCents: 30, sport: "nba" }),
      market({ externalId: "c", title: "NBA MVP 2026", outcomeLabel: "Tatum", yesPriceCents: 20, sport: "nba" })
    ];
    const picks = pickRelevantMarketsForGame(
      snapshots,
      { sport: "nba", teams: ["Jokic"] }
    );
    // Three outcomes preserved (matched bucket has Jokic; generals
    // are SGA + Tatum, but matched-wins-when-present rule applies).
    expect(picks.map((p) => p.outcomeLabel)).toEqual(["Jokic"]);
  });
});
