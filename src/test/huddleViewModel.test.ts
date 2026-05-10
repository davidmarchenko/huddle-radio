import { describe, expect, it } from "vitest";
import { createLivecastCommentary } from "../engine/livecastEngine";
import { demoLeagueState, demoNbaLeagueState, demoPlays } from "../providers/demoData";
import {
  buildFantasySpotlight,
  buildFriendMatchups,
  buildHostTurns,
  buildListenerGameSpotlights,
  buildListenerRecapHighlight,
  buildListenerStakes,
  buildMatchupStory,
  buildRecapSummary,
  buildSetupSteps,
  buildTonightAtAGlance,
  deriveHuddlePhase
} from "../client/huddleViewModel";
import type { FantasyImpact, GroupSettings, LivecastCommentary, SportsGameOption, SportsGameState, VideoObservation } from "../shared/contracts";

const group: GroupSettings = {
  listener: { name: "Alex", rosterId: "roster-alex" },
  tone: "pg",
  homeTeamBias: "fantasy-first",
  friends: [
    { id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" },
    { id: "maya", name: "Maya", favoriteTeam: "DET", rosterId: "roster-maya" }
  ]
};

const observation: VideoObservation = {
  id: "obs-1",
  source: "stream-url",
  summary: "Official play feed is the source of truth.",
  confidence: 0.8,
  observedAt: new Date().toISOString(),
  latencyMs: 12,
  usedFrame: false
};

describe("huddle view model", () => {
  it("selects the correct phase across setup, live, no-stream, and recap states", () => {
    expect(deriveHuddlePhase({ showPrepared: false, isLive: false, hasVideoSource: false, commentaryCount: 0 })).toBe("empty");
    expect(deriveHuddlePhase({ showPrepared: true, isLive: false, hasVideoSource: false, commentaryCount: 0 })).toBe("pregame");
    expect(deriveHuddlePhase({ showPrepared: true, isLive: true, hasVideoSource: true, commentaryCount: 0 })).toBe("live");
    expect(deriveHuddlePhase({ showPrepared: true, isLive: true, hasVideoSource: false, commentaryCount: 0 })).toBe("live-audio");
    expect(deriveHuddlePhase({ showPrepared: true, isLive: false, hasVideoSource: false, commentaryCount: 1 })).toBe("recap");
  });

  it("builds setup steps that explain demo and stream paths", () => {
    const steps = buildSetupSteps({ providerMode: "demo", sportsDataMode: "demo", hasVideoSource: false, friendCount: 2 });
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({ id: "fantasy", state: "next" });
    expect(steps[2].body).toContain("screen share");
    expect(steps[3]).toMatchObject({ id: "hosts", state: "ready" });
  });

  it("derives host turns from commentary and falls back to pregame host banter", () => {
    const commentary = createLivecastCommentary({
      league: demoLeagueState,
      play: demoPlays[1],
      observation,
      group,
      news: [],
      startedAt: performance.now()
    });

    const liveTurns = buildHostTurns({ commentary: [commentary], game: undefined, group });
    // Host is selected by the engine based on moment + impacts, not round-robin.
    // The client should honor whichever host the engine assigned.
    expect(liveTurns[0].host.id).toBe(commentary.hostId);
    expect(liveTurns[0].text).toContain(demoPlays[1].headline);

    const pregameTurns = buildHostTurns({ commentary: [], game: undefined, group });
    expect(pregameTurns.map((turn) => turn.host.name)).toEqual(["Maya", "Theo", "Cam"]);
  });

  it("summarizes matchup, spotlight, and recap without backend contract changes", () => {
    const commentary = createLivecastCommentary({
      league: demoLeagueState,
      play: demoPlays[1],
      observation,
      group,
      news: [],
      startedAt: performance.now()
    });

    expect(buildMatchupStory(demoLeagueState).line).toContain("leads");
    expect(buildFantasySpotlight({ impacts: commentary.fantasyImpacts, league: demoLeagueState }).title).toContain("+");
    expect(buildRecapSummary({ commentary: [commentary], league: demoLeagueState }).turningPoint).toBe(demoPlays[1].headline);
  });
});

const nflGame: SportsGameState = {
  provider: "demo",
  gameId: "demo-kc-det",
  sport: "nfl",
  awayTeam: "KC",
  homeTeam: "DET",
  status: "demo",
  recentPlays: [],
  updatedAt: new Date().toISOString()
};

const nbaGame: SportsGameState = {
  provider: "demo",
  gameId: "demo-den-okc",
  sport: "nba",
  awayTeam: "DEN",
  homeTeam: "OKC",
  status: "demo",
  recentPlays: [],
  updatedAt: new Date().toISOString()
};

const allLeagues = [demoLeagueState, demoNbaLeagueState];

describe("buildListenerStakes (multi-sport)", () => {
  it("picks the listener's NFL roster when the active game is NFL", () => {
    const stakes = buildListenerStakes({
      group,
      leagues: allLeagues,
      game: nflGame
    });
    expect(stakes?.status).toBe("ready");
    expect(stakes?.teamName).toBe("Fourth & Snack");
    // KC and DET are both in this game — Mahomes (KC) and St. Brown (DET).
    expect(stakes?.startersInGame.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Patrick Mahomes", "Amon-Ra St. Brown"])
    );
  });

  it("switches to the NBA roster when the active game is NBA", () => {
    const stakes = buildListenerStakes({
      group: { ...group, listener: { ...group.listener, rosterId: "roster-alex-nba" } },
      leagues: allLeagues,
      game: nbaGame
    });
    expect(stakes?.status).toBe("ready");
    expect(stakes?.teamName).toBe("Crossover Kings");
    // DEN (Jokić) and OKC (SGA) are both in this game.
    expect(stakes?.startersInGame.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Nikola Jokić", "Shai Gilgeous-Alexander"])
    );
  });

  it("returns no-roster status with a sport-aware message when the listener has no league for the sport", () => {
    const stakes = buildListenerStakes({
      group,
      leagues: [demoLeagueState], // only NFL
      game: nbaGame
    });
    expect(stakes?.status).toBe("no-roster");
    expect(stakes?.stakesLine).toMatch(/NBA/);
  });

  it("flips lead/trail copy based on margin sign", () => {
    const ownerName = demoLeagueState.matchups[0].rosters.find((r) => r.id !== "roster-alex")!.ownerName;
    const lead = buildListenerStakes({ group, leagues: [demoLeagueState], game: nflGame });
    expect(lead?.stakesLine).toMatch(new RegExp(`Up|Down|Dead even with ${ownerName}`));
    expect(lead?.margin).toBeTypeOf("number");
  });
});

describe("buildListenerGameSpotlights (multi-sport aggregation)", () => {
  const games: SportsGameOption[] = [
    {
      id: "demo-kc-det",
      label: "KC at DET",
      shortName: "KC @ DET",
      sport: "nfl",
      awayTeam: "KC",
      homeTeam: "DET",
      score: { away: 0, home: 0 },
      status: "demo",
      detail: ""
    },
    {
      id: "demo-den-okc",
      label: "DEN at OKC",
      shortName: "DEN @ OKC",
      sport: "nba",
      awayTeam: "DEN",
      homeTeam: "OKC",
      score: { away: 0, home: 0 },
      status: "demo",
      detail: ""
    },
    {
      id: "demo-bos-dal",
      label: "BOS at DAL",
      shortName: "BOS @ DAL",
      sport: "nba",
      awayTeam: "BOS",
      homeTeam: "DAL",
      score: { away: 0, home: 0 },
      status: "demo",
      detail: ""
    }
  ];

  it("surfaces games for every sport the listener has a roster in", () => {
    // The default group's rosterId is the NFL one; auto-match by ownerName
    // catches the NBA Alex too (both rosters are owned by "Alex").
    const result = buildListenerGameSpotlights({
      games,
      leagues: allLeagues,
      group: { ...group, listener: { ...group.listener, rosterId: undefined } }
    });
    expect(result.has("demo-kc-det")).toBe(true);
    expect(result.has("demo-den-okc")).toBe(true);
    // BOS-DAL: Tatum (BOS) is on Alex's NBA roster, so it should match.
    expect(result.has("demo-bos-dal")).toBe(true);
  });

  it("skips games whose teams don't match any listener starter", () => {
    const result = buildListenerGameSpotlights({
      games: [
        ...games,
        { id: "demo-other", label: "MIA at BUF", shortName: "MIA @ BUF", sport: "nfl", awayTeam: "MIA", homeTeam: "BUF", score: { away: 0, home: 0 }, status: "demo", detail: "" }
      ],
      leagues: [demoLeagueState],
      group
    });
    expect(result.has("demo-kc-det")).toBe(true);
    expect(result.has("demo-other")).toBe(false);
  });

  it("ranks the top starter by projected points within a game", () => {
    const result = buildListenerGameSpotlights({
      games,
      leagues: allLeagues,
      group: { ...group, listener: { ...group.listener, rosterId: undefined } }
    });
    // DEN-OKC has Jokić (56.2 proj) and SGA (48.4) — Jokić wins.
    expect(result.get("demo-den-okc")?.topStarter?.name).toBe("Nikola Jokić");
  });
});

describe("buildListenerRecapHighlight", () => {
  function makeCommentaryWithImpact(impact: FantasyImpact, text: string): LivecastCommentary {
    return {
      id: `c-${impact.playerName}-${impact.pointsDelta}`,
      kind: "play",
      hostId: "maya",
      text,
      fantasyImpacts: [impact],
      moment: { priority: "notable", headline: "x", summary: "y", reasons: [], targetFriendIds: [], score: 1 },
      observation,
      play: { ...demoPlays[0] },
      createdAt: new Date().toISOString(),
      latency: { videoIngestMs: 0, modelResponseMs: 0, textGenerationMs: 0, endToEndMs: 0 }
    };
  }

  it("picks the biggest positive listener delta as a 'win' highlight", () => {
    const small = makeCommentaryWithImpact(
      { rosterId: "roster-alex", ownerName: "Alex", teamName: "Fourth & Snack", playerName: "Mahomes", isStarter: true, pointsDelta: 4.2, reason: "" },
      "small win"
    );
    const big = makeCommentaryWithImpact(
      { rosterId: "roster-alex", ownerName: "Alex", teamName: "Fourth & Snack", playerName: "Kelce", isStarter: true, pointsDelta: 12.5, reason: "" },
      "big win"
    );
    const highlight = buildListenerRecapHighlight({
      commentary: [small, big],
      group,
      leagues: [demoLeagueState],
      game: nflGame
    });
    expect(highlight?.kind).toBe("win");
    expect(highlight?.playerName).toBe("Kelce");
    expect(highlight?.hostText).toBe("big win");
  });

  it("falls back to a 'loss' highlight when only negative deltas exist", () => {
    const onlyNeg = makeCommentaryWithImpact(
      { rosterId: "roster-alex", ownerName: "Alex", teamName: "Fourth & Snack", playerName: "Mahomes", isStarter: true, pointsDelta: -6, reason: "pick" },
      "rough one"
    );
    const highlight = buildListenerRecapHighlight({
      commentary: [onlyNeg],
      group,
      leagues: [demoLeagueState],
      game: nflGame
    });
    expect(highlight?.kind).toBe("loss");
    expect(highlight?.pointsDelta).toBe(-6);
  });

  it("returns undefined when the listener has no roster in this sport", () => {
    const negNba = makeCommentaryWithImpact(
      { rosterId: "roster-alex-nba", ownerName: "Alex", teamName: "Crossover Kings", playerName: "Jokić", isStarter: true, pointsDelta: -3, reason: "" },
      "bad night"
    );
    const highlight = buildListenerRecapHighlight({
      commentary: [negNba],
      group, // listener has rosterId roster-alex (NFL only here)
      leagues: [demoLeagueState], // no NBA league
      game: nbaGame
    });
    expect(highlight).toBeUndefined();
  });
});

describe("buildFriendMatchups", () => {
  it("returns one entry per friend with a roster in the active sport's league", () => {
    // Default `group` already has Alex (listener) + Maya as friends; Maya
    // owns roster-maya in the demo NFL league.
    const matchups = buildFriendMatchups({
      group,
      leagues: [demoLeagueState],
      game: nflGame
    });
    // Both Alex and Maya have rosters in the NFL league, so both surface.
    expect(matchups.map((entry) => entry.friendName)).toEqual(expect.arrayContaining(["Maya", "Alex"]));
    const maya = matchups.find((entry) => entry.friendName === "Maya")!;
    expect(maya.teamName).toBe("Red Zone Renaissance");
    expect(maya.opponentTeamName).toBeTruthy();
    expect(maya.stakeLine).toMatch(/Maya (up|down|dead even)/);
  });

  it("returns empty when there's no league for the active sport", () => {
    const matchups = buildFriendMatchups({
      group,
      leagues: [demoLeagueState], // NFL only
      game: nbaGame
    });
    expect(matchups).toEqual([]);
  });

  it("sorts by largest absolute margin first", () => {
    const matchups = buildFriendMatchups({
      group,
      leagues: [demoLeagueState],
      game: nflGame
    });
    const margins = matchups.map((entry) => Math.abs(entry.margin));
    for (let i = 1; i < margins.length; i++) {
      expect(margins[i - 1] + 0.0001).toBeGreaterThanOrEqual(margins[i]);
    }
  });

  it("skips friends without a matching roster instead of returning placeholder rows", () => {
    const groupWithUnknownFriend: GroupSettings = {
      ...group,
      friends: [...group.friends, { id: "ghost", name: "Ghost", favoriteTeam: "ZZZ", rosterId: "no-such-id" }]
    };
    const matchups = buildFriendMatchups({
      group: groupWithUnknownFriend,
      leagues: [demoLeagueState],
      game: nflGame
    });
    expect(matchups.find((entry) => entry.friendName === "Ghost")).toBeUndefined();
  });
});

describe("buildTonightAtAGlance", () => {
  const games: SportsGameOption[] = [
    { id: "demo-kc-det", label: "KC at DET", shortName: "KC @ DET", sport: "nfl", awayTeam: "KC", homeTeam: "DET", score: { away: 0, home: 0 }, status: "demo", detail: "" },
    { id: "demo-den-okc", label: "DEN at OKC", shortName: "DEN @ OKC", sport: "nba", awayTeam: "DEN", homeTeam: "OKC", score: { away: 0, home: 0 }, status: "demo", detail: "" }
  ];

  it("returns one entry per league the listener owns a roster in", () => {
    const glance = buildTonightAtAGlance({
      group: { ...group, listener: { ...group.listener, rosterId: undefined } },
      leagues: allLeagues,
      games
    });
    expect(glance?.perSport).toHaveLength(2);
    const sports = glance!.perSport.map((entry) => entry.sport);
    expect(sports).toEqual(expect.arrayContaining(["nfl", "nba"]));
  });

  it("sorts tiles by largest absolute margin first", () => {
    const glance = buildTonightAtAGlance({
      group: { ...group, listener: { ...group.listener, rosterId: undefined } },
      leagues: allLeagues,
      games
    });
    const margins = glance!.perSport.map((entry) => Math.abs(entry.margin));
    for (let i = 1; i < margins.length; i++) {
      expect(margins[i - 1] + 0.0001).toBeGreaterThanOrEqual(margins[i]);
    }
  });

  it("suggests a game when at least one starter is playing in the league's sport", () => {
    const glance = buildTonightAtAGlance({
      group: { ...group, listener: { ...group.listener, rosterId: undefined } },
      leagues: allLeagues,
      games
    });
    const nfl = glance!.perSport.find((entry) => entry.sport === "nfl");
    expect(nfl?.suggestedGameId).toBe("demo-kc-det");
    const nba = glance!.perSport.find((entry) => entry.sport === "nba");
    expect(nba?.suggestedGameId).toBe("demo-den-okc");
  });

  it("returns undefined when the listener has no name", () => {
    expect(
      buildTonightAtAGlance({
        group: { ...group, listener: { ...group.listener, name: "" } },
        leagues: allLeagues,
        games
      })
    ).toBeUndefined();
  });
});
