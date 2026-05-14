import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryClaimsStore, UpstashClaimsStore } from "../server/memory/claimsStore";
import { LocalClaimsExtractor } from "../server/memory/localExtractor";
import { CallbackEnrichmentProvider } from "../providers/enrichment/callbackProvider";
import type { Claim, ExtractInput } from "../server/memory/types";
import type { SportsGameState } from "../shared/contracts";

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
      clock: "5:00",
      quarter: "Q3",
      possession: "LV",
      headline: "play",
      description: "play",
      playerIds: ["wilson"],
      team: "LV",
      score: { away: 60, home: 65 },
      occurredAt: new Date().toISOString()
    },
    recentPlays: [],
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("InMemoryClaimsStore", () => {
  let store: InMemoryClaimsStore;
  beforeEach(() => {
    store = new InMemoryClaimsStore();
  });

  function claim(overrides: Partial<Claim> = {}): Claim {
    return {
      id: "c1",
      listenerId: "alex",
      hostId: "cam",
      text: "Wilson goes for 30",
      anchorPlayerId: "wilson",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString(),
      outcome: "pending",
      ...overrides
    };
  }

  it("scopes claims per listener — never leaks across listeners", async () => {
    await store.save(claim({ id: "a", listenerId: "alex", anchorPlayerId: "wilson" }));
    await store.save(claim({ id: "b", listenerId: "bob", anchorPlayerId: "wilson" }));
    expect(await store.findRelevant({ listenerId: "alex", playerIds: ["wilson"], teams: [] })).toHaveLength(1);
    expect(await store.findRelevant({ listenerId: "bob", playerIds: ["wilson"], teams: [] })).toHaveLength(1);
    expect(await store.findRelevant({ listenerId: "carol", playerIds: ["wilson"], teams: [] })).toHaveLength(0);
  });

  it("matches by player anchor", async () => {
    await store.save(claim({ id: "a", anchorPlayerId: "wilson" }));
    await store.save(claim({ id: "b", anchorPlayerId: "stewart" }));
    const out = await store.findRelevant({ listenerId: "alex", playerIds: ["wilson"], teams: [] });
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });

  it("matches by team anchor (case-insensitive)", async () => {
    await store.save(claim({ id: "a", anchorPlayerId: undefined, anchorTeam: "SEA" }));
    const out = await store.findRelevant({ listenerId: "alex", playerIds: [], teams: ["sea"] });
    expect(out).toHaveLength(1);
  });

  it("ranks player matches above team matches", async () => {
    await store.save(claim({ id: "byteam", anchorPlayerId: undefined, anchorTeam: "SEA" }));
    await store.save(claim({ id: "byplayer", anchorPlayerId: "wilson" }));
    const out = await store.findRelevant({ listenerId: "alex", playerIds: ["wilson"], teams: ["SEA"] });
    expect(out[0].id).toBe("byplayer");
  });

  it("drops claims older than maxAge", async () => {
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await store.save(claim({ id: "old", capturedAt: longAgo, anchorPlayerId: "wilson" }));
    expect(await store.findRelevant({ listenerId: "alex", playerIds: ["wilson"], teams: [] })).toHaveLength(0);
  });

  it("save() is idempotent on id", async () => {
    await store.save(claim({ id: "c", text: "v1" }));
    await store.save(claim({ id: "c", text: "v2" }));
    const out = await store.findRelevant({ listenerId: "alex", playerIds: ["wilson"], teams: [] });
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("v2");
  });
});

describe("LocalClaimsExtractor", () => {
  function input(overrides: Partial<ExtractInput> = {}): ExtractInput {
    return {
      listenerId: "alex",
      hostId: "cam",
      text: "default",
      playPlayerIds: ["wilson"],
      teams: ["SEA", "LV"],
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString(),
      ...overrides
    };
  }

  it("extracts player-anchored predictions ('Wilson goes for 30')", async () => {
    const ex = new LocalClaimsExtractor();
    const claims = await ex.extract(
      input({ text: "I'm telling you right now Wilson goes for 30 tonight, just call it." })
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].anchorPlayerId).toBe("wilson");
    expect(claims[0].text).toContain("30");
  });

  it("extracts hot takes ('Wilson is washed')", async () => {
    const ex = new LocalClaimsExtractor();
    const claims = await ex.extract(
      input({ text: "Hot take coming through — Wilson is washed and we are watching it happen in real time." })
    );
    expect(claims).toHaveLength(1);
  });

  it("drops claims with no recognizable player or team anchor", async () => {
    const ex = new LocalClaimsExtractor();
    // "Smith" not in playPlayerIds or teams → un-anchored, dropped.
    const claims = await ex.extract(
      input({ text: "I'm telling you right now Smith goes for 30 tonight, just call it." })
    );
    expect(claims).toEqual([]);
  });

  it("returns [] for short / empty text", async () => {
    const ex = new LocalClaimsExtractor();
    expect(await ex.extract(input({ text: "ok" }))).toEqual([]);
  });

  it("never throws past its public surface", async () => {
    // Constructed with intentionally hostile input (regex would
    // explode if it cared about backslashes etc.) — we still get [].
    const ex = new LocalClaimsExtractor();
    const claims = await ex.extract(input({ text: "\\\\\\\\".repeat(100) }));
    expect(claims).toEqual([]);
  });

  it("sets outcome='pending' on freshly extracted claims", async () => {
    const ex = new LocalClaimsExtractor();
    const claims = await ex.extract(input({ text: "Wilson goes for 30 tonight no question about it." }));
    expect(claims[0].outcome).toBe("pending");
  });
});

describe("CallbackEnrichmentProvider", () => {
  it("emits an EnrichmentSignal per matching prior claim", async () => {
    const store = new InMemoryClaimsStore();
    await store.save({
      id: "claim-1",
      listenerId: "alex",
      hostId: "cam",
      text: "Wilson goes for 30",
      anchorPlayerId: "wilson",
      sourceShowId: "show-prev",
      capturedAt: new Date().toISOString(),
      outcome: "pending"
    });
    const provider = new CallbackEnrichmentProvider({ store, listenerId: "alex" });
    const signals = await provider.gather({ game: game(), deadlineMs: 1000 });
    expect(signals).toHaveLength(1);
    expect(signals[0].text).toContain("Wilson goes for 30");
    expect(signals[0].refs?.playerId).toBe("wilson");
    expect(signals[0].kind).toBe("context");
  });

  it("returns [] when no listener id is provided", async () => {
    const store = new InMemoryClaimsStore();
    const provider = new CallbackEnrichmentProvider({ store, listenerId: "" });
    const signals = await provider.gather({ game: game(), deadlineMs: 1000 });
    expect(signals).toEqual([]);
  });

  it("returns [] when no prior claims match the current play", async () => {
    const store = new InMemoryClaimsStore();
    await store.save({
      id: "claim-1",
      listenerId: "alex",
      hostId: "cam",
      text: "Stewart looking lost",
      anchorPlayerId: "stewart",
      sourceShowId: "show-prev",
      capturedAt: new Date().toISOString()
    });
    const provider = new CallbackEnrichmentProvider({ store, listenerId: "alex" });
    const signals = await provider.gather({ game: game(), deadlineMs: 1000 });
    expect(signals).toEqual([]);
  });

  it("scores recent claims higher than older ones", async () => {
    const store = new InMemoryClaimsStore();
    await store.save({
      id: "fresh",
      listenerId: "alex",
      hostId: "cam",
      text: "fresh prediction",
      anchorPlayerId: "wilson",
      sourceShowId: "show-now",
      capturedAt: new Date().toISOString()
    });
    await store.save({
      id: "stale",
      listenerId: "alex",
      hostId: "cam",
      text: "stale prediction",
      anchorPlayerId: "wilson",
      sourceShowId: "show-old",
      capturedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    });
    const provider = new CallbackEnrichmentProvider({ store, listenerId: "alex" });
    const signals = await provider.gather({ game: game(), deadlineMs: 1000 });
    const fresh = signals.find((s) => s.id === "fresh")!;
    const stale = signals.find((s) => s.id === "stale")!;
    expect(fresh.score).toBeGreaterThan(stale.score);
  });

  it("reports ready health (no upstream service)", async () => {
    const store = new InMemoryClaimsStore();
    const provider = new CallbackEnrichmentProvider({ store, listenerId: "alex" });
    const h = await provider.health();
    expect(h.status).toBe("ready");
  });
});

/** Minimal stub of the Upstash REST client — supports just the
 *  three methods UpstashClaimsStore touches. The actual Upstash
 *  contract returns deserialized JSON for `get`, so we mirror that
 *  by storing parsed values directly. */
function makeStubRedis() {
  const data = new Map<string, unknown>();
  return {
    data, // for assertions
    async get<T>(key: string): Promise<T | null> {
      return (data.get(key) as T) ?? null;
    },
    async set(key: string, value: unknown): Promise<unknown> {
      data.set(key, value);
      return "OK";
    },
    async del(key: string): Promise<number> {
      return data.delete(key) ? 1 : 0;
    }
  };
}

describe("UpstashClaimsStore", () => {
  it("namespaces keys per listener (huddle:claims:<id>)", async () => {
    const stub = makeStubRedis();
    const store = new UpstashClaimsStore(stub as never);
    await store.save({
      id: "c1",
      listenerId: "alex",
      hostId: "cam",
      text: "Wilson goes for 30",
      anchorPlayerId: "wilson",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString()
    });
    expect(Array.from(stub.data.keys())).toEqual(["huddle:claims:alex"]);
  });

  it("save() upserts by id within a listener bucket", async () => {
    const stub = makeStubRedis();
    const store = new UpstashClaimsStore(stub as never);
    await store.save({
      id: "c1",
      listenerId: "alex",
      hostId: "cam",
      text: "v1",
      anchorPlayerId: "wilson",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString()
    });
    await store.save({
      id: "c1",
      listenerId: "alex",
      hostId: "cam",
      text: "v2",
      anchorPlayerId: "wilson",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString()
    });
    const stored = stub.data.get("huddle:claims:alex") as Array<{ text: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe("v2");
  });

  it("findRelevant() applies the same scoring as InMemoryClaimsStore", async () => {
    const stub = makeStubRedis();
    const store = new UpstashClaimsStore(stub as never);
    await store.save({
      id: "byteam",
      listenerId: "alex",
      hostId: "cam",
      text: "Storm soft on the boards",
      anchorTeam: "SEA",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString()
    });
    await store.save({
      id: "byplayer",
      listenerId: "alex",
      hostId: "cam",
      text: "Wilson goes for 30",
      anchorPlayerId: "wilson",
      sourceShowId: "show-1",
      capturedAt: new Date().toISOString()
    });
    const out = await store.findRelevant({
      listenerId: "alex",
      playerIds: ["wilson"],
      teams: ["SEA"]
    });
    // Player anchor wins.
    expect(out[0].id).toBe("byplayer");
  });

  it("returns [] for a listener with no stored claims", async () => {
    const stub = makeStubRedis();
    const store = new UpstashClaimsStore(stub as never);
    const out = await store.findRelevant({ listenerId: "ghost", playerIds: ["wilson"], teams: [] });
    expect(out).toEqual([]);
  });
});
