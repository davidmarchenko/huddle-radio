import { describe, expect, it, vi } from "vitest";
import { EnrichmentAggregator } from "../providers/enrichment/aggregator";
import type { EnrichmentProvider } from "../providers/enrichment/types";
import type { EnrichmentSignal, SportsGameState } from "../shared/contracts";

const game: SportsGameState = {
  provider: "espn-scoreboard",
  gameId: "wnba-401856904",
  sport: "wnba",
  awayTeam: "SEA",
  homeTeam: "TOR",
  status: "live",
  recentPlays: [],
  updatedAt: new Date().toISOString()
};

function makeSignal(overrides: Partial<EnrichmentSignal> = {}): EnrichmentSignal {
  return {
    id: "default-id",
    source: "reddit",
    kind: "reaction",
    text: "Wilson hits a three from the wing",
    score: 0.5,
    occurredAt: new Date().toISOString(),
    ...overrides
  };
}

function makeProvider(id: string, signals: EnrichmentSignal[]): EnrichmentProvider {
  return {
    id,
    label: id,
    gather: async () => signals,
    health: async () => ({ id, label: id, status: "ready", detail: "ok" })
  };
}

describe("EnrichmentAggregator", () => {
  it("collapses duplicate ids, keeping the newest occurrence", async () => {
    const older = makeSignal({ id: "x", text: "old text", occurredAt: "2026-05-13T17:00:00Z" });
    const newer = makeSignal({ id: "x", text: "new text", occurredAt: "2026-05-13T17:05:00Z" });
    const aggregator = new EnrichmentAggregator({ providers: [makeProvider("p", [older, newer])] });
    const result = await aggregator.gather({ game });
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("new text");
  });

  it("collapses (source, refs.playId) duplicates, keeping the highest score", async () => {
    const lo = makeSignal({ id: "a", text: "okay take", score: 0.2, refs: { playId: "play-1" } });
    const hi = makeSignal({ id: "b", text: "great take", score: 0.9, refs: { playId: "play-1" } });
    const aggregator = new EnrichmentAggregator({ providers: [makeProvider("p", [lo, hi])] });
    const result = await aggregator.gather({ game });
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("great take");
  });

  it("collapses identical normalized text across sources, keeping the higher-trust source", async () => {
    // reddit (trust 35) vs nba-stats (trust 100) — same text after
    // normalization (just punctuation/casing differs).
    const fromReddit = makeSignal({ id: "r1", source: "reddit", text: "Wilson 3PT made!" });
    const fromStats = makeSignal({ id: "s1", source: "nba-stats", text: "Wilson 3pt made" });
    const aggregator = new EnrichmentAggregator({
      providers: [makeProvider("a", [fromReddit]), makeProvider("b", [fromStats])]
    });
    const result = await aggregator.gather({ game });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("nba-stats");
  });

  it("fuzzy-merges near-duplicates and folds the loser into voices", async () => {
    // Different phrasing of the same play; trust ranks decide winner.
    // Texts share enough word-tokens to cross the 3-gram Jaccard threshold.
    const reaction = makeSignal({
      id: "r1",
      source: "reddit",
      text: "Wilson hits a three pointer from deep range corner"
    });
    const officialStat = makeSignal({
      id: "s1",
      source: "nba-stats",
      text: "Wilson hits a three pointer from deep range corner shot"
    });
    const aggregator = new EnrichmentAggregator({
      providers: [makeProvider("a", [reaction]), makeProvider("b", [officialStat])]
    });
    const result = await aggregator.gather({ game });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("nba-stats");
    expect(result[0].voices?.[0].source).toBe("reddit");
  });

  it("keeps signals from different topics separate even with shared words", async () => {
    // Both mention Wilson but describe different plays — Jaccard of
    // 3-grams should stay below the 0.7 threshold.
    const a = makeSignal({ id: "a", text: "Wilson hits a three from the wing." });
    const b = makeSignal({ id: "b", text: "Wilson commits an offensive foul on the drive." });
    const aggregator = new EnrichmentAggregator({ providers: [makeProvider("p", [a, b])] });
    const result = await aggregator.gather({ game });
    expect(result).toHaveLength(2);
  });

  it("boosts signals tied to the active play", async () => {
    const onActive = makeSignal({
      id: "on",
      score: 0.5,
      text: "tied to the play in question",
      refs: { playId: "play-1" }
    });
    const offActive = makeSignal({
      id: "off",
      score: 0.5,
      text: "from a different moment entirely"
    });
    const aggregator = new EnrichmentAggregator({ providers: [makeProvider("p", [offActive, onActive])] });
    const result = await aggregator.gather({ game, activePlayId: "play-1" });
    expect(result[0].id).toBe("on");
  });

  it("decays older signals so fresh fan reactions outrank stale ones", async () => {
    const now = Date.UTC(2026, 4, 13, 17, 30, 0);
    const fresh = makeSignal({
      id: "fresh",
      score: 0.5,
      text: "just happened, fans losing it",
      occurredAt: new Date(now - 30_000).toISOString()
    });
    const stale = makeSignal({
      id: "stale",
      score: 0.6,
      text: "from a quarter ago, way less relevant",
      occurredAt: new Date(now - 15 * 60_000).toISOString()
    });
    const aggregator = new EnrichmentAggregator({
      providers: [makeProvider("p", [stale, fresh])],
      now: () => now
    });
    const result = await aggregator.gather({ game });
    // fresh (0.5 raw, decayed ~minimal) beats stale (0.6 raw,
    // decayed by ~3 half-lives = 0.6 * 0.125 = ~0.075).
    expect(result[0].id).toBe("fresh");
  });

  it("caps results at maxSignals", async () => {
    // Each text uses entirely different word stems so fuzzy dedup
    // doesn't collapse them — we want to verify the cap, not dedup.
    const distinctTexts = [
      "alpha bravo charlie delta echo",
      "foxtrot golf hotel india juliet",
      "kilo lima mike november oscar",
      "papa quebec romeo sierra tango",
      "uniform victor whiskey xray yankee",
      "zulu apple banana cherry dragon",
      "elephant flamingo giraffe hippo iguana",
      "jaguar koala lemur monkey newt",
      "octopus penguin quail rabbit snake",
      "tiger urchin vulture walrus xenops",
      "yak zebra anchor bridge candle",
      "drum engine forest garden harbor",
      "island jacket kettle ladder mountain",
      "needle ocean palace queen river",
      "stone tower umbrella valley window",
      "yellow zinc almond berry cactus",
      "diamond emerald flint granite hematite",
      "indigo jade kyanite lapis malachite",
      "nickel onyx pearl quartz ruby",
      "sapphire topaz uranium vanadium tungsten",
      "willow xylophone yarrow zinnia ash",
      "birch cedar dogwood elm fir",
      "ginkgo hickory ironwood juniper kapok",
      "larch maple nutmeg oak palm",
      "quince redwood spruce teak umbrella",
      "violet walnut yew acacia banyan",
      "chestnut date eucalyptus ficus gum",
      "hazel ivory junglewood kowhai linden",
      "magnolia neem olive pecan quaking",
      "rosewood sycamore tamarind ulmus vine"
    ];
    const signals = Array.from({ length: 30 }, (_, i) =>
      makeSignal({ id: `s${i}`, text: distinctTexts[i] })
    );
    const aggregator = new EnrichmentAggregator({
      providers: [makeProvider("p", signals)],
      maxSignals: 5
    });
    const result = await aggregator.gather({ game });
    expect(result).toHaveLength(5);
  });

  it("isolates provider failures: one throws, others still return", async () => {
    const flaky: EnrichmentProvider = {
      id: "flaky",
      label: "flaky",
      gather: async () => {
        throw new Error("upstream 500");
      },
      health: async () => ({ id: "flaky", label: "flaky", status: "error", detail: "down" })
    };
    const healthy = makeProvider("healthy", [makeSignal({ id: "ok", text: "still got this" })]);
    const aggregator = new EnrichmentAggregator({ providers: [flaky, healthy] });
    const result = await aggregator.gather({ game });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ok");
  });

  it("caches per-provider results within the cache window", async () => {
    const calls = vi.fn(async () => [makeSignal({ id: "x", text: "cached call" })]);
    const provider: EnrichmentProvider = {
      id: "p",
      label: "p",
      gather: calls,
      health: async () => ({ id: "p", label: "p", status: "ready", detail: "ok" })
    };
    let now = 0;
    const aggregator = new EnrichmentAggregator({
      providers: [provider],
      providerCacheMs: 1000,
      now: () => now
    });
    await aggregator.gather({ game });
    now += 500;
    await aggregator.gather({ game });
    expect(calls).toHaveBeenCalledTimes(1);
    now += 600;
    await aggregator.gather({ game });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("returns last cached signals when a previously-healthy provider starts failing", async () => {
    let shouldFail = false;
    const provider: EnrichmentProvider = {
      id: "p",
      label: "p",
      gather: async () => {
        if (shouldFail) throw new Error("now down");
        return [makeSignal({ id: "cached", text: "served from cache after outage" })];
      },
      health: async () => ({ id: "p", label: "p", status: "ready", detail: "ok" })
    };
    let now = 0;
    const aggregator = new EnrichmentAggregator({
      providers: [provider],
      providerCacheMs: 100,
      now: () => now
    });
    const first = await aggregator.gather({ game });
    expect(first).toHaveLength(1);
    shouldFail = true;
    now += 200; // cache expired
    const second = await aggregator.gather({ game });
    // Even though cache is expired and fresh fetch threw, we serve
    // the last cached signal so the show doesn't blank out mid-tick.
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe("cached");
  });
});
