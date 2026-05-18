/**
 * End-to-end pipeline integration tests.
 *
 * Wires the actual local implementations of every layer (no LLM
 * keys required, no network) and runs a sequence of "ticks" to
 * verify the seams compose correctly:
 *
 *   enrichment aggregator → producer + arc planner → host LLM (local)
 *     → evaluator → eval-store feedback → claims extractor → store
 *     → next-tick callback enrichment
 *
 * Unit tests cover each piece in isolation; this catches the
 * between-layer bugs that hide in the wiring (a renamed field, a
 * silent type mismatch, a missing await).
 */

import { describe, expect, it, beforeEach } from "vitest";
import { EnrichmentAggregator } from "../providers/enrichment/aggregator";
import { CallbackEnrichmentProvider } from "../providers/enrichment/callbackProvider";
import { LocalProducer } from "../providers/producer/localProducer";
import { LocalCommentaryProvider } from "../providers/openAICommentaryProvider";
import { LocalEvaluator } from "../server/eval/localEvaluator";
import { LocalClaimsExtractor } from "../server/memory/localExtractor";
import { InMemoryClaimsStore } from "../server/memory/claimsStore";
import { ShowArcPlanner } from "../server/showArc/planner";
import {
  recordEvaluation,
  getRecentEvalSnapshot,
  _resetEvalStoreForTests
} from "../server/eval/evalStore";
import type { CommentaryDraftInput } from "../providers/commentaryPrompts";
import type { EnrichmentProvider } from "../providers/enrichment/types";
import type { EnrichmentSignal, SportsGameState } from "../shared/contracts";

function game(): SportsGameState {
  return {
    provider: "espn-scoreboard",
    gameId: "wnba-int-1",
    sport: "wnba",
    awayTeam: "SEA",
    homeTeam: "LV",
    awayMeta: { abbreviation: "SEA", shortName: "Storm", displayName: "Seattle Storm" },
    homeMeta: { abbreviation: "LV", shortName: "Aces", displayName: "Las Vegas Aces" },
    status: "live",
    currentPlay: {
      id: "play-q3-1",
      type: "other",
      excitement: 4,
      clock: "5:00",
      period: { number: 3, kind: "quarter" },
      possession: "LV",
      headline: "Wilson hits a three from the wing",
      description: "Wilson catch-and-shoot",
      playerIds: ["wilson"],
      team: "LV",
      score: { away: 60, home: 65 },
      occurredAt: new Date().toISOString()
    },
    recentPlays: [],
    updatedAt: new Date().toISOString()
  };
}

function baseDraft(): CommentaryDraftInput {
  const g = game();
  return {
    play: g.currentPlay!,
    observation: {
      id: "obs-1",
      source: "stream-url",
      summary: "live",
      confidence: 0.9,
      observedAt: new Date().toISOString(),
      latencyMs: 100,
      usedFrame: false
    },
    impacts: [],
    moment: {
      priority: "notable",
      headline: "Wilson three",
      summary: "",
      reasons: [],
      targetFriendIds: [],
      score: 0
    },
    group: { listener: { name: "Alex" }, tone: "pg", homeTeamBias: "fantasy-first", friends: [] },
    news: [],
    recentCommentary: [],
    fallbackText: "fallback"
  };
}

/** Stub enrichment provider that returns canned signals — used to
 *  exercise the aggregator/producer wiring without hitting the
 *  network. Always reports ready. */
function stubEnrichmentProvider(id: string, signals: EnrichmentSignal[]): EnrichmentProvider {
  return {
    id,
    label: id,
    gather: async () => signals,
    health: async () => ({ id, label: id, status: "ready", detail: "ok" })
  };
}

describe("pipeline integration", () => {
  beforeEach(() => {
    _resetEvalStoreForTests();
  });

  it("aggregator → producer → host LLM (local) → eval composes correctly for one tick", async () => {
    const fanSignal: EnrichmentSignal = {
      id: "fan-1",
      source: "reddit",
      kind: "reaction",
      text: "WILSON WHAT A SHOT THE ACES BENCH IS GOING WILD",
      score: 0.7,
      occurredAt: new Date().toISOString()
    };
    const aggregator = new EnrichmentAggregator({
      providers: [stubEnrichmentProvider("reddit-stub", [fanSignal])]
    });
    const producer = new LocalProducer();
    const arcPlanner = new ShowArcPlanner();
    const host = new LocalCommentaryProvider();
    const evaluator = new LocalEvaluator();

    // 1. Aggregator gathers cross-source signals.
    const enrichmentSignals = await aggregator.gather({ game: game() });
    expect(enrichmentSignals.length).toBeGreaterThan(0);
    expect(enrichmentSignals[0].source).toBe("reddit");

    // 2. Arc planner advances and emits a directive.
    const arcDirective = arcPlanner.tick({ game: game(), moment: baseDraft().moment });
    expect(arcDirective.position).toBe("cold-open");

    // 3. Producer reads the signals + arc directive + builds a directive.
    const draft: CommentaryDraftInput = { ...baseDraft(), enrichmentSignals };
    const producerDirective = await producer.produce({
      draft,
      priorShowState: "",
      arcDirective
    });
    expect(producerDirective.beats.length).toBeGreaterThan(0);
    expect(producerDirective.arcPosition).toBe("cold-open");

    // 4. Host LLM (local fallback) takes the directive into the draft input.
    const dialogue = await host.draft({ ...draft, directive: producerDirective });
    expect(dialogue.length).toBeGreaterThan(0);
    expect(dialogue[0].text.length).toBeGreaterThan(0);

    // 5. Evaluator judges the joined text — completing the loop.
    const judgement = await evaluator.evaluate({
      turnId: "tick-1",
      text: dialogue.map((l) => l.text).join(" "),
      recentCommentary: [],
      momentContext: "Wilson three",
      availableSources: ["enrichment", "play"]
    });
    expect(judgement.turnId).toBe("tick-1");
    expect(judgement.stayTuned).toBeGreaterThanOrEqual(0);
    expect(judgement.stayTuned).toBeLessThanOrEqual(10);
  });

  it("eval feedback closes the loop: low specificity flips producer toward stat-source enrichment", async () => {
    // Seed eval store with 4 low-specificity judgements so the
    // rolling snapshot reports below the producer's threshold.
    for (let i = 0; i < 4; i += 1) {
      recordEvaluation({
        turnId: `prior-${i}`,
        evaluator: "local-evaluator",
        scores: { specificity: 3, friction: 5, callbacks: 5, pacing: 5, anti_genericity: 5 },
        stayTuned: 5,
        rationale: "low specificity",
        evaluatedAt: new Date().toISOString()
      });
    }
    const evalSnapshot = getRecentEvalSnapshot(6);
    expect(evalSnapshot!.meanSpecificity).toBeLessThan(4.5);

    const fanSignal: EnrichmentSignal = {
      id: "fan-1",
      source: "reddit",
      kind: "reaction",
      text: "fans yelling about Wilson",
      score: 0.7,
      occurredAt: new Date().toISOString()
    };
    const statSignal: EnrichmentSignal = {
      id: "stat-1",
      source: "nba-stats",
      kind: "stat",
      text: "Wilson 12-of-15 from deep this game",
      score: 0.5,
      occurredAt: new Date().toISOString()
    };
    const aggregator = new EnrichmentAggregator({
      providers: [stubEnrichmentProvider("p", [fanSignal, statSignal])]
    });
    const enrichment = await aggregator.gather({ game: game() });
    const producer = new LocalProducer();
    const directive = await producer.produce({
      draft: { ...baseDraft(), enrichmentSignals: enrichment },
      priorShowState: "",
      evalSnapshot
    });
    const enrichBeat = directive.beats.find((b) => b.sourceKind === "enrichment");
    // Eval feedback should have steered the enrichment selection
    // toward the stat-source signal.
    expect(enrichBeat).toBeDefined();
    expect(enrichBeat!.topic).toContain("nba-stats");
  });

  it("claims extracted in show A surface as enrichment in show B", async () => {
    const store = new InMemoryClaimsStore();
    const extractor = new LocalClaimsExtractor();

    // Show A: Cam makes a prediction about Wilson.
    const showAClaims = await extractor.extract({
      listenerId: "alex",
      hostId: "cam",
      text:
        "Cam here — I'm telling you right now Wilson goes for 30 tonight, just call it. " +
        "She's been locked in all season and the matchup is right.",
      playPlayerIds: ["wilson"],
      teams: ["SEA", "LV"],
      sourceShowId: "show-a",
      capturedAt: new Date().toISOString()
    });
    expect(showAClaims.length).toBeGreaterThan(0);
    for (const claim of showAClaims) await store.save(claim);

    // Show B (a later show): the same listener tunes in to a Wilson
    // game. CallbackEnrichmentProvider should surface the prior
    // claim as an enrichment signal.
    const aggregator = new EnrichmentAggregator({
      providers: [new CallbackEnrichmentProvider({ store, listenerId: "alex" })]
    });
    const showBSignals = await aggregator.gather({ game: game() });
    expect(showBSignals.length).toBeGreaterThan(0);
    expect(showBSignals[0].text).toContain("goes for 30");

    // Show B's producer should pick the callback as a callback beat
    // (not generic enrichment) — the source-kind tag distinguishes
    // cross-show host claims from fan reactions / stats.
    const producer = new LocalProducer();
    const directive = await producer.produce({
      draft: { ...baseDraft(), enrichmentSignals: showBSignals, recentCommentary: [] },
      priorShowState: ""
    });
    const callbackBeat = directive.beats.find((b) => b.sourceKind === "callback");
    expect(callbackBeat).toBeDefined();
    expect(callbackBeat!.topic).toContain("goes for 30");
  });

  it("pivot mode flips the producer away from the play beat (counter-program)", async () => {
    const arcPlanner = new ShowArcPlanner({ now: () => Date.now() - 1000 * 60 * 10 }); // backdate so we're past cold-open
    arcPlanner.tick({ game: game() }); // burn the cold-open
    const blowoutGame = {
      ...game(),
      currentPlay: { ...game().currentPlay!, period: { number: 4, kind: "quarter" as const }, clock: "5:00", score: { away: 105, home: 70 } }
    };
    const arcDirective = arcPlanner.tick({ game: blowoutGame });
    expect(arcDirective.position).toBe("pivot");

    const producer = new LocalProducer();
    const directive = await producer.produce({
      draft: baseDraft(),
      priorShowState: "",
      arcDirective
    });
    // The first beat in pivot mode should be the counter-program
    // callback, not the standard play beat.
    expect(directive.beats[0].sourceKind).toBe("callback");
  });

  it("forced host (listener nudge) survives all the way through the producer", async () => {
    const producer = new LocalProducer();
    const draft = { ...baseDraft(), hostId: "cam" as const };
    const directive = await producer.produce({ draft, priorShowState: "" });
    // Every beat the producer emits should respect the forced lead.
    for (const beat of directive.beats) {
      expect(beat.leadHostId).toBe("cam");
    }
  });

  it("multi-tick: arc state carries forward across consecutive ticks on the same planner", async () => {
    const arcPlanner = new ShowArcPlanner();
    const t1 = arcPlanner.tick({ game: game() });
    const t2 = arcPlanner.tick({ game: game() });
    const t3 = arcPlanner.tick({ game: game() });
    expect(t1.position).toBe("cold-open");
    expect(t2.state.coldOpenDelivered).toBe(true);
    expect(t3.state.ticksDelivered).toBe(3);
  });
});
