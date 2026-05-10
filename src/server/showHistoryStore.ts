import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ShowHistoryEntry } from "../shared/contracts";

/**
 * Server-side persistence for the listener's archived shows.
 *
 * Today this lives in localStorage on the client only — single-device,
 * zero portability. This module lifts it server-side so a listener
 * who switches phone → laptop, or shares with a friend, sees the same
 * cross-show callbacks ("last week Mahomes burned you").
 *
 * Storage choice (W8 v1): JSON files keyed by `listenerId`. No external
 * DB dep, deterministic in tests, and trivially swappable for SQLite or
 * Postgres behind the same `ShowHistoryStore` interface when scale
 * demands it.
 *
 * Listener identity is an opaque UUID generated client-side and persisted
 * in localStorage; the server only sees a string. Real accounts (email
 * magic link or OAuth) belong to a separate workstream.
 */

export interface ShowHistoryStore {
  list(input: { listenerId: string; limit?: number }): Promise<ShowHistoryEntry[]>;
  archive(input: { listenerId: string; entry: ShowHistoryEntry }): Promise<void>;
  remove(input: { listenerId: string; showId: string }): Promise<boolean>;
}

const LISTENER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidListenerId(listenerId: unknown): listenerId is string {
  return typeof listenerId === "string" && LISTENER_ID_PATTERN.test(listenerId);
}

/**
 * In-memory store — used by tests and the no-disk dev mode.
 */
export class InMemoryShowHistoryStore implements ShowHistoryStore {
  private byListener = new Map<string, ShowHistoryEntry[]>();

  async list({ listenerId, limit }: { listenerId: string; limit?: number }): Promise<ShowHistoryEntry[]> {
    const all = (this.byListener.get(listenerId) ?? []).slice();
    all.sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
    return typeof limit === "number" && limit > 0 ? all.slice(0, limit) : all;
  }

  async archive({ listenerId, entry }: { listenerId: string; entry: ShowHistoryEntry }): Promise<void> {
    const list = this.byListener.get(listenerId) ?? [];
    // Replace existing entry with the same id so re-archiving the same
    // show (e.g. on retry) updates rather than duplicates.
    const filtered = list.filter((existing) => existing.id !== entry.id);
    filtered.push(entry);
    this.byListener.set(listenerId, filtered);
  }

  async remove({ listenerId, showId }: { listenerId: string; showId: string }): Promise<boolean> {
    const list = this.byListener.get(listenerId) ?? [];
    const next = list.filter((entry) => entry.id !== showId);
    this.byListener.set(listenerId, next);
    return next.length !== list.length;
  }
}

/**
 * Per-listener JSON file under a chosen base directory. Atomic writes
 * via tmp-file + rename so a crash mid-write can never corrupt history.
 */
export class JsonFileShowHistoryStore implements ShowHistoryStore {
  constructor(private readonly baseDir: string) {}

  async list({ listenerId, limit }: { listenerId: string; limit?: number }): Promise<ShowHistoryEntry[]> {
    if (!isValidListenerId(listenerId)) return [];
    const file = this.fileFor(listenerId);
    if (!existsSync(file)) return [];
    const raw = await readFile(file, "utf8");
    let entries: ShowHistoryEntry[];
    try {
      entries = JSON.parse(raw) as ShowHistoryEntry[];
    } catch {
      return [];
    }
    if (!Array.isArray(entries)) return [];
    entries.sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
    return typeof limit === "number" && limit > 0 ? entries.slice(0, limit) : entries;
  }

  async archive({ listenerId, entry }: { listenerId: string; entry: ShowHistoryEntry }): Promise<void> {
    if (!isValidListenerId(listenerId)) {
      throw new Error("Invalid listenerId.");
    }
    const all = await this.list({ listenerId });
    const filtered = all.filter((existing) => existing.id !== entry.id);
    filtered.push(entry);
    await this.writeAll(listenerId, filtered);
  }

  async remove({ listenerId, showId }: { listenerId: string; showId: string }): Promise<boolean> {
    if (!isValidListenerId(listenerId)) return false;
    const all = await this.list({ listenerId });
    const next = all.filter((entry) => entry.id !== showId);
    if (next.length === all.length) return false;
    if (next.length === 0) {
      const file = this.fileFor(listenerId);
      if (existsSync(file)) await unlink(file);
      return true;
    }
    await this.writeAll(listenerId, next);
    return true;
  }

  private async writeAll(listenerId: string, entries: ShowHistoryEntry[]): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const final = this.fileFor(listenerId);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    await rename(tmp, final);
  }

  private fileFor(listenerId: string): string {
    return path.join(this.baseDir, `${listenerId}.json`);
  }
}

let defaultStore: ShowHistoryStore | undefined;

export function getDefaultShowHistoryStore(): ShowHistoryStore {
  if (defaultStore) return defaultStore;
  const baseDir = process.env.SHOW_HISTORY_DIR ?? path.resolve("data/show-history");
  defaultStore = new JsonFileShowHistoryStore(baseDir);
  return defaultStore;
}

/** Reset the singleton — for tests. */
export function resetDefaultShowHistoryStore(store?: ShowHistoryStore): void {
  defaultStore = store;
}
