import { describe, expect, it, beforeEach, vi } from "vitest";
import { OutcomeResolver } from "../server/memory/outcomeResolver";
import { InMemoryClaimsStore } from "../server/memory/claimsStore";
import * as picksLiveStats from "../server/picksLiveStats";

describe("OutcomeResolver", () => {
  let store: InMemoryClaimsStore;

  beforeEach(() => {
    store = new InMemoryClaimsStore();
    vi.restoreAllMocks();
  });

  it("marks a prediction RIGHT when actual stat ≥ predicted (basketball/points default)", async () => {
    await store.save({
      id: "c1",
      listenerId: "alex",
      hostId: "cam",
      text: "Wilson goes for 30",
      anchorPlayerId: "wilson",
      anchorPlayerName: "Wilson",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString(),
      outcome: "pending"
    });
    vi.spyOn(picksLiveStats, "fetchLiveStats").mockResolvedValue({
      stats: new Map([["wilson", { points: 32 }]]),
      gameCompleted: true
    });
    const resolver = new OutcomeResolver(store);
    const counts = await resolver.resolve({ listenerId: "alex", gameId: "g1", sport: "wnba" });
    expect(counts).toEqual({ right: 1, wrong: 0, pending: 0 });
    const after = await store.findRelevant({
      listenerId: "alex",
      playerIds: ["wilson"],
      teams: []
    });
    expect(after[0].outcome).toBe("right");
  });

  it("marks a prediction WRONG when actual stat < predicted", async () => {
    await store.save({
      id: "c1",
      listenerId: "alex",
      hostId: "cam",
      text: "Wilson goes for 30",
      anchorPlayerId: "wilson",
      anchorPlayerName: "Wilson",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString(),
      outcome: "pending"
    });
    vi.spyOn(picksLiveStats, "fetchLiveStats").mockResolvedValue({
      stats: new Map([["wilson", { points: 22 }]]),
      gameCompleted: true
    });
    const resolver = new OutcomeResolver(store);
    const counts = await resolver.resolve({ listenerId: "alex", gameId: "g1", sport: "wnba" });
    expect(counts).toEqual({ right: 0, wrong: 1, pending: 0 });
  });

  it("leaves a claim PENDING when the game is still live (no resolution before final)", async () => {
    await store.save({
      id: "c1",
      listenerId: "alex",
      hostId: "cam",
      text: "Wilson goes for 30",
      anchorPlayerId: "wilson",
      anchorPlayerName: "Wilson",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString(),
      outcome: "pending"
    });
    vi.spyOn(picksLiveStats, "fetchLiveStats").mockResolvedValue({
      stats: new Map([["wilson", { points: 18 }]]),
      gameCompleted: false
    });
    const resolver = new OutcomeResolver(store);
    const counts = await resolver.resolve({ listenerId: "alex", gameId: "g1", sport: "wnba" });
    expect(counts.right + counts.wrong).toBe(0);
    expect(counts.pending).toBe(1);
  });

  it("skips sports with no default stat mapping (NFL needs explicit stat type)", async () => {
    await store.save({
      id: "c1",
      listenerId: "alex",
      hostId: "cam",
      text: "Mahomes goes for 300",
      anchorPlayerId: "mahomes",
      anchorPlayerName: "Mahomes",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString(),
      outcome: "pending"
    });
    const fetchSpy = vi.spyOn(picksLiveStats, "fetchLiveStats");
    const resolver = new OutcomeResolver(store);
    const counts = await resolver.resolve({ listenerId: "alex", gameId: "g1", sport: "nfl" });
    expect(counts).toEqual({ right: 0, wrong: 0, pending: 0 });
    // We didn't even hit the stats endpoint — saved a network call.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws on fetchLiveStats failure — returns zero counts", async () => {
    await store.save({
      id: "c1",
      listenerId: "alex",
      hostId: "cam",
      text: "Wilson goes for 30",
      anchorPlayerId: "wilson",
      anchorPlayerName: "Wilson",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString(),
      outcome: "pending"
    });
    vi.spyOn(picksLiveStats, "fetchLiveStats").mockRejectedValue(new Error("ECONNRESET"));
    const resolver = new OutcomeResolver(store);
    const counts = await resolver.resolve({ listenerId: "alex", gameId: "g1", sport: "wnba" });
    expect(counts).toEqual({ right: 0, wrong: 0, pending: 0 });
  });

  it("is idempotent — re-resolving a settled claim doesn't re-grade it", async () => {
    await store.save({
      id: "c1",
      listenerId: "alex",
      hostId: "cam",
      text: "Wilson goes for 30",
      anchorPlayerId: "wilson",
      anchorPlayerName: "Wilson",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString(),
      outcome: "pending"
    });
    vi.spyOn(picksLiveStats, "fetchLiveStats").mockResolvedValue({
      stats: new Map([["wilson", { points: 32 }]]),
      gameCompleted: true
    });
    const resolver = new OutcomeResolver(store);
    const first = await resolver.resolve({ listenerId: "alex", gameId: "g1", sport: "wnba" });
    expect(first.right).toBe(1);
    // Second resolve sees no pending claims (the first call already
    // moved it to "right"), so it grades nothing.
    const second = await resolver.resolve({ listenerId: "alex", gameId: "g1", sport: "wnba" });
    expect(second).toEqual({ right: 0, wrong: 0, pending: 0 });
  });

  it("skips claims with no anchorPlayerName (un-resolvable without a name to look up)", async () => {
    await store.save({
      id: "c1",
      listenerId: "alex",
      hostId: "cam",
      text: "Storm soft on the boards", // team-anchored, no player name
      anchorTeam: "SEA",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString(),
      outcome: "pending"
    });
    const fetchSpy = vi.spyOn(picksLiveStats, "fetchLiveStats");
    const resolver = new OutcomeResolver(store);
    const counts = await resolver.resolve({ listenerId: "alex", gameId: "g1", sport: "wnba" });
    expect(counts).toEqual({ right: 0, wrong: 0, pending: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
