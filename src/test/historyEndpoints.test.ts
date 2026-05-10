import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildApp } from "../server/app";
import { JsonFileShowHistoryStore, resetDefaultShowHistoryStore } from "../server/showHistoryStore";
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

describe("history endpoints", () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `history-endpoints-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    resetDefaultShowHistoryStore(new JsonFileShowHistoryStore(dir));
  });

  afterEach(async () => {
    resetDefaultShowHistoryStore(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects an invalid listenerId on GET", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/history/shows?listenerId=../escape" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("POST archives, GET returns the entry, DELETE removes it", async () => {
    const app = await buildApp();
    const listenerId = "0123abcd-ef45-6789-abcd-ef0123456789";

    const post = await app.inject({
      method: "POST",
      url: "/api/history/shows",
      payload: { listenerId, entry: sample({ id: "abc" }) }
    });
    expect(post.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: `/api/history/shows?listenerId=${listenerId}` });
    expect(get.statusCode).toBe(200);
    expect(JSON.parse(get.body).shows.map((s: ShowHistoryEntry) => s.id)).toEqual(["abc"]);

    const del = await app.inject({ method: "DELETE", url: `/api/history/shows/abc?listenerId=${listenerId}` });
    expect(del.statusCode).toBe(200);

    const getAfter = await app.inject({ method: "GET", url: `/api/history/shows?listenerId=${listenerId}` });
    expect(JSON.parse(getAfter.body).shows).toEqual([]);

    await app.close();
  });

  it("DELETE returns 404 when nothing matches", async () => {
    const app = await buildApp();
    const listenerId = "0123abcd-ef45-6789-abcd-ef0123456789";
    const response = await app.inject({ method: "DELETE", url: `/api/history/shows/nope?listenerId=${listenerId}` });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("rejects malformed POST bodies", async () => {
    const app = await buildApp();
    const listenerId = "0123abcd-ef45-6789-abcd-ef0123456789";
    const response = await app.inject({
      method: "POST",
      url: "/api/history/shows",
      payload: { listenerId, entry: { id: 123 } }
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
