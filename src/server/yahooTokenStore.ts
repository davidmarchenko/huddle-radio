import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Per-listener Yahoo OAuth token storage.
 *
 * Same shape as `showHistoryStore` (per-listener JSON file under a
 * configurable base dir, atomic tmp+rename writes) but separated
 * because the data shape is unrelated and we want different retention
 * policies. Tokens are sensitive: the file lives outside source
 * control (`data/yahoo-tokens/` is gitignored alongside the rest of
 * `data/`).
 */

export type YahooTokenRecord = {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when access token expires. */
  expiresAt: number;
  yahooGuid?: string;
  scope?: string;
  storedAt: number;
};

const LISTENER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface YahooTokenStore {
  get(listenerId: string): Promise<YahooTokenRecord | undefined>;
  put(listenerId: string, record: YahooTokenRecord): Promise<void>;
  remove(listenerId: string): Promise<boolean>;
}

export class InMemoryYahooTokenStore implements YahooTokenStore {
  private byListener = new Map<string, YahooTokenRecord>();

  async get(listenerId: string): Promise<YahooTokenRecord | undefined> {
    return this.byListener.get(listenerId);
  }

  async put(listenerId: string, record: YahooTokenRecord): Promise<void> {
    this.byListener.set(listenerId, record);
  }

  async remove(listenerId: string): Promise<boolean> {
    return this.byListener.delete(listenerId);
  }
}

export class JsonFileYahooTokenStore implements YahooTokenStore {
  constructor(private readonly baseDir: string) {}

  async get(listenerId: string): Promise<YahooTokenRecord | undefined> {
    if (!LISTENER_ID_PATTERN.test(listenerId)) return undefined;
    const file = this.fileFor(listenerId);
    if (!existsSync(file)) return undefined;
    try {
      const raw = await readFile(file, "utf8");
      return JSON.parse(raw) as YahooTokenRecord;
    } catch {
      return undefined;
    }
  }

  async put(listenerId: string, record: YahooTokenRecord): Promise<void> {
    if (!LISTENER_ID_PATTERN.test(listenerId)) {
      throw new Error("Invalid listenerId.");
    }
    await mkdir(this.baseDir, { recursive: true });
    const final = this.fileFor(listenerId);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(tmp, final);
  }

  async remove(listenerId: string): Promise<boolean> {
    if (!LISTENER_ID_PATTERN.test(listenerId)) return false;
    const file = this.fileFor(listenerId);
    if (!existsSync(file)) return false;
    await unlink(file);
    return true;
  }

  private fileFor(listenerId: string): string {
    return path.join(this.baseDir, `${listenerId}.json`);
  }
}

let defaultStore: YahooTokenStore | undefined;

export function getDefaultYahooTokenStore(): YahooTokenStore {
  if (defaultStore) return defaultStore;
  const baseDir = process.env.YAHOO_TOKEN_DIR ?? path.resolve("data/yahoo-tokens");
  defaultStore = new JsonFileYahooTokenStore(baseDir);
  return defaultStore;
}

export function resetDefaultYahooTokenStore(store?: YahooTokenStore): void {
  defaultStore = store;
}
