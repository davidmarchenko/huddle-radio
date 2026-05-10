import { describe, expect, it } from "vitest";
import { PlayerIdResolver } from "../server/playerIdResolver";

describe("PlayerIdResolver", () => {
  it("resolves a registered ESPN id to the canonical (Sleeper) id", () => {
    const resolver = new PlayerIdResolver();
    resolver.register({
      canonicalId: "4046",
      name: "Patrick Mahomes",
      sport: "nfl",
      external: { sleeper: "4046", espn: "3139477" }
    });

    expect(resolver.resolve({ provider: "espn", externalId: "3139477", sport: "nfl" })).toBe("4046");
    expect(resolver.resolve({ provider: "sleeper", externalId: "4046", sport: "nfl" })).toBe("4046");
  });

  it("returns a namespaced fallback when the external id is unknown", () => {
    const resolver = new PlayerIdResolver();
    expect(resolver.resolve({ provider: "espn", externalId: "999999", sport: "nfl" })).toBe("espn:999999");
  });

  it("passes the raw id through when caller opts for passthrough", () => {
    const resolver = new PlayerIdResolver();
    expect(resolver.resolveOrPassthrough({ provider: "sleeper", externalId: "ZZZ", sport: "nfl" })).toBe("ZZZ");
  });

  it("does not collide records across sports", () => {
    const resolver = new PlayerIdResolver();
    resolver.register({
      canonicalId: "nfl-1",
      name: "Player NFL",
      sport: "nfl",
      external: { espn: "100" }
    });
    resolver.register({
      canonicalId: "nba-1",
      name: "Player NBA",
      sport: "nba",
      external: { espn: "100" }
    });

    expect(resolver.resolve({ provider: "espn", externalId: "100", sport: "nfl" })).toBe("nfl-1");
    expect(resolver.resolve({ provider: "espn", externalId: "100", sport: "nba" })).toBe("nba-1");
  });

  it("counts hits and misses", () => {
    const resolver = new PlayerIdResolver();
    resolver.register({
      canonicalId: "4046",
      name: "Patrick Mahomes",
      sport: "nfl",
      external: { espn: "3139477" }
    });
    resolver.resolve({ provider: "espn", externalId: "3139477", sport: "nfl" });
    resolver.resolve({ provider: "espn", externalId: "missing", sport: "nfl" });
    resolver.resolveOrPassthrough({ provider: "sleeper", externalId: "missing", sport: "nfl" });

    const stats = resolver.getStats();
    expect(stats.resolved).toBe(1);
    expect(stats.missed).toBe(2);
    expect(stats.registered).toBe(1);
  });

  it("looks up canonical records", () => {
    const resolver = new PlayerIdResolver();
    resolver.register({
      canonicalId: "4046",
      name: "Patrick Mahomes",
      sport: "nfl",
      position: "QB",
      team: "KC",
      external: { espn: "3139477" }
    });

    const record = resolver.lookup("4046");
    expect(record?.name).toBe("Patrick Mahomes");
    expect(record?.team).toBe("KC");
  });

  it("loads the seed file via the default singleton", async () => {
    // Dynamic import so we don't pin the singleton if other tests hit it.
    const { getDefaultPlayerIdResolver, resetDefaultPlayerIdResolver } = await import("../server/playerIdResolver");
    resetDefaultPlayerIdResolver();
    const resolver = getDefaultPlayerIdResolver();
    // Mahomes is in the shipped seed.
    expect(resolver.resolve({ provider: "espn", externalId: "3139477", sport: "nfl" })).toBe("4046");
  });
});
