import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * W9: clip archival.
 *
 * The "Share moment" affordance today copies a text blurb. Real product
 * value lives in actual audio — a 20-second clip the listener can paste
 * into a group chat. The first version persists clips to the local
 * filesystem (S3-compatible storage is a follow-up; the interface
 * below is the seam for that swap).
 *
 * Each clip is a single audio blob keyed by a random short id, served
 * back through `GET /api/clips/:id`. Listener ownership via the W8
 * UUID is stamped at archive time so the same listener can list/delete
 * their own clips later if we add that surface.
 */

export type ClipMetadata = {
  id: string;
  listenerId: string;
  commentaryId?: string;
  mimeType: string;
  byteLength: number;
  storedAt: number;
};

export interface ClipStore {
  put(input: { listenerId: string; commentaryId?: string; mimeType: string; data: Buffer }): Promise<ClipMetadata>;
  read(id: string): Promise<{ metadata: ClipMetadata; data: Buffer } | undefined>;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const LISTENER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export class FileClipStore implements ClipStore {
  constructor(private readonly baseDir: string) {}

  async put({ listenerId, commentaryId, mimeType, data }: { listenerId: string; commentaryId?: string; mimeType: string; data: Buffer }): Promise<ClipMetadata> {
    if (!LISTENER_ID_PATTERN.test(listenerId)) {
      throw new Error("Invalid listenerId.");
    }
    if (data.byteLength === 0) {
      throw new Error("Empty audio payload.");
    }
    if (data.byteLength > 8 * 1024 * 1024) {
      throw new Error("Clip too large (max 8MB).");
    }
    await mkdir(this.baseDir, { recursive: true });
    const id = generateClipId();
    const extension = extensionFor(mimeType);
    const audioFile = path.join(this.baseDir, `${id}.${extension}`);
    const metaFile = path.join(this.baseDir, `${id}.json`);
    const metadata: ClipMetadata = {
      id,
      listenerId,
      commentaryId,
      mimeType,
      byteLength: data.byteLength,
      storedAt: Date.now()
    };
    await writeFile(audioFile, data);
    await writeFile(metaFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    return metadata;
  }

  async read(id: string): Promise<{ metadata: ClipMetadata; data: Buffer } | undefined> {
    if (!ID_PATTERN.test(id)) return undefined;
    const metaFile = path.join(this.baseDir, `${id}.json`);
    if (!existsSync(metaFile)) return undefined;
    const metaRaw = await readFile(metaFile, "utf8");
    let metadata: ClipMetadata;
    try {
      metadata = JSON.parse(metaRaw) as ClipMetadata;
    } catch {
      return undefined;
    }
    const audioFile = path.join(this.baseDir, `${id}.${extensionFor(metadata.mimeType)}`);
    if (!existsSync(audioFile)) return undefined;
    await stat(audioFile); // throws if missing/permissions
    const data = await readFile(audioFile);
    return { metadata, data };
  }
}

function generateClipId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  return `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function extensionFor(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  if (lower.includes("wav")) return "wav";
  if (lower.includes("ogg")) return "ogg";
  if (lower.includes("webm")) return "webm";
  if (lower.includes("aac") || lower.includes("mp4")) return "m4a";
  return "bin";
}

let defaultStore: ClipStore | undefined;

export function getDefaultClipStore(): ClipStore {
  if (defaultStore) return defaultStore;
  const baseDir = process.env.CLIP_STORE_DIR ?? path.resolve("data/clips");
  defaultStore = new FileClipStore(baseDir);
  return defaultStore;
}

export function resetDefaultClipStore(store?: ClipStore): void {
  defaultStore = store;
}
