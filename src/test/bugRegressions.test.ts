/**
 * Regression tests covering bugs found in the codebase audit (commit
 * thread on 2026-05-10). Each `it` corresponds to a specific bug —
 * keep one-to-one if you change the test names so a future audit can
 * trace what's actually verified.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileClipStore, resetDefaultClipStore } from "../server/clipStore";
import { SportsGamesCache } from "../server/sportsGamesCache";
import { NewsProviderChain } from "../providers/newsProviderChain";
import type { NewsItem, NewsProvider, ProviderHealth, SportsGameOption } from "../shared/contracts";
import { buildApp } from "../server/app";
import { JsonFileShowHistoryStore, resetDefaultShowHistoryStore } from "../server/showHistoryStore";

const sport = { sport: "nfl" as const, label: "NFL", path: "football/nfl" };

class FakeNews implements NewsProvider {
  id: string;
  calls = 0;
  constructor(id: string, private readonly behavior: () => Promise<NewsItem[]>) {
    this.id = id;
  }
  async getLatest(): Promise<NewsItem[]> {
    this.calls++;
    return this.behavior();
  }
  async health(): Promise<ProviderHealth> {
    return { id: this.id, label: this.id, status: "ready", detail: "fake" };
  }
}

describe("ClipStore atomic writes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `clip-atomic-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves no .tmp files on a successful put — atomic rename completed for both files", async () => {
    const store = new FileClipStore(dir);
    await store.put({ listenerId: "L", mimeType: "audio/mpeg", data: Buffer.from("hi") });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("the metadata file points at an audio file that exists", async () => {
    const store = new FileClipStore(dir);
    const meta = await store.put({ listenerId: "L", mimeType: "audio/mpeg", data: Buffer.from("hi") });
    const audioPath = path.join(dir, `${meta.id}.mp3`);
    expect(existsSync(audioPath)).toBe(true);
    const audioStat = await stat(audioPath);
    expect(audioStat.size).toBe(2);
    const metaPath = path.join(dir, `${meta.id}.json`);
    const metaRaw = await readFile(metaPath, "utf8");
    expect(JSON.parse(metaRaw).id).toBe(meta.id);
  });
});

describe("SportsGamesCache background refresh error reporting", () => {
  it("calls onBackgroundRefreshError instead of silently swallowing", async () => {
    let now = 0;
    const errors: Array<{ sport: string; error: unknown }> = [];
    const cache = new SportsGamesCache(
      async () => {
        if (now > 0) throw new Error("ESPN exploded");
        return [{
          id: "a",
          label: "A",
          shortName: "A",
          sport: "nfl",
          awayTeam: "X",
          homeTeam: "Y",
          score: { away: 0, home: 0 },
          status: "scheduled",
          detail: "scheduled"
        } as SportsGameOption];
      },
      {
        freshMs: 100,
        staleMs: 1000,
        now: () => now,
        onBackgroundRefreshError: (sport, error) => errors.push({ sport, error })
      }
    );

    await cache.get(sport);
    now = 200; // expired fresh, still inside stale
    const stale = await cache.get(sport);
    expect(stale[0].id).toBe("a");
    // Let the rejected background promise settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0].sport).toBe("nfl");
    expect(cache.getStats().backgroundRefreshErrors).toBe(1);
  });
});

describe("NewsProviderChain — no terminal double-call", () => {
  it("each provider is asked exactly once even when every one throws", async () => {
    const a = new FakeNews("a", async () => {
      throw new Error("a-fail");
    });
    const b = new FakeNews("b", async () => {
      throw new Error("b-fail");
    });
    const chain = new NewsProviderChain([a, b]);
    const items = await chain.getLatest({ playerIds: [], teams: [], sport: "nfl" });
    expect(items).toEqual([]);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
  });
});

describe("/api/history/shows Zod validation", () => {
  let dir: string;
  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `history-zod-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    resetDefaultShowHistoryStore(new JsonFileShowHistoryStore(dir));
  });
  afterEach(async () => {
    resetDefaultShowHistoryStore(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects entries missing required fields like sport / gameId / totalCommentary", async () => {
    const app = await buildApp();
    const listenerId = "0123abcd-ef45-6789-abcd-ef0123456789";
    const incomplete = {
      listenerId,
      entry: { id: "abc", startedAt: "2026-05-09T20:00:00Z", endedAt: "2026-05-09T21:00:00Z" }
    };
    const response = await app.inject({ method: "POST", url: "/api/history/shows", payload: incomplete });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects entries with the wrong sport enum value", async () => {
    const app = await buildApp();
    const listenerId = "0123abcd-ef45-6789-abcd-ef0123456789";
    const badSport = {
      listenerId,
      entry: {
        id: "abc",
        startedAt: "2026-05-09T20:00:00Z",
        endedAt: "2026-05-09T21:00:00Z",
        sport: "cricket",
        gameId: "g",
        gameLabel: "X",
        listenerName: "Alex",
        totalCommentary: 1
      }
    };
    const response = await app.inject({ method: "POST", url: "/api/history/shows", payload: badSport });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("/api/clips Zod validation", () => {
  let dir: string;
  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `clips-zod-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    resetDefaultClipStore(new FileClipStore(dir));
  });
  afterEach(async () => {
    resetDefaultClipStore(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects missing mimeType up front rather than letting it through to the buffer write", async () => {
    const app = await buildApp();
    const listenerId = "0123abcd-ef45-6789-abcd-ef0123456789";
    const response = await app.inject({
      method: "POST",
      url: "/api/clips",
      payload: { listenerId, audioBase64: Buffer.from("x").toString("base64") }
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects mime types with shell-meta characters", async () => {
    const app = await buildApp();
    const listenerId = "0123abcd-ef45-6789-abcd-ef0123456789";
    const response = await app.inject({
      method: "POST",
      url: "/api/clips",
      payload: {
        listenerId,
        mimeType: "audio/mpeg; rm -rf /",
        audioBase64: Buffer.from("x").toString("base64")
      }
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
