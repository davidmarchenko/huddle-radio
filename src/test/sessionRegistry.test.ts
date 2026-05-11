import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryRegistry,
  UpstashRedisRegistry,
  getDefaultSessionRegistry,
  getInstanceId,
  resetDefaultSessionRegistryForTests
} from "../server/sessionRegistry";

describe("MemoryRegistry", () => {
  afterEach(() => {
    resetDefaultSessionRegistryForTests(undefined);
  });

  it("round-trips a session record by id", async () => {
    const registry = new MemoryRegistry();
    await registry.register("s1", "inst-a", 60);
    const found = await registry.lookup("s1");
    expect(found?.sessionId).toBe("s1");
    expect(found?.instanceId).toBe("inst-a");
  });

  it("returns undefined for an unknown session", async () => {
    const registry = new MemoryRegistry();
    expect(await registry.lookup("nope")).toBeUndefined();
  });

  it("expires records after the TTL elapses", async () => {
    const registry = new MemoryRegistry();
    await registry.register("s1", "inst-a", 0.05); // 50ms TTL
    expect(await registry.lookup("s1")).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await registry.lookup("s1")).toBeUndefined();
  });

  it("heartbeat refreshes the TTL so an active session doesn't expire", async () => {
    const registry = new MemoryRegistry();
    await registry.register("s1", "inst-a", 0.1); // 100ms TTL
    await new Promise((resolve) => setTimeout(resolve, 60));
    await registry.heartbeat("s1", 0.1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Without the heartbeat the original 100ms TTL would have fired
    // around t=100ms; with the heartbeat at t=60ms the next expiry is
    // t=160ms, so at t=120ms the record should still be present.
    expect(await registry.lookup("s1")).toBeDefined();
  });

  it("unregister removes the record immediately", async () => {
    const registry = new MemoryRegistry();
    await registry.register("s1", "inst-a", 60);
    await registry.unregister("s1");
    expect(await registry.lookup("s1")).toBeUndefined();
  });

  it("re-registering the same id resets the TTL (SETEX semantics)", async () => {
    const registry = new MemoryRegistry();
    await registry.register("s1", "inst-a", 0.05);
    await registry.register("s1", "inst-b", 60);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const found = await registry.lookup("s1");
    expect(found?.instanceId).toBe("inst-b");
  });
});

describe("UpstashRedisRegistry", () => {
  it("issues SETEX-shaped writes via the injected client", async () => {
    const calls: Array<{ op: string; key: string; value?: unknown; opts?: unknown }> = [];
    const fakeRedis = {
      set: async (key: string, value: unknown, opts: unknown) => {
        calls.push({ op: "set", key, value, opts });
        return "OK" as const;
      },
      get: async <T,>(key: string): Promise<T | null> => {
        calls.push({ op: "get", key });
        return null;
      },
      del: async (key: string) => {
        calls.push({ op: "del", key });
        return 1;
      },
      expire: async (): Promise<0 | 1> => 1
    };
    const registry = new UpstashRedisRegistry(fakeRedis);
    await registry.register("abc", "inst-x", 30);
    expect(calls[0]).toMatchObject({
      op: "set",
      key: "huddle:session:abc",
      opts: { ex: 30 }
    });
    expect((calls[0].value as { instanceId: string }).instanceId).toBe("inst-x");
  });

  it("namespaces keys so unrelated apps on the same Upstash instance can't collide", async () => {
    const calls: Array<{ key: string }> = [];
    const fakeRedis = {
      set: async (key: string) => {
        calls.push({ key });
        return "OK" as const;
      },
      get: async () => null,
      del: async () => 1,
      expire: async (): Promise<0 | 1> => 1
    };
    const registry = new UpstashRedisRegistry(fakeRedis);
    await registry.register("abc", "inst-x", 30);
    expect(calls[0].key).toBe("huddle:session:abc");
  });

  it("lookup() reads the same record register() wrote and returns undefined on null", async () => {
    let stored: unknown = null;
    const fakeRedis = {
      set: async (_key: string, value: unknown) => {
        stored = value;
        return "OK" as const;
      },
      get: async <T,>(): Promise<T | null> => stored as T | null,
      del: async () => {
        stored = null;
        return 1;
      },
      expire: async (): Promise<0 | 1> => 1
    };
    const registry = new UpstashRedisRegistry(fakeRedis);
    expect(await registry.lookup("abc")).toBeUndefined();
    await registry.register("abc", "inst-x", 30);
    const found = await registry.lookup("abc");
    expect(found?.instanceId).toBe("inst-x");
    await registry.unregister("abc");
    expect(await registry.lookup("abc")).toBeUndefined();
  });
});

describe("getInstanceId", () => {
  it("returns the same id across multiple calls in one process", () => {
    expect(getInstanceId()).toBe(getInstanceId());
  });
});

describe("getDefaultSessionRegistry", () => {
  afterEach(() => {
    resetDefaultSessionRegistryForTests(undefined);
  });

  it("falls back to MemoryRegistry when Upstash env vars are missing", () => {
    // Vitest doesn't isolate env vars per test — explicitly clear them
    // so the default selection logic picks the memory backend.
    const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
    const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    resetDefaultSessionRegistryForTests(undefined);
    try {
      const registry = getDefaultSessionRegistry();
      expect(registry).toBeInstanceOf(MemoryRegistry);
    } finally {
      if (previousUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = previousUrl;
      if (previousToken !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
    }
  });
});
