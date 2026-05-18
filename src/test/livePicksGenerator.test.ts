import { afterEach, describe, expect, it } from "vitest";
import { generateLivePickCandidates } from "../server/livePicksGenerator";
import {
  buildLivePicksHostHint,
  lockLivePick,
  refreshActivePicks,
  resetLivePicksStore,
  resolveExpiredEntries
} from "../server/livePicksStore";
import type { SportsGameState, SportsPlay } from "../shared/contracts";

function makePlay(overrides: Partial<SportsPlay>): SportsPlay {
  return {
    id: "p-1",
    type: "other",
    excitement: 3,
    clock: "8:42",
    period: { number: 3, kind: "quarter" },
    possession: "LAL",
    headline: "Steph Curry pulls up from logo",
    description: "Stephen Curry hits a 3-pointer from 28 feet.",
    playerIds: [],
    team: "GSW",
    score: { away: 78, home: 74 },
    occurredAt: new Date("2026-05-14T20:00:00Z").toISOString(),
    ...overrides
  };
}

function makeGame(overrides: Partial<SportsGameState>): SportsGameState {
  return {
    provider: "test",
    gameId: "test-nba-1",
    sport: "nba",
    awayTeam: "GSW",
    homeTeam: "LAL",
    status: "live",
    currentPlay: makePlay({}),
    recentPlays: [makePlay({})],
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("generateLivePickCandidates", () => {
  it("returns no candidates when the game is not live", () => {
    const candidates = generateLivePickCandidates({
      game: makeGame({ status: "scheduled" }),
      now: Date.now()
    });
    expect(candidates).toEqual([]);
  });

  it("emits a team-scores window prop for the trailing team", () => {
    const game = makeGame({
      currentPlay: makePlay({ score: { away: 80, home: 70 }, team: "GSW" }),
      recentPlays: [makePlay({ score: { away: 80, home: 70 }, team: "GSW" })]
    });
    const candidates = generateLivePickCandidates({ game, now: Date.now() });
    const teamScores = candidates.find((c) => c.kind === "team-scores-window");
    expect(teamScores).toBeDefined();
    // Home (LAL) is trailing.
    expect(teamScores?.team).toBe("LAL");
  });

  it("emits a basketball player-next-three prop using a name from a play", () => {
    const namedPlay = makePlay({
      headline: "Stephen Curry buries a stepback three",
      description: "Stephen Curry from 28 feet"
    });
    const game = makeGame({
      currentPlay: namedPlay,
      recentPlays: [namedPlay]
    });
    const candidates = generateLivePickCandidates({ game, now: Date.now() });
    const playerProp = candidates.find((c) => c.kind === "player-next-stat");
    expect(playerProp).toBeDefined();
    expect(playerProp?.playerName).toBe("Stephen Curry");
  });

  it("does not invent a player when no name is parseable", () => {
    const game = makeGame({
      currentPlay: makePlay({ headline: "End of third quarter", description: "TIMEOUT" }),
      recentPlays: [
        makePlay({ headline: "End of third quarter", description: "TIMEOUT" })
      ]
    });
    const candidates = generateLivePickCandidates({ game, now: Date.now() });
    const playerProp = candidates.find((c) => c.kind === "player-next-stat");
    expect(playerProp).toBeUndefined();
  });

  it("produces the same id for the same anchor play across calls", () => {
    const game = makeGame({});
    const first = generateLivePickCandidates({ game, now: 1_000 });
    const second = generateLivePickCandidates({ game, now: 5_000 });
    const firstIds = first.map((c) => c.id).sort();
    const secondIds = second.map((c) => c.id).sort();
    expect(firstIds).toEqual(secondIds);
  });
});

describe("live picks store + resolver", () => {
  afterEach(() => resetLivePicksStore());

  it("locks a live pick and resolves it as a HIT when the team scores in the window", () => {
    const baseTime = new Date("2026-05-14T20:00:00Z").getTime();
    const game = makeGame({
      currentPlay: makePlay({ score: { away: 80, home: 70 }, team: "GSW", occurredAt: new Date(baseTime - 30_000).toISOString() }),
      recentPlays: [
        makePlay({
          id: "p-anchor",
          score: { away: 80, home: 70 },
          team: "GSW",
          occurredAt: new Date(baseTime - 30_000).toISOString()
        })
      ]
    });
    const active = refreshActivePicks({ game, now: baseTime });
    const teamProp = active.find((p) => p.kind === "team-scores-window")!;
    expect(teamProp).toBeDefined();

    const lock = lockLivePick({
      listenerId: "listener-1",
      gameId: game.gameId,
      propId: teamProp.id,
      side: "more",
      now: baseTime
    });
    expect("entry" in lock).toBe(true);

    // Drive the game forward — trailing team (LAL) scores 2 inside
    // the window. Resolver should mark the entry as a hit.
    const scoringPlay = makePlay({
      id: "p-score",
      team: "LAL",
      score: { away: 80, home: 72 },
      occurredAt: new Date(baseTime + 30_000).toISOString(),
      headline: "Davis fadeaway"
    });
    const expiresMs = new Date(teamProp.expiresAt).getTime();
    const resolved = resolveExpiredEntries({
      game: makeGame({
        ...game,
        currentPlay: scoringPlay,
        recentPlays: [scoringPlay, game.recentPlays[0]!]
      }),
      now: expiresMs + 1000
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.status).toBe("hit");
    expect(resolved[0]!.payout).toBeGreaterThan(0);
  });

  it("resolves a team-scores-window as a MISS when no scoring play arrives", () => {
    const baseTime = new Date("2026-05-14T20:00:00Z").getTime();
    const game = makeGame({
      currentPlay: makePlay({ score: { away: 80, home: 70 }, team: "GSW", occurredAt: new Date(baseTime - 30_000).toISOString() }),
      recentPlays: [
        makePlay({ id: "p-anchor", score: { away: 80, home: 70 }, team: "GSW", occurredAt: new Date(baseTime - 30_000).toISOString() })
      ]
    });
    const active = refreshActivePicks({ game, now: baseTime });
    const teamProp = active.find((p) => p.kind === "team-scores-window")!;
    lockLivePick({
      listenerId: "listener-1",
      gameId: game.gameId,
      propId: teamProp.id,
      side: "more",
      now: baseTime
    });
    const expiresMs = new Date(teamProp.expiresAt).getTime();
    // No new plays in the window — game state is unchanged.
    const resolved = resolveExpiredEntries({
      game,
      now: expiresMs + 1000
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.status).toBe("miss");
    expect(resolved[0]!.payout).toBe(0);
  });

  it("buildLivePicksHostHint surfaces a recently-resolved entry for the engine", () => {
    const baseTime = Date.now();
    const game = makeGame({});
    const active = refreshActivePicks({ game, now: baseTime });
    const prop = active[0]!;
    lockLivePick({
      listenerId: "listener-1",
      gameId: game.gameId,
      propId: prop.id,
      side: "more",
      now: baseTime
    });
    const expiresMs = new Date(prop.expiresAt).getTime();
    resolveExpiredEntries({ game, now: expiresMs + 1000 });
    const hint = buildLivePicksHostHint({
      listenerId: "listener-1",
      gameId: game.gameId,
      now: expiresMs + 5000
    });
    expect(hint).toBeDefined();
    expect(hint).toMatch(/HIT|missed/);
  });
});
