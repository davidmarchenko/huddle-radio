import { describe, expect, it } from "vitest";
import { LocalProducer } from "../providers/producer/localProducer";
import type { CommentaryDraftInput } from "../providers/commentaryPrompts";
import type { ProducerInput } from "../providers/producer/types";

function baseDraft(overrides: Partial<CommentaryDraftInput> = {}): CommentaryDraftInput {
  return {
    play: {
      id: "play-1",
      type: "other",
      excitement: 3,
      clock: "5:42",
      period: { number: 3, kind: "quarter" },
      possession: "SEA",
      headline: "Wilson hits a three from the wing",
      description: "Wilson catch-and-shoot from 24",
      playerIds: ["wilson"],
      team: "SEA",
      score: { away: 62, home: 58 },
      occurredAt: new Date().toISOString()
    },
    observation: {
      id: "obs-1",
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
      listener: { name: "Alex" },
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

function input(overrides: Partial<CommentaryDraftInput> = {}, priorShowState = ""): ProducerInput {
  return { draft: baseDraft(overrides), priorShowState };
}

describe("LocalProducer", () => {
  it("always returns at least one beat anchored on the play (the floor)", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce(input());
    expect(directive.beats.length).toBeGreaterThanOrEqual(1);
    const playBeat = directive.beats.find((b) => b.sourceKind === "play");
    expect(playBeat).toBeDefined();
    expect(playBeat!.topic).toContain("Wilson");
  });

  it("leads with a listener cue when present (highest priority)", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce(
      input({
        listenerCues: [
          { id: "c1", text: "what's Mahomes' line tonight?", capturedAt: new Date().toISOString() }
        ]
      })
    );
    expect(directive.beats[0].sourceKind).toBe("listener");
    expect(directive.beats[0].leadHostId).toBe("theo");
    expect(directive.beats[0].topic).toContain("Mahomes");
  });

  it("includes a market-swing beat when a swing is provided", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce(
      input({
        marketSwing: {
          market: {
            source: "kalshi",
            externalId: "abc",
            sport: "wnba",
            marketKind: "moneyline",
            title: "Aces win",
            outcomeLabel: "yes",
            yesPriceCents: 64,
            observedAt: new Date().toISOString()
          },
          deltaCents: 8,
          direction: "warming"
        }
      })
    );
    const marketBeat = directive.beats.find((b) => b.sourceKind === "market");
    expect(marketBeat).toBeDefined();
    expect(marketBeat!.topic).toContain("8");
    expect(marketBeat!.leadHostId).toBe("cam");
  });

  it("uses the top enrichment signal and assigns Maya to stat-anchored sources", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce(
      input({
        enrichmentSignals: [
          {
            id: "s1",
            source: "nba-stats",
            kind: "stat",
            text: "Wilson is 12-of-15 from deep on the season at this distance",
            score: 0.9,
            occurredAt: new Date().toISOString()
          }
        ]
      })
    );
    const enrich = directive.beats.find((b) => b.sourceKind === "enrichment");
    expect(enrich).toBeDefined();
    expect(enrich!.leadHostId).toBe("maya");
    expect(enrich!.angle).toMatch(/stat-anchored/);
  });

  it("assigns Cam to fan-source enrichment beats", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce(
      input({
        enrichmentSignals: [
          {
            id: "s1",
            source: "reddit",
            kind: "reaction",
            text: "WILSON WHAT A SHOT FANS LOSING IT",
            score: 0.7,
            occurredAt: new Date().toISOString()
          }
        ]
      })
    );
    const enrich = directive.beats.find((b) => b.sourceKind === "enrichment");
    expect(enrich!.leadHostId).toBe("cam");
    expect(enrich!.angle).toMatch(/paraphrase/);
  });

  it("caps beats at 3 even when many high-priority signals fire at once", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce(
      input({
        listenerCues: [{ id: "c1", text: "thoughts on Wilson", capturedAt: new Date().toISOString() }],
        marketSwing: {
          market: {
            source: "kalshi",
            externalId: "abc",
            sport: "wnba",
            marketKind: "moneyline",
            title: "Aces win",
            outcomeLabel: "yes",
            yesPriceCents: 64,
            observedAt: new Date().toISOString()
          },
          deltaCents: 8,
          direction: "warming"
        },
        enrichmentSignals: [
          {
            id: "s1",
            source: "reddit",
            kind: "reaction",
            text: "fans are losing it",
            score: 0.7,
            occurredAt: new Date().toISOString()
          }
        ],
        pregameAngleHint: "Vegas line and total: what the book is saying"
      })
    );
    expect(directive.beats.length).toBeLessThanOrEqual(3);
    // Listener cue + market swing + enrichment fill the 3 slots —
    // play falls off, pregame falls off.
    expect(directive.beats.find((b) => b.sourceKind === "listener")).toBeDefined();
    expect(directive.beats.find((b) => b.sourceKind === "market")).toBeDefined();
  });

  it("scales turnCount up for major / interrupt moments", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce(
      input({
        moment: { priority: "interrupt", headline: "buzzer", summary: "buzzer-beater", reasons: ["buzzer-beater"], targetFriendIds: [], score: 1 }
      })
    );
    const playBeat = directive.beats.find((b) => b.sourceKind === "play");
    expect(playBeat!.turnCount).toBe(3);
    expect(playBeat!.angle).toMatch(/panel/);
  });

  it("keeps turnCount minimal for routine plays", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce(input());
    const playBeat = directive.beats.find((b) => b.sourceKind === "play");
    expect(playBeat!.turnCount).toBe(1);
  });

  it("emits a non-empty showState that references prior turns when present", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce(
      input({
        recentCommentary: ["earlier: Cam predicted Wilson for 30", "earlier: Theo pushed back"]
      })
    );
    expect(directive.showState).toMatch(/2 prior turn/);
  });

  it("emits a 'just opened' showState when no prior commentary exists", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce(input());
    expect(directive.showState).toMatch(/just opened/);
  });

  it("reports ready health", async () => {
    const producer = new LocalProducer();
    const health = await producer.health();
    expect(health.status).toBe("ready");
    expect(health.id).toBe("local-producer");
  });

  it("eval feedback: prefers a stat-source enrichment when specificity has been low", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce({
      ...input({
        enrichmentSignals: [
          { id: "f1", source: "reddit", kind: "reaction", text: "fans yelling about Wilson", score: 0.6, occurredAt: new Date().toISOString() },
          { id: "s1", source: "nba-stats", kind: "stat", text: "Wilson 12-of-15 from deep this game", score: 0.5, occurredAt: new Date().toISOString() }
        ]
      }),
      evalSnapshot: {
        sampleSize: 5,
        meanStayTuned: 5,
        meanSpecificity: 3.5, // LOW
        meanFriction: 6,
        meanCallbacks: 6,
        meanPacing: 7,
        meanAntiGenericity: 8
      }
    });
    const enrich = directive.beats.find((b) => b.sourceKind === "enrichment");
    expect(enrich!.topic).toContain("nba-stats");
    expect(enrich!.leadHostId).toBe("maya");
  });

  it("eval feedback: injects a callback corrective when callbacks have been low", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce({
      ...input({ recentCommentary: ["earlier: Cam predicted Wilson over 30"] }),
      evalSnapshot: {
        sampleSize: 5,
        meanStayTuned: 5,
        meanSpecificity: 7,
        meanFriction: 6,
        meanCallbacks: 3, // LOW
        meanPacing: 7,
        meanAntiGenericity: 8
      }
    });
    expect(directive.beats.find((b) => b.sourceKind === "callback")).toBeDefined();
  });

  it("banter mode: emits ONLY banter beats, no play/enrichment", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce({
      ...input({
        enrichmentSignals: [
          { id: "f1", source: "reddit", kind: "reaction", text: "fans yelling", score: 0.7, occurredAt: new Date().toISOString() }
        ]
      }),
      banterMode: true
    });
    expect(directive.beats.length).toBeGreaterThan(0);
    for (const beat of directive.beats) {
      expect(beat.sourceKind).toBe("banter");
    }
  });

  it("banter mode: anchors on an unacknowledged open thread when one exists", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce({
      ...input(),
      banterMode: true,
      rapportState: {
        ticksDelivered: 5,
        openThreads: [
          {
            id: "t1",
            text: "Wilson goes for 30",
            hostId: "cam",
            introducedTurnId: "x",
            introducedAt: new Date().toISOString(),
            acknowledged: false
          }
        ],
        runningBits: [],
        hostStanding: {
          maya: { recentLeads: [], ticksSinceLastSpoke: 1 },
          theo: { recentLeads: [], ticksSinceLastSpoke: 1 },
          cam: { recentLeads: [], ticksSinceLastSpoke: 1 }
        },
        tonal: { energy: 5 }
      }
    });
    expect(directive.beats[0].topic).toContain("Wilson goes for 30");
    expect(directive.beats[0].topic).toContain("cam");
  });

  it("banter mode: falls back to running bit when no open threads, then to generic filler", async () => {
    const producer = new LocalProducer();
    const withBit = await producer.produce({
      ...input(),
      banterMode: true,
      rapportState: {
        ticksDelivered: 5,
        openThreads: [],
        runningBits: [{ phrase: "wilson three", occurrences: 3, lastSeenTurnId: "t1" }],
        hostStanding: {
          maya: { recentLeads: [], ticksSinceLastSpoke: 1 },
          theo: { recentLeads: [], ticksSinceLastSpoke: 1 },
          cam: { recentLeads: [], ticksSinceLastSpoke: 1 }
        },
        tonal: { energy: 5 }
      }
    });
    expect(withBit.beats[0].topic).toContain("wilson three");

    const generic = await producer.produce({ ...input(), banterMode: true });
    expect(generic.beats[0].sourceKind).toBe("banter");
    expect(generic.beats[0].topic.length).toBeGreaterThan(0);
  });

  it("rapport: promotes a quiet host (4+ ticks silent) as the soft lead", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce({
      ...input(),
      rapportState: {
        ticksDelivered: 5,
        openThreads: [],
        runningBits: [],
        hostStanding: {
          maya: { recentLeads: [], ticksSinceLastSpoke: 0 },
          theo: { recentLeads: [], ticksSinceLastSpoke: 1 },
          cam: { recentLeads: [], ticksSinceLastSpoke: 5 } // CAM is quiet
        },
        tonal: { energy: 5 }
      }
    });
    // Cam should lead the play beat as the quiet host promotion.
    const playBeat = directive.beats.find((b) => b.sourceKind === "play");
    expect(playBeat!.leadHostId).toBe("cam");
  });

  it("rapport: forced host (nudge) overrides the quiet-host promotion", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce({
      ...input({ hostId: "maya" }),
      rapportState: {
        ticksDelivered: 5,
        openThreads: [],
        runningBits: [],
        hostStanding: {
          maya: { recentLeads: [], ticksSinceLastSpoke: 0 },
          theo: { recentLeads: [], ticksSinceLastSpoke: 1 },
          cam: { recentLeads: [], ticksSinceLastSpoke: 5 } // would otherwise promote
        },
        tonal: { energy: 5 }
      }
    });
    for (const beat of directive.beats) {
      expect(beat.leadHostId).toBe("maya");
    }
  });

  it("rapport: surfaces an open thread that fits the play as a callback beat", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce({
      ...input(),
      rapportState: {
        ticksDelivered: 5,
        // The thread mentions "wilson" — the play headline already
        // says "Wilson hits a three" so this should match.
        openThreads: [
          {
            id: "t1",
            text: "Wilson goes for 30 tonight",
            hostId: "cam",
            introducedTurnId: "x",
            introducedAt: new Date().toISOString(),
            acknowledged: false
          }
        ],
        runningBits: [],
        hostStanding: {
          maya: { recentLeads: [], ticksSinceLastSpoke: 1 },
          theo: { recentLeads: [], ticksSinceLastSpoke: 1 },
          cam: { recentLeads: [], ticksSinceLastSpoke: 1 }
        },
        tonal: { energy: 5 }
      }
    });
    const callback = directive.beats.find((b) => b.sourceKind === "callback");
    expect(callback).toBeDefined();
    expect(callback!.topic).toContain("cam earlier said");
  });

  describe("opener mode", () => {
    const ROSTER = {
      id: "r1",
      ownerName: "Alex",
      teamName: "Storm Surge",
      starters: [
        { id: "p1", name: "A'ja Wilson", position: "F", proTeam: "LV", projectedPoints: 42, currentPoints: 0 },
        { id: "p2", name: "Sabrina Ionescu", position: "G", proTeam: "NY", projectedPoints: 36, currentPoints: 0 },
        { id: "p3", name: "Breanna Stewart", position: "F", proTeam: "NY", projectedPoints: 30, currentPoints: 0 }
      ],
      bench: []
    };

    it("emits opener beats — none of the play / market / enrichment cascade", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input({
          listenerRoster: ROSTER,
          // These would normally drive the cascade — opener mode should ignore them.
          marketSwing: {
            market: {
              source: "kalshi",
              externalId: "abc",
              sport: "wnba",
              marketKind: "moneyline",
              title: "Aces win",
              outcomeLabel: "yes",
              yesPriceCents: 64,
              observedAt: new Date().toISOString()
            },
            deltaCents: 9,
            direction: "warming"
          },
          enrichmentSignals: [
            { id: "s1", source: "reddit", kind: "reaction", text: "fans yelling", score: 0.7, occurredAt: new Date().toISOString() }
          ]
        }),
        openerMode: true
      });
      expect(directive.beats.length).toBeGreaterThanOrEqual(2);
      // Opener should never include market or banter beats — those
      // are tick-time signal kinds.
      expect(directive.beats.find((b) => b.sourceKind === "market")).toBeUndefined();
      expect(directive.beats.find((b) => b.sourceKind === "banter")).toBeUndefined();
    });

    it("lead beat references the listener name and fantasy team", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input({ listenerRoster: ROSTER }),
        openerMode: true
      });
      const lead = directive.beats[0];
      expect(lead.topic).toContain("Alex");
      expect(lead.topic).toContain("Storm Surge");
    });

    it("second beat names the headliner starter when roster has starters", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input({ listenerRoster: ROSTER }),
        openerMode: true
      });
      const lineupBeat = directive.beats[1];
      expect(lineupBeat).toBeDefined();
      // Wilson has the highest projected points → headliner.
      expect(lineupBeat.topic).toContain("A'ja Wilson");
      expect(lineupBeat.sourceKind).toBe("enrichment");
    });

    it("pivots to the matchup when no roster is loaded — never invents players", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input({ listenerRoster: undefined }),
        openerMode: true
      });
      // Second beat should still exist but pivot to the matchup
      // rather than naming a fictional starter.
      const second = directive.beats[1];
      expect(second).toBeDefined();
      expect(second.topic).not.toContain("A'ja Wilson");
      // First beat addresses listener as 'you' rather than inventing a name.
      // (Alex IS the configured name in baseDraft, so it can use Alex.)
    });

    it("total turn budget fits ~45-60s of audio (sum of turnCounts ≤ 5)", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input({ listenerRoster: ROSTER }),
        openerMode: true
      });
      const total = directive.beats.reduce((sum, b) => sum + b.turnCount, 0);
      expect(total).toBeLessThanOrEqual(5);
    });

    it("respects a forced lead host on the lead beat", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input({ listenerRoster: ROSTER, hostId: "maya" }),
        openerMode: true
      });
      expect(directive.beats[0].leadHostId).toBe("maya");
    });

    it("references slate breadth when slateContext is set (discovery mode)", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input({
          listenerRoster: ROSTER,
          slateContext: {
            totalGames: 8,
            starterGames: 3,
            upcomingHighlights: ["Heat at Celtics", "Lakers at Nuggets"]
          }
        }),
        openerMode: true
      });
      const lead = directive.beats[0];
      expect(lead.topic).toContain("8");
      expect(lead.topic).toContain("3");
      expect(lead.topic).toMatch(/Heat at Celtics|Lakers at Nuggets/);
    });

    it("falls back to single-game opener when slateContext is absent", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input({ listenerRoster: ROSTER }),
        openerMode: true
      });
      const lead = directive.beats[0];
      // Single-game opener — the lead beat anchors on the matchup,
      // not on a slate count.
      expect(lead.topic).not.toMatch(/\b\d+\s*games tonight\b/i);
    });

    it("marks arc position as cold-open by default", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input({ listenerRoster: ROSTER }),
        openerMode: true
      });
      expect(directive.arcPosition).toBe("cold-open");
    });
  });

  describe("game-pivot mode", () => {
    it("emits a single handoff beat when the listener switches games mid-show", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input(),
        gamePivotMode: {
          fromSummary: "Storm 78, Aces 71 — final",
          toSummary: "Lakers @ Nuggets, just tipped — Mahomes-adjacent slate"
        }
      });
      expect(directive.beats).toHaveLength(1);
      expect(directive.beats[0].sourceKind).toBe("handoff");
      expect(directive.beats[0].turnCount).toBe(2);
    });

    it("names both the prior and incoming game in the handoff topic", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input(),
        gamePivotMode: {
          fromSummary: "Storm 78, Aces 71 — final",
          toSummary: "Lakers @ Nuggets, just tipped"
        }
      });
      expect(directive.beats[0].topic).toContain("Storm 78");
      expect(directive.beats[0].topic).toContain("Lakers @ Nuggets");
    });

    it("Theo leads the pivot by default — he's the show's anchor", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input(),
        gamePivotMode: { fromSummary: "old", toSummary: "new" }
      });
      expect(directive.beats[0].leadHostId).toBe("theo");
    });

    it("respects a forced lead host on the pivot beat", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input({ hostId: "cam" }),
        gamePivotMode: { fromSummary: "old", toSummary: "new" }
      });
      expect(directive.beats[0].leadHostId).toBe("cam");
    });

    it("marks the pivot as an act-break, not a close — the show isn't ending", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input(),
        gamePivotMode: { fromSummary: "old", toSummary: "new" }
      });
      expect(directive.arcPosition).toBe("act-break");
    });

    it("game-pivot wins over banter / opener when multiple modes are set (defensive)", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input(),
        gamePivotMode: { fromSummary: "old", toSummary: "new" },
        // Engine should never set both, but if it does, the pivot
        // wins because the structural transition is the true moment.
        banterMode: true,
        openerMode: true
      });
      expect(directive.beats).toHaveLength(1);
      expect(directive.beats[0].sourceKind).toBe("handoff");
    });

    it("showState surfaces the pivot so the next tick's producer sees the transition", async () => {
      const producer = new LocalProducer();
      const directive = await producer.produce({
        ...input(),
        gamePivotMode: {
          fromSummary: "Storm 78, Aces 71 — final",
          toSummary: "Lakers @ Nuggets — just tipped"
        }
      });
      expect(directive.showState).toMatch(/pivot/i);
      expect(directive.showState).toContain("Storm 78");
      expect(directive.showState).toContain("Lakers @ Nuggets");
    });
  });

  it("eval feedback: skips corrective when sampleSize is below the reliability floor", async () => {
    const producer = new LocalProducer();
    const directive = await producer.produce({
      ...input({ recentCommentary: ["earlier: Cam predicted Wilson over 30"] }),
      evalSnapshot: {
        sampleSize: 1, // BELOW reliability floor (3)
        meanStayTuned: 2,
        meanSpecificity: 2,
        meanFriction: 2,
        meanCallbacks: 2,
        meanPacing: 2,
        meanAntiGenericity: 2
      }
    });
    expect(directive.beats.find((b) => b.sourceKind === "callback")).toBeUndefined();
  });
});
