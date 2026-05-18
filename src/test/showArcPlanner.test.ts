import { describe, expect, it } from "vitest";
import { ShowArcPlanner } from "../server/showArc/planner";
import type { MomentCue, SportsGameState } from "../shared/contracts";

function game(overrides: Partial<SportsGameState> = {}): SportsGameState {
  return {
    provider: "espn-scoreboard",
    gameId: "wnba-x",
    sport: "wnba",
    awayTeam: "SEA",
    homeTeam: "LV",
    status: "live",
    currentPlay: {
      id: "p1",
      type: "other",
      excitement: 3,
      clock: "5:30",
      period: { number: 2, kind: "quarter" },
      possession: "LV",
      headline: "play",
      description: "play",
      playerIds: [],
      team: "LV",
      score: { away: 50, home: 52 },
      occurredAt: new Date().toISOString()
    },
    recentPlays: [],
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function moment(priority: MomentCue["priority"]): MomentCue {
  return { priority, headline: "", summary: "", reasons: [], targetFriendIds: [], score: priority === "interrupt" ? 1 : 0 };
}

describe("ShowArcPlanner", () => {
  it("emits cold-open during the first 60 seconds, then advances to build", () => {
    let now = 1_000_000;
    const planner = new ShowArcPlanner({ now: () => now });
    const open = planner.tick({ game: game() });
    expect(open.position).toBe("cold-open");
    expect(open.pacing).toBe("build");

    now += 90_000; // 90s in
    const next = planner.tick({ game: game() });
    expect(next.position).toBe("build"); // tick #2 with cold open delivered
  });

  it("enters climax on a major moment and slows pacing", () => {
    let now = 1_000_000;
    const planner = new ShowArcPlanner({ now: () => now });
    planner.tick({ game: game() }); // cold-open
    now += 120_000;
    const big = planner.tick({ game: game(), moment: moment("major") });
    expect(big.position).toBe("climax");
    expect(big.pacing).toBe("slow-down");
  });

  it("burns down after a long climax stretch (cools to mid-show)", () => {
    let now = 1_000_000;
    const planner = new ShowArcPlanner({ now: () => now });
    planner.tick({ game: game() }); // cold-open
    now += 120_000;
    for (let i = 0; i < 3; i += 1) {
      planner.tick({ game: game(), moment: moment("major") });
      now += 30_000;
    }
    const burnDown = planner.tick({ game: game(), moment: moment("major") });
    expect(burnDown.position).toBe("mid-show");
    expect(burnDown.pacing).toBe("speed-up");
  });

  it("recommends a pivot when the game is a late blowout", () => {
    let now = 1_000_000;
    const planner = new ShowArcPlanner({ now: () => now });
    planner.tick({ game: game() }); // cold-open
    now += 600_000; // 10 min in
    const blowout = game({
      currentPlay: {
        ...game().currentPlay!,
        period: { number: 4, kind: "quarter" },
        clock: "5:00",
        score: { away: 105, home: 65 }
      }
    });
    const pivot = planner.tick({ game: blowout });
    expect(pivot.position).toBe("pivot");
    expect(pivot.pivotRecommended).toBe(true);
  });

  it("does NOT pivot in early quarters even if the score is lopsided (game can swing)", () => {
    let now = 1_000_000;
    const planner = new ShowArcPlanner({ now: () => now });
    planner.tick({ game: game() }); // cold-open
    now += 120_000;
    const earlyBlowout = game({
      currentPlay: {
        ...game().currentPlay!,
        period: { number: 2, kind: "quarter" },
        clock: "5:00",
        score: { away: 50, home: 20 }
      }
    });
    const directive = planner.tick({ game: earlyBlowout });
    expect(directive.pivotRecommended).toBe(false);
  });

  it("hits act-break at quarter boundaries", () => {
    let now = 1_000_000;
    const planner = new ShowArcPlanner({ now: () => now });
    planner.tick({ game: game() }); // cold-open
    now += 600_000; // far past cold-open
    const halftime = game({
      currentPlay: { ...game().currentPlay!, period: { number: 2, kind: "quarter" }, clock: "0:00", score: { away: 50, home: 52 } }
    });
    const directive = planner.tick({ game: halftime });
    expect(directive.position).toBe("act-break");
    expect(directive.pacing).toBe("slow-down");
  });

  it("hits close window in the final minutes of the last period", () => {
    let now = 1_000_000;
    const planner = new ShowArcPlanner({ now: () => now, expectedDurationSeconds: 120 });
    planner.tick({ game: game() }); // cold-open
    now += 100_000; // 100s in (≤30s remaining of expected duration)
    const lateGame = game({
      currentPlay: { ...game().currentPlay!, period: { number: 4, kind: "quarter" }, clock: "1:30", score: { away: 80, home: 79 } }
    });
    const directive = planner.tick({ game: lateGame });
    expect(directive.position).toBe("close");
  });

  it("tracks state — climacticMomentsSeen, ticksDelivered, hasPivoted", () => {
    let now = 1_000_000;
    const planner = new ShowArcPlanner({ now: () => now });
    planner.tick({ game: game() }); // tick 1, cold-open
    now += 60_000;
    planner.tick({ game: game(), moment: moment("major") }); // tick 2, climax
    now += 60_000;
    const directive = planner.tick({ game: game() }); // tick 3
    expect(directive.state.ticksDelivered).toBe(3);
    expect(directive.state.climacticMomentsSeen).toBe(1);
    expect(directive.state.coldOpenDelivered).toBe(true);
  });

  it("current() returns the directive without advancing state", () => {
    const planner = new ShowArcPlanner();
    const a = planner.current({ game: game() });
    const b = planner.current({ game: game() });
    expect(a.state.ticksDelivered).toBe(0);
    expect(b.state.ticksDelivered).toBe(0);
  });

  it("eval feedback: forces speed-up pacing when rolling stayTuned drops below 5", () => {
    let now = 1_000_000;
    const planner = new ShowArcPlanner({ now: () => now });
    planner.tick({ game: game() }); // cold-open
    now += 600_000;
    const slumping = planner.tick({
      game: game(),
      evalSnapshot: {
        sampleSize: 5,
        meanStayTuned: 4.2, // SLUMP
        meanSpecificity: 5,
        meanFriction: 5,
        meanCallbacks: 5,
        meanPacing: 5,
        meanAntiGenericity: 5
      }
    });
    expect(slumping.pacing).toBe("speed-up");
    expect(slumping.dramaticCue).toMatch(/eval feedback/i);
  });

  it("eval feedback: ignored on climax / pivot / cold-open (those positions own pacing)", () => {
    let now = 1_000_000;
    const planner = new ShowArcPlanner({ now: () => now });
    const inSlump = {
      sampleSize: 5,
      meanStayTuned: 3,
      meanSpecificity: 3,
      meanFriction: 3,
      meanCallbacks: 3,
      meanPacing: 3,
      meanAntiGenericity: 3
    };
    const open = planner.tick({ game: game(), evalSnapshot: inSlump });
    expect(open.position).toBe("cold-open");
    expect(open.pacing).toBe("build"); // cold-open's own pacing wins, not speed-up
  });

  it("eval feedback: ignored when sampleSize is below reliability floor", () => {
    let now = 1_000_000;
    const planner = new ShowArcPlanner({ now: () => now });
    planner.tick({ game: game() }); // cold-open
    now += 600_000;
    const directive = planner.tick({
      game: game(),
      evalSnapshot: {
        sampleSize: 1,
        meanStayTuned: 1,
        meanSpecificity: 1,
        meanFriction: 1,
        meanCallbacks: 1,
        meanPacing: 1,
        meanAntiGenericity: 1
      }
    });
    expect(directive.pacing).not.toBe("speed-up");
  });
});
