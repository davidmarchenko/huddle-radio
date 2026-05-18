import { describe, expect, it } from "vitest";
import { assessMomentCue, buildCommentaryText, createLivecastCommentary } from "../engine/livecastEngine";
import { rankFantasyImpacts } from "../engine/fantasyImpact";
import { demoLeagueState } from "../providers/demoData";
import { demoPlays } from "../providers/demoData";

describe("buildCommentaryText", () => {
  it("includes group context and avoids secret-like fields", () => {
    const text = buildCommentaryText({
      play: demoPlays[0],
      observation: {
        id: "obs",
        source: "stream-url",
        summary: "The quarterback extended the play on camera.",
        confidence: 0.9,
        observedAt: new Date().toISOString(),
        latencyMs: 80
      },
      group: {
        listener: { name: "Alex", rosterId: "roster-alex" },
        tone: "chaos",
        homeTeamBias: "fantasy-first",
        friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex", rivalryNotes: "keep it humble" }]
      },
      impacts: [
        {
          rosterId: "roster-alex",
          ownerName: "Alex",
          teamName: "Fourth & Snack",
          playerName: "Patrick Mahomes",
          isStarter: true,
          pointsDelta: 4.2,
          reason: "demo"
        }
      ],
      news: []
    });

    expect(text).toMatch(/group-chat alarm|standings just got personal|Nobody breathe/);
    expect(text).toContain("Alex");
    expect(text).not.toMatch(/api[_-]?key|secret|token/i);
  });

  it("uses tentative language for lower-confidence observations", () => {
    const text = buildCommentaryText({
      play: demoPlays[4],
      observation: {
        id: "obs",
        source: "screen-share",
        summary: "pressure showed up late",
        confidence: 0.5,
        observedAt: new Date().toISOString(),
        latencyMs: 80
      },
      group: {
        listener: { name: "Alex", rosterId: "roster-alex" },
        tone: "pg",
        homeTeamBias: "balanced",
        friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" }]
      },
      impacts: rankFantasyImpacts(demoLeagueState, demoPlays[4]),
      news: []
    });

    expect(text).toContain("Model read is tentative");
    expect(text).toContain("-2");
  });

  it("does not claim visual context when stream validation is unavailable", () => {
    const text = buildCommentaryText({
      play: demoPlays[0],
      observation: {
        id: "obs",
        source: "stream-url",
        summary: "YouTube embeds cannot be pixel-sampled.",
        confidence: 0,
        observedAt: new Date().toISOString(),
        latencyMs: 10,
        usedFrame: false,
        validation: {
          status: "unavailable",
          confidence: 0,
          evidence: ["YouTube embeds cannot be pixel-sampled."],
          reason: "Use screen share.",
          validatedAt: new Date().toISOString()
        }
      },
      group: {
        listener: { name: "Alex", rosterId: "roster-alex" },
        tone: "pg",
        homeTeamBias: "balanced",
        friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" }]
      },
      impacts: rankFantasyImpacts(demoLeagueState, demoPlays[0]),
      news: []
    });

    expect(text).toContain("Visual validation is unavailable");
    expect(text).toContain("official play feed");
  });

  it("avoids recently used opener phrasing when possible", () => {
    const first = buildCommentaryText({
      play: demoPlays[0],
      observation: {
        id: "obs",
        source: "stream-url",
        summary: "first summary",
        confidence: 0.9,
        observedAt: new Date().toISOString(),
        latencyMs: 80
      },
      group: {
        listener: { name: "Alex", rosterId: "roster-alex" },
        tone: "pg",
        homeTeamBias: "balanced",
        friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" }]
      },
      impacts: rankFantasyImpacts(demoLeagueState, demoPlays[0]),
      news: []
    });
    const second = buildCommentaryText({
      play: demoPlays[1],
      observation: {
        id: "obs",
        source: "stream-url",
        summary: "second summary",
        confidence: 0.9,
        observedAt: new Date().toISOString(),
        latencyMs: 80
      },
      group: {
        listener: { name: "Alex", rosterId: "roster-alex" },
        tone: "pg",
        homeTeamBias: "balanced",
        friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" }]
      },
      impacts: rankFantasyImpacts(demoLeagueState, demoPlays[1]),
      news: [],
      recentCommentary: [first]
    });

    expect(second.slice(0, 28)).not.toBe(first.slice(0, 28));
  });

  it("creates latency metrics and caps generated text length", () => {
    const commentary = createLivecastCommentary({
      league: demoLeagueState,
      play: demoPlays[1],
      observation: {
        id: "obs",
        source: "stream-url",
        summary: "summary",
        confidence: 0.9,
        observedAt: new Date().toISOString(),
        latencyMs: 42
      },
      group: {
        listener: { name: "Alex", rosterId: "roster-alex" },
        tone: "pg",
        homeTeamBias: "fantasy-first",
        friends: [{ id: "maya", name: "Maya", favoriteTeam: "DET", rosterId: "roster-maya" }]
      },
      news: [],
      startedAt: performance.now()
    });

    expect(commentary.latency.modelResponseMs).toBe(42);
    expect(commentary.text.length).toBeLessThanOrEqual(520);
    expect(commentary.fantasyImpacts.length).toBeGreaterThan(0);
    expect(commentary.moment.priority).toBeTruthy();
  });

  it("marks touchdown fantasy swings as interrupt-worthy moments", () => {
    const impacts = rankFantasyImpacts(demoLeagueState, demoPlays[1]);
    const moment = assessMomentCue({
      play: demoPlays[1],
      impacts,
      group: {
        listener: { name: "Alex", rosterId: "roster-alex" },
        tone: "pg",
        homeTeamBias: "fantasy-first",
        friends: [
          { id: "maya", name: "Maya", favoriteTeam: "DET", rosterId: "roster-maya" },
          { id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" }
        ]
      }
    });

    expect(moment.priority).toBe("interrupt");
    expect(moment.reasons).toContain("touchdown");
    expect(moment.targetFriendIds).toContain("maya");
  });

  it("keeps low-impact plays routine or notable", () => {
    const moment = assessMomentCue({
      play: demoPlays[7],
      impacts: [],
      group: {
        listener: { name: "Alex", rosterId: "roster-alex" },
        tone: "family",
        homeTeamBias: "balanced",
        friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" }]
      }
    });

    expect(["routine", "notable"]).toContain(moment.priority);
    expect(moment.score).toBeLessThan(76);
  });

  it("classifies a high-excitement non-NFL play as a major moment, not routine/notable", () => {
    // Mimics demoNbaPlays — type "other", excitement 5, listener owns
    // the player so a positive impact is in the mix. Without the
    // sport-agnostic boost this would stay "notable" and Maya/Theo
    // would never get the proper "major" framing for NBA shows.
    const moment = assessMomentCue({
      play: {
        id: "nba-1",
        type: "other",
        excitement: 5,
        clock: "0:14",
        period: { number: 4, kind: "quarter" },
        possession: "DEN",
        headline: "Jokić step-back three",
        description: "...",
        playerIds: ["den-pf-15"],
        team: "DEN",
        score: { away: 100, home: 98 },
        occurredAt: new Date().toISOString()
      },
      impacts: [
        { rosterId: "roster-alex-nba", ownerName: "Alex", teamName: "Crossover Kings", playerName: "Jokić", isStarter: true, pointsDelta: 4.0, reason: "" }
      ],
      group: {
        listener: { name: "Alex", rosterId: "roster-alex-nba" },
        tone: "pg",
        homeTeamBias: "fantasy-first",
        friends: [{ id: "alex", name: "Alex", favoriteTeam: "DEN", rosterId: "roster-alex-nba" }]
      }
    });
    expect(["major", "interrupt"]).toContain(moment.priority);
    expect(moment.reasons).toContain("high-stakes moment");
  });

  it("does not double-count excitement boost on NFL touchdowns", () => {
    // NFL touchdown gets the 32-point type boost; the new
    // sport-agnostic excitement boost should NOT also fire to keep
    // NFL scoring stable.
    const moment = assessMomentCue({
      play: demoPlays[1],
      impacts: rankFantasyImpacts(demoLeagueState, demoPlays[1]),
      group: {
        listener: { name: "Alex", rosterId: "roster-alex" },
        tone: "pg",
        homeTeamBias: "fantasy-first",
        friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" }]
      }
    });
    expect(moment.reasons).toContain("touchdown");
    expect(moment.reasons).not.toContain("high-stakes moment");
    expect(moment.reasons).not.toContain("notable moment");
  });

  it("honors forceHostId, overriding the deterministic selectHost pick", () => {
    // demoPlays[1] is a Kelce touchdown — selectHost would normally route
    // this to a non-Cam host (interrupt-priority might pick Cam, but the
    // listener's "tap a host" nudge should always win).
    const baseInputs = {
      league: demoLeagueState,
      play: demoPlays[1],
      observation: {
        id: "obs",
        source: "stream-url" as const,
        summary: "x",
        confidence: 0.9,
        observedAt: new Date().toISOString(),
        latencyMs: 10
      },
      group: {
        listener: { name: "Alex", rosterId: "roster-alex" },
        tone: "pg" as const,
        homeTeamBias: "fantasy-first" as const,
        friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" }]
      },
      news: [],
      startedAt: performance.now()
    };

    const forcedMaya = createLivecastCommentary({ ...baseInputs, forceHostId: "maya" });
    expect(forcedMaya.hostId).toBe("maya");

    const forcedTheo = createLivecastCommentary({ ...baseInputs, forceHostId: "theo" });
    expect(forcedTheo.hostId).toBe("theo");

    const forcedCam = createLivecastCommentary({ ...baseInputs, forceHostId: "cam" });
    expect(forcedCam.hostId).toBe("cam");
  });
});
