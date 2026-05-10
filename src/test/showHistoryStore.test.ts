import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  InMemoryShowHistoryStore,
  JsonFileShowHistoryStore,
  isValidListenerId
} from "../server/showHistoryStore";
import type { ShowHistoryEntry } from "../shared/contracts";

const sample = (overrides: Partial<ShowHistoryEntry> = {}): ShowHistoryEntry => ({
  id: overrides.id ?? "show-1",
  startedAt: overrides.startedAt ?? "2026-05-09T20:00:00Z",
  endedAt: overrides.endedAt ?? "2026-05-09T21:00:00Z",
  sport: "nfl",
  gameId: "g1",
  gameLabel: "KC vs DET",
  listenerName: "Alex",
  totalCommentary: 12,
  ...overrides
});

describe("isValidListenerId", () => {
  it("accepts UUID-shaped ids", () => {
    expect(isValidListenerId("0123abcd-ef45-6789-abcd-ef0123456789")).toBe(true);
  });
  it("rejects empty / overlong / weird-character ids", () => {
    expect(isValidListenerId("")).toBe(false);
    expect(isValidListenerId("a".repeat(200))).toBe(false);
    expect(isValidListenerId("foo bar")).toBe(false); // space
    expect(isValidListenerId("../foo")).toBe(false); // path traversal
    expect(isValidListenerId(undefined)).toBe(false);
  });
});

describe("InMemoryShowHistoryStore", () => {
  it("archives, lists newest-first, and removes by id", async () => {
    const store = new InMemoryShowHistoryStore();
    await store.archive({ listenerId: "L", entry: sample({ id: "a", endedAt: "2026-05-09T20:00:00Z" }) });
    await store.archive({ listenerId: "L", entry: sample({ id: "b", endedAt: "2026-05-09T22:00:00Z" }) });

    const list = await store.list({ listenerId: "L" });
    expect(list.map((e) => e.id)).toEqual(["b", "a"]);

    expect(await store.remove({ listenerId: "L", showId: "a" })).toBe(true);
    expect((await store.list({ listenerId: "L" })).map((e) => e.id)).toEqual(["b"]);
  });

  it("re-archiving an existing id replaces rather than duplicates", async () => {
    const store = new InMemoryShowHistoryStore();
    await store.archive({ listenerId: "L", entry: sample({ id: "x", listenerName: "Alex" }) });
    await store.archive({ listenerId: "L", entry: sample({ id: "x", listenerName: "Alex Updated" }) });
    const list = await store.list({ listenerId: "L" });
    expect(list).toHaveLength(1);
    expect(list[0].listenerName).toBe("Alex Updated");
  });

  it("isolates listeners from one another", async () => {
    const store = new InMemoryShowHistoryStore();
    await store.archive({ listenerId: "A", entry: sample({ id: "1" }) });
    await store.archive({ listenerId: "B", entry: sample({ id: "2" }) });
    expect((await store.list({ listenerId: "A" })).map((e) => e.id)).toEqual(["1"]);
    expect((await store.list({ listenerId: "B" })).map((e) => e.id)).toEqual(["2"]);
  });

  it("limits the result count when a limit is provided", async () => {
    const store = new InMemoryShowHistoryStore();
    for (let i = 0; i < 10; i++) {
      await store.archive({ listenerId: "L", entry: sample({ id: `s${i}`, endedAt: `2026-05-09T2${i}:00:00Z`.replace("T2", "T0").slice(0, 24) }) });
    }
    const list = await store.list({ listenerId: "L", limit: 3 });
    expect(list).toHaveLength(3);
  });

  it("returns false from remove when nothing matches", async () => {
    const store = new InMemoryShowHistoryStore();
    expect(await store.remove({ listenerId: "L", showId: "nope" })).toBe(false);
  });
});

describe("JsonFileShowHistoryStore", () => {
  let dir: string;
  let store: JsonFileShowHistoryStore;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `show-history-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    store = new JsonFileShowHistoryStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists across instances", async () => {
    await store.archive({ listenerId: "L", entry: sample({ id: "abc" }) });
    const fresh = new JsonFileShowHistoryStore(dir);
    const list = await fresh.list({ listenerId: "L" });
    expect(list.map((e) => e.id)).toEqual(["abc"]);
  });

  it("rejects invalid listener ids on archive", async () => {
    await expect(store.archive({ listenerId: "../escape", entry: sample() })).rejects.toThrow(/Invalid listenerId/);
  });

  it("returns [] for unknown listener id without erroring", async () => {
    expect(await store.list({ listenerId: "never-existed" })).toEqual([]);
  });

  it("removes the file when the last entry is deleted", async () => {
    await store.archive({ listenerId: "L", entry: sample({ id: "only" }) });
    expect(await store.remove({ listenerId: "L", showId: "only" })).toBe(true);
    expect(await store.list({ listenerId: "L" })).toEqual([]);
  });
});
