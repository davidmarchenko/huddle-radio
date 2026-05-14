import { describe, expect, it, vi } from "vitest";
import { ProducerChain } from "../providers/producer/producerChain";
import { LocalProducer } from "../providers/producer/localProducer";
import { parseProducerOutput } from "../providers/producer/anthropicProducer";
import type { ProducerAgent, ProducerInput } from "../providers/producer/types";
import type { CommentaryDraftInput } from "../providers/commentaryPrompts";

function minimalDraft(): CommentaryDraftInput {
  return {
    play: {
      id: "p1",
      type: "other",
      excitement: 3,
      clock: "5:00",
      quarter: "Q3",
      possession: "SEA",
      headline: "Wilson buries a three",
      description: "Wilson catch-and-shoot",
      playerIds: ["wilson"],
      team: "SEA",
      score: { away: 60, home: 58 },
      occurredAt: new Date().toISOString()
    },
    observation: {
      id: "obs",
      source: "stream-url",
      summary: "live",
      confidence: 0.9,
      observedAt: new Date().toISOString(),
      latencyMs: 100,
      usedFrame: false
    },
    impacts: [],
    moment: { priority: "routine", headline: "", summary: "", reasons: [], targetFriendIds: [], score: 0 },
    group: { listener: { name: "Alex" }, tone: "pg", homeTeamBias: "fantasy-first", friends: [] },
    news: [],
    recentCommentary: [],
    fallbackText: "fallback"
  };
}

function inputFor(draft: CommentaryDraftInput = minimalDraft(), priorShowState = ""): ProducerInput {
  return { draft, priorShowState };
}

describe("ProducerChain", () => {
  it("returns the first successful producer's directive", async () => {
    const winner: ProducerAgent = {
      id: "winner",
      label: "Winner",
      produce: vi.fn(async () => ({
        beats: [{ topic: "x", angle: "y", leadHostId: "maya" as const, turnCount: 1 as const, sourceKind: "play" as const }],
        showState: "from winner"
      })),
      health: async () => ({ id: "winner", label: "Winner", status: "ready", detail: "ok" })
    };
    const fallback = new LocalProducer();
    const chain = new ProducerChain([winner, fallback]);
    const directive = await chain.produce(inputFor());
    expect(directive.showState).toBe("from winner");
    expect(chain.lastProducerId).toBe("winner");
    expect(chain.lastProduceErrors).toEqual([]);
  });

  it("falls through to the next producer when the first throws", async () => {
    const flaky: ProducerAgent = {
      id: "flaky",
      label: "Flaky",
      produce: vi.fn(async () => {
        throw new Error("upstream 503");
      }),
      health: async () => ({ id: "flaky", label: "Flaky", status: "error", detail: "down" })
    };
    const chain = new ProducerChain([flaky, new LocalProducer()]);
    const directive = await chain.produce(inputFor());
    expect(directive.beats.length).toBeGreaterThan(0);
    expect(chain.lastProducerId).toBe("local-producer");
    expect(chain.lastProduceErrors).toEqual([{ providerId: "flaky", message: "upstream 503" }]);
  });

  it("requires at least one producer in the chain", () => {
    expect(() => new ProducerChain([])).toThrow();
  });

  it("reports degraded health when only some producers are healthy", async () => {
    const broken: ProducerAgent = {
      id: "broken",
      label: "Broken",
      produce: vi.fn(),
      health: async () => {
        throw new Error("health rpc failed");
      }
    };
    const chain = new ProducerChain([broken, new LocalProducer()]);
    const health = await chain.health();
    // At least one healthy producer → chain is "ready" with the
    // ordered label string for diagnostics.
    expect(health.status).toBe("ready");
    expect(health.detail).toMatch(/Local Producer/);
  });
});

describe("parseProducerOutput", () => {
  it("parses well-formed JSON into a directive", () => {
    const raw = JSON.stringify({
      beats: [
        { topic: "Wilson hits 3", angle: "lead with the bucket", leadHostId: "cam", turnCount: 2, sourceKind: "play" },
        { topic: "Crowd losing it", angle: "paraphrase reddit", leadHostId: "maya", turnCount: 1, sourceKind: "enrichment" }
      ],
      showState: "Wilson hot in Q3, no callbacks open"
    });
    const directive = parseProducerOutput(raw);
    expect(directive.beats).toHaveLength(2);
    expect(directive.beats[0].leadHostId).toBe("cam");
    expect(directive.beats[1].sourceKind).toBe("enrichment");
    expect(directive.showState).toContain("Wilson");
  });

  it("strips code fences when the LLM adds them despite instructions", () => {
    const raw = "```json\n" + JSON.stringify({
      beats: [{ topic: "x", angle: "y", leadHostId: "maya", turnCount: 1, sourceKind: "play" }],
      showState: ""
    }) + "\n```";
    const directive = parseProducerOutput(raw);
    expect(directive.beats).toHaveLength(1);
  });

  it("clamps invalid leadHostId / sourceKind / turnCount to safe defaults", () => {
    const raw = JSON.stringify({
      beats: [{ topic: "x", angle: "y", leadHostId: "bart", turnCount: 99, sourceKind: "interview" }],
      showState: ""
    });
    const directive = parseProducerOutput(raw);
    expect(directive.beats[0].leadHostId).toBe("theo");
    expect(directive.beats[0].sourceKind).toBe("play");
    expect(directive.beats[0].turnCount).toBe(3);
  });

  it("drops beats with empty topics and throws if every beat is invalid", () => {
    const raw = JSON.stringify({
      beats: [{ topic: "", angle: "y", leadHostId: "maya", turnCount: 1, sourceKind: "play" }],
      showState: ""
    });
    expect(() => parseProducerOutput(raw)).toThrow(/no usable beats/);
  });

  it("caps the directive at 3 beats even when more are returned", () => {
    const raw = JSON.stringify({
      beats: Array.from({ length: 6 }, (_, i) => ({
        topic: `topic ${i}`,
        angle: "x",
        leadHostId: "theo",
        turnCount: 1,
        sourceKind: "play"
      })),
      showState: ""
    });
    const directive = parseProducerOutput(raw);
    expect(directive.beats).toHaveLength(3);
  });

  it("throws when the JSON is malformed", () => {
    expect(() => parseProducerOutput("not json")).toThrow();
  });
});
