/**
 * Routing tests for `selectCommentaryPrompt` — the single decision
 * point for which system prompt + payload variant the host LLM gets.
 * Covers all four cells of the matrix:
 *   { kind: opener | play } × { directive: present | absent }
 */
import { describe, expect, it } from "vitest";
import {
  buildDirectiveOpenerSystemPrompt,
  buildDirectivePlaySystemPrompt,
  buildOpenerSystemPrompt,
  buildPlaySystemPrompt,
  selectCommentaryPrompt,
  type CommentaryDraftInput
} from "../providers/commentaryPrompts";
import { resolveHostPersona } from "../providers/commentaryPrompts";
import type { ProducerDirective } from "../providers/producer/types";

function baseDraft(overrides: Partial<CommentaryDraftInput> = {}): CommentaryDraftInput {
  return {
    play: {
      id: "p1",
      type: "other",
      excitement: 3,
      clock: "5:00",
      quarter: "Q1",
      possession: "SEA",
      headline: "tip",
      description: "tip",
      playerIds: [],
      team: "SEA",
      score: { away: 0, home: 0 },
      occurredAt: new Date().toISOString()
    },
    observation: {
      id: "obs",
      source: "stream-url",
      summary: "live",
      confidence: 0.8,
      observedAt: new Date().toISOString(),
      latencyMs: 100,
      usedFrame: false
    },
    impacts: [],
    moment: { priority: "routine", headline: "", summary: "", reasons: [], targetFriendIds: [], score: 0 },
    group: {
      listener: { name: "Marc" },
      tone: "pg",
      homeTeamBias: "fantasy-first",
      friends: []
    },
    news: [],
    recentCommentary: [],
    fallbackText: "fallback",
    ...overrides
  };
}

function directive(overrides: Partial<ProducerDirective> = {}): ProducerDirective {
  return {
    beats: [
      { topic: "open the room", angle: "warm", leadHostId: "theo", turnCount: 2, sourceKind: "play" }
    ],
    showState: "fresh",
    ...overrides
  };
}

describe("selectCommentaryPrompt", () => {
  const persona = resolveHostPersona("theo");

  it("opener + directive present → directive opener prompt", () => {
    const { system } = selectCommentaryPrompt(
      baseDraft({ directive: directive() }),
      persona,
      "opener"
    );
    expect(system).toBe(buildDirectiveOpenerSystemPrompt(persona));
    expect(system).not.toBe(buildOpenerSystemPrompt(persona));
  });

  it("opener + no directive → legacy opener prompt", () => {
    const { system } = selectCommentaryPrompt(baseDraft(), persona, "opener");
    expect(system).toBe(buildOpenerSystemPrompt(persona));
  });

  it("opener + empty beats array → legacy opener prompt", () => {
    const { system } = selectCommentaryPrompt(
      baseDraft({ directive: directive({ beats: [] }) }),
      persona,
      "opener"
    );
    expect(system).toBe(buildOpenerSystemPrompt(persona));
  });

  it("play + directive present → directive play prompt", () => {
    const { system } = selectCommentaryPrompt(
      baseDraft({ directive: directive() }),
      persona,
      "play"
    );
    expect(system).toBe(buildDirectivePlaySystemPrompt(persona));
  });

  it("play + no directive → legacy play prompt", () => {
    const { system } = selectCommentaryPrompt(baseDraft(), persona, "play");
    expect(system).toBe(buildPlaySystemPrompt(persona));
  });

  it("directive payload omits raw fields and surfaces beats / arc / rapport", () => {
    const { payload } = selectCommentaryPrompt(
      baseDraft({
        directive: directive({
          arcPosition: "cold-open",
          beats: [
            { topic: "frame the room", angle: "warm", leadHostId: "theo", turnCount: 2, sourceKind: "play" },
            { topic: "pull on Wilson", angle: "stat-anchored", leadHostId: "maya", turnCount: 2, sourceKind: "enrichment" }
          ]
        }),
        // These would appear in the legacy payload but should be
        // dropped from the directive payload.
        markets: [
          {
            source: "kalshi",
            externalId: "abc",
            sport: "wnba",
            marketKind: "moneyline",
            title: "Aces win",
            outcomeLabel: "yes",
            yesPriceCents: 64,
            observedAt: new Date().toISOString()
          }
        ]
      }),
      persona,
      "opener"
    );
    const obj = payload as Record<string, unknown>;
    expect(obj.markets).toBeUndefined();
    expect(obj.news).toBeUndefined();
    expect(obj.directive).toBeDefined();
    const dir = obj.directive as Record<string, unknown>;
    expect(Array.isArray(dir.beats)).toBe(true);
    expect((dir.beats as unknown[]).length).toBe(2);
    expect(dir.arcPosition).toBe("cold-open");
  });
});
