import { describe, expect, it } from "vitest";
import {
  buildCommentaryPayload,
  detectMarketSwings,
  resolveHostPersona,
  type CommentaryDraftInput
} from "../providers/commentaryPrompts";
import type { MarketSnapshot, GroupSettings, SportsPlay, VideoObservation } from "../shared/contracts";

const market = (overrides: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  source: "kalshi",
  externalId: overrides.externalId ?? "kx-1",
  sport: "nfl",
  marketKind: "moneyline",
  title: "Will the Chiefs win Sunday?",
  outcomeLabel: "Chiefs",
  yesPriceCents: 60,
  observedAt: "2026-05-10T20:00:00Z",
  ...overrides
});

const buildInput = (overrides: Partial<CommentaryDraftInput> = {}): CommentaryDraftInput => ({
  play: { id: "p1", description: "Run for 4", quarter: "Q1", clock: "10:00", playType: "rush", team: "KC", score: { away: 0, home: 0 }, playerIds: [], occurredAt: "2026-05-10T20:00:00Z" } as unknown as SportsPlay,
  observation: { summary: "live game", confidence: 0.9 } as unknown as VideoObservation,
  impacts: [],
  group: {
    listener: { name: "Alex" },
    friends: [],
    tone: "pg",
    homeTeamBias: "fantasy-first"
  } as GroupSettings,
  news: [],
  recentCommentary: [],
  fallbackText: "—",
  ...overrides
});

describe("buildCommentaryPayload markets handling", () => {
  it("includes up to 6 market snapshots in the payload", () => {
    const markets = Array.from({ length: 8 }, (_, i) =>
      market({ externalId: `m${i}`, yesPriceCents: 50 + i })
    );
    const payload = buildCommentaryPayload(buildInput({ markets }), resolveHostPersona("maya"));
    expect(payload.markets).toHaveLength(6);
    expect(payload.markets[0]!.yesCents).toBe(50);
  });

  it("emits a marketSwing block when one is provided", () => {
    const swing = {
      market: market({ yesPriceCents: 71 }),
      deltaCents: 9,
      direction: "warming" as const
    };
    const payload = buildCommentaryPayload(buildInput({ marketSwing: swing }), resolveHostPersona("maya"));
    expect(payload.marketSwing).toEqual({
      source: "kalshi",
      title: "Will the Chiefs win Sunday?",
      outcome: "Chiefs",
      fromCents: 62,
      toCents: 71,
      direction: "warming"
    });
  });

  it("yields null marketSwing and empty markets when none provided", () => {
    const payload = buildCommentaryPayload(buildInput(), resolveHostPersona("maya"));
    expect(payload.markets).toEqual([]);
    expect(payload.marketSwing).toBeNull();
  });
});

describe("detectMarketSwings", () => {
  it("returns undefined when no shared markets", () => {
    const current = [market({ externalId: "a" })];
    const previous = [market({ externalId: "b" })];
    expect(detectMarketSwings(current, previous)).toBeUndefined();
  });

  it("returns the largest absolute swing above threshold", () => {
    const current = [
      market({ externalId: "small", yesPriceCents: 53 }),
      market({ externalId: "big", yesPriceCents: 74 })
    ];
    const previous = [
      market({ externalId: "small", yesPriceCents: 50 }),
      market({ externalId: "big", yesPriceCents: 60 })
    ];
    const swing = detectMarketSwings(current, previous);
    expect(swing?.market.externalId).toBe("big");
    expect(swing?.deltaCents).toBe(14);
    expect(swing?.direction).toBe("warming");
  });

  it("ignores moves smaller than the threshold", () => {
    const current = [market({ yesPriceCents: 62 })];
    const previous = [market({ yesPriceCents: 60 })];
    expect(detectMarketSwings(current, previous, 5)).toBeUndefined();
  });

  it("flags cooling direction for negative delta", () => {
    const current = [market({ externalId: "x", yesPriceCents: 41 })];
    const previous = [market({ externalId: "x", yesPriceCents: 60 })];
    const swing = detectMarketSwings(current, previous);
    expect(swing?.direction).toBe("cooling");
    expect(swing?.deltaCents).toBe(-19);
  });
});
