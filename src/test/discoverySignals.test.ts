import { describe, expect, it } from "vitest";
import { rankDiscoverySignalsForGame } from "../server/discoverySignals";
import type { GameOdds, MarketSnapshot, NewsItem, SportsGameOption } from "../shared/contracts";

function baseGame(overrides: Partial<SportsGameOption> = {}): SportsGameOption {
  return {
    id: "g1",
    label: "Lakers at Celtics",
    shortName: "LAL @ BOS",
    sport: "nba",
    awayTeam: "LAL",
    homeTeam: "BOS",
    score: { away: 0, home: 0 },
    status: "scheduled",
    startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    detail: "Tonight",
    awayMeta: { abbreviation: "LAL", displayName: "Los Angeles Lakers", shortName: "Lakers" },
    homeMeta: { abbreviation: "BOS", displayName: "Boston Celtics", shortName: "Celtics" },
    ...overrides
  };
}

function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    source: "kalshi",
    externalId: "abc",
    sport: "nba",
    marketKind: "moneyline",
    title: "Lakers vs Celtics — Lakers to win",
    outcomeLabel: "Lakers",
    yesPriceCents: 52,
    observedAt: new Date().toISOString(),
    ...overrides
  };
}

function news(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    id: "n1",
    title: "League news",
    source: "ESPN",
    publishedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("rankDiscoverySignalsForGame", () => {
  it("market swing beats every other signal kind", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame(),
      relevantMarkets: [market({ recentDeltaCents: 8, outcomeLabel: "Lakers", yesPriceCents: 64 })],
      sportNews: [news({ title: "Lakers stun Celtics in OT" })],
      odds: { gameId: "g1", sport: "nba", homeTeam: "BOS", awayTeam: "LAL", spread: 9.5, fetchedAt: new Date().toISOString() }
    });
    expect(signals[0].kind).toBe("market-swing");
    if (signals[0].kind === "market-swing") {
      expect(signals[0].deltaCents).toBe(8);
      expect(signals[0].direction).toBe("warming");
    }
  });

  it("ignores market moves below the swing threshold (< 5¢)", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame(),
      relevantMarkets: [market({ recentDeltaCents: 3 })],
      sportNews: []
    });
    expect(signals.find((s) => s.kind === "market-swing")).toBeUndefined();
  });

  it("falls back to market price when no swing but a market is present", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame(),
      relevantMarkets: [market({ recentDeltaCents: 0, yesPriceCents: 58 })],
      sportNews: []
    });
    expect(signals.some((s) => s.kind === "market-price")).toBe(true);
  });

  it("skips the underdog side of a binary market — 'No 86¢' is editorial nonsense", () => {
    // A binary "Will X win?" market often surfaces with both
    // outcomes; the "No" side priced at 86¢ means the team's
    // chances are 14%. That reads worse on a discovery card than
    // simply omitting the chip.
    const signals = rankDiscoverySignalsForGame({
      game: baseGame(),
      relevantMarkets: [
        market({ outcomeLabel: "Yes", yesPriceCents: 14 }),
        market({ outcomeLabel: "No", yesPriceCents: 86 })
      ],
      sportNews: []
    });
    expect(signals.find((s) => s.kind === "market-price")).toBeUndefined();
  });

  it("prefers the favored side of a market when both sides are passed", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame(),
      relevantMarkets: [
        market({ outcomeLabel: "Celtics", yesPriceCents: 62 }),
        market({ outcomeLabel: "Lakers", yesPriceCents: 38 })
      ],
      sportNews: []
    });
    const price = signals.find((s) => s.kind === "market-price");
    expect(price).toBeDefined();
    if (price?.kind === "market-price") {
      expect(price.outcomeLabel).toBe("Celtics");
      expect(price.yesCents).toBe(62);
    }
  });

  it("never emits both a market-swing AND a market-price chip — swing implies price", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame(),
      relevantMarkets: [market({ recentDeltaCents: 7 })],
      sportNews: []
    });
    const marketSignals = signals.filter((s) => s.kind === "market-swing" || s.kind === "market-price");
    expect(marketSignals).toHaveLength(1);
    expect(marketSignals[0].kind).toBe("market-swing");
  });

  it("personalized news (mentions a listener starter playerId) wins over generic news", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame(),
      relevantMarkets: [],
      sportNews: [
        news({ id: "n1", title: "Lakers add veteran", playerIds: [] }),
        news({ id: "n2", title: "Lebron expected to return tonight", playerIds: ["lebron"] })
      ],
      listenerStarterPlayerIds: ["lebron"]
    });
    const newsSignal = signals.find((s) => s.kind === "news");
    expect(newsSignal).toBeDefined();
    if (newsSignal?.kind === "news") {
      expect(newsSignal.headline).toContain("Lebron");
      expect(newsSignal.personalized).toBe(true);
    }
  });

  it("team news matched via the long-form team name", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame(),
      relevantMarkets: [],
      sportNews: [news({ title: "Boston Celtics announce starting five" })]
    });
    const newsSignal = signals.find((s) => s.kind === "news");
    expect(newsSignal).toBeDefined();
    if (newsSignal?.kind === "news") {
      expect(newsSignal.personalized).toBe(false);
    }
  });

  it("ignores news that doesn't mention either team", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame(),
      relevantMarkets: [],
      sportNews: [news({ title: "Heat sign new big man" })]
    });
    expect(signals.find((s) => s.kind === "news")).toBeUndefined();
  });

  it("surfaces a sharp line when |spread| >= 7", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame(),
      relevantMarkets: [],
      sportNews: [],
      odds: { gameId: "g1", sport: "nba", homeTeam: "BOS", awayTeam: "LAL", spread: 9.5, fetchedAt: new Date().toISOString() }
    });
    const line = signals.find((s) => s.kind === "sharp-line");
    expect(line).toBeDefined();
    if (line?.kind === "sharp-line") {
      expect(line.favorite).toBe("BOS"); // positive spread = home favored
    }
  });

  it("skips sharp-line chip for thin spreads (< 7)", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame(),
      relevantMarkets: [],
      sportNews: [],
      odds: { gameId: "g1", sport: "nba", homeTeam: "BOS", awayTeam: "LAL", spread: 3.5, fetchedAt: new Date().toISOString() }
    });
    expect(signals.find((s) => s.kind === "sharp-line")).toBeUndefined();
  });

  it("national broadcast surfaces as a low-priority chip when nothing richer is available", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame({ broadcast: "ESPN" }),
      relevantMarkets: [],
      sportNews: []
    });
    const broadcast = signals.find((s) => s.kind === "broadcast");
    expect(broadcast).toBeDefined();
    if (broadcast?.kind === "broadcast") expect(broadcast.channel).toBe("ESPN");
  });

  it("ignores local-affiliate broadcasts — not editorial signal", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame({ broadcast: "KIRO 7 Seattle" }),
      relevantMarkets: [],
      sportNews: []
    });
    expect(signals.find((s) => s.kind === "broadcast")).toBeUndefined();
  });

  it("caps output at 2 signals even when many are eligible", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame({ broadcast: "ESPN" }),
      relevantMarkets: [market({ recentDeltaCents: 8 })],
      sportNews: [news({ title: "Lakers add veteran", playerIds: ["lebron"] })],
      listenerStarterPlayerIds: ["lebron"],
      odds: { gameId: "g1", sport: "nba", homeTeam: "BOS", awayTeam: "LAL", spread: 9.5, fetchedAt: new Date().toISOString() }
    });
    expect(signals.length).toBeLessThanOrEqual(2);
    // Strongest two should come through: market swing + personalized news.
    expect(signals[0].kind).toBe("market-swing");
    expect(signals[1].kind).toBe("news");
  });

  it("empty inputs → no signals (defensive)", () => {
    const signals = rankDiscoverySignalsForGame({
      game: baseGame(),
      relevantMarkets: [],
      sportNews: []
    });
    expect(signals).toEqual([]);
  });
});
