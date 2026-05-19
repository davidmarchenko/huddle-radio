import { describe, expect, it } from "vitest";
import {
  MemoryTurnSummaryStore,
  UpstashTurnSummaryStore
} from "../server/turnSummaryStore";
import type { TurnSummary } from "../server/turnSummaries";

/**
 * Direct tests for the two TurnSummaryStore implementations. The
 * recordTurn / getRecentTurns wrappers in turnSummaries.ts get
 * covered by turnSummaries.test.ts; here we pin the actual store
 * semantics so a regression in one backend doesn't slip past.
 */

const sample = (overrides: Partial<TurnSummary> = {}): TurnSummary => ({
  turnId: overrides.turnId ?? "t1",
  kind: overrides.kind ?? "play",
  sessionId: "sess",
  engineId: "eng",
  leadHostId: "theo",
  finalHostIds: ["theo"],
  lineCount: 1,
  commentaryProvider: "openai-commentary",
  ttsEnabled: false,
  ttsChunks: 0,
  totalMs: 100,
  startedAt: "2026-05-18T00:00:00Z",
  ...overrides
});

describe("MemoryTurnSummaryStore", () => {
  it("records and reads newest-first within the cap", async () => {
    const store = new MemoryTurnSummaryStore();
    for (let i = 0; i < 5; i += 1) await store.record(sample({ turnId: `t${i}` }));
    const recent = await store.recent(5);
    expect(recent.map((t) => t.turnId)).toEqual(["t4", "t3", "t2", "t1", "t0"]);
  });

  it("caps at 100 entries; older evicted in FIFO order", async () => {
    const store = new MemoryTurnSummaryStore();
    for (let i = 0; i < 110; i += 1) await store.record(sample({ turnId: `t${i}` }));
    const recent = await store.recent(200);
    expect(recent).toHaveLength(100);
    expect(recent[0].turnId).toBe("t109");
    expect(recent[recent.length - 1].turnId).toBe("t10");
  });

  it("reset() empties the store", async () => {
    const store = new MemoryTurnSummaryStore();
    await store.record(sample());
    await store.reset();
    expect(await store.recent(10)).toEqual([]);
  });
});

/**
 * UpstashTurnSummaryStore wraps a Redis client. We pass a fake that
 * implements just the four methods the store uses (lpush, ltrim,
 * lrange, del) — same pattern as UpstashRedisRegistry's tests.
 */
function fakeRedis() {
  const list: TurnSummary[] = [];
  return {
    list,
    client: {
      async lpush(_key: string, value: unknown) {
        list.unshift(value as TurnSummary);
        return list.length;
      },
      async ltrim(_key: string, start: number, stop: number) {
        list.splice(stop + 1);
        if (start > 0) list.splice(0, start);
        return "OK" as const;
      },
      async lrange<T>(_key: string, start: number, stop: number): Promise<T[]> {
        return list.slice(start, stop + 1) as unknown as T[];
      },
      async del(_key: string) {
        list.length = 0;
        return 1;
      }
    }
  };
}

describe("UpstashTurnSummaryStore", () => {
  it("uses LPUSH + LTRIM to maintain a 100-entry capped list", async () => {
    const { list, client } = fakeRedis();
    const store = new UpstashTurnSummaryStore(client);
    for (let i = 0; i < 105; i += 1) await store.record(sample({ turnId: `t${i}` }));
    expect(list).toHaveLength(100);
    // LPUSH inserts at head: list[0] is newest.
    expect(list[0].turnId).toBe("t104");
    expect(list[list.length - 1].turnId).toBe("t5");
  });

  it("recent() returns newest-first using LRANGE 0..N-1", async () => {
    const { client } = fakeRedis();
    const store = new UpstashTurnSummaryStore(client);
    await store.record(sample({ turnId: "a" }));
    await store.record(sample({ turnId: "b" }));
    await store.record(sample({ turnId: "c" }));
    const recent = await store.recent(2);
    expect(recent.map((t) => t.turnId)).toEqual(["c", "b"]);
  });

  it("clamps limit to safe bounds before issuing LRANGE", async () => {
    const { client } = fakeRedis();
    const store = new UpstashTurnSummaryStore(client);
    await store.record(sample({ turnId: "only" }));
    expect(await store.recent(0)).toHaveLength(1);
    expect(await store.recent(-5)).toHaveLength(1);
    expect(await store.recent(10_000)).toHaveLength(1);
  });

  it("reset() issues DEL", async () => {
    const { list, client } = fakeRedis();
    const store = new UpstashTurnSummaryStore(client);
    await store.record(sample());
    expect(list).toHaveLength(1);
    await store.reset();
    expect(list).toHaveLength(0);
  });
});
