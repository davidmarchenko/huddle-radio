import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { put as vercelBlobPut } from "@vercel/blob";

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
  /**
   * Canonical, externally-fetchable URL for the clip. Local
   * (FileClipStore) returns undefined and the route handler builds a
   * relative `/api/clips/<id>` URL the legacy Fastify GET serves.
   * Vercel Blob–backed stores return their CDN URL directly so the
   * client can share the link without a round-trip through our
   * server.
   */
  url?: string;
};

export interface ClipStore {
  put(input: { listenerId: string; commentaryId?: string; mimeType: string; data: Buffer }): Promise<ClipMetadata>;
  /** Read is only used by the Fastify GET route; Blob-backed stores
   * return undefined and the client uses metadata.url instead. */
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
    // Atomic write: tmp + rename for both files. Audio first; metadata
    // last so a partial write leaves no record from `read()` (which
    // gates on the metadata file) while still allowing cleanup of the
    // orphaned audio at the GC layer.
    const audioTmp = `${audioFile}.${process.pid}.${Date.now()}.tmp`;
    const metaTmp = `${metaFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(audioTmp, data);
    try {
      await rename(audioTmp, audioFile);
    } catch (error) {
      await unlink(audioTmp).catch(() => undefined);
      throw error;
    }
    await writeFile(metaTmp, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    try {
      await rename(metaTmp, metaFile);
    } catch (error) {
      await Promise.all([unlink(audioFile).catch(() => undefined), unlink(metaTmp).catch(() => undefined)]);
      throw error;
    }
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

/**
 * Vercel Blob–backed clip store. Used in production deploys where the
 * function filesystem is read-only / ephemeral and we need clips to
 * survive across invocations. Each upload returns the public Blob CDN
 * URL directly so the share blurb embeds a real link the recipient can
 * click without round-tripping through our server.
 *
 * Lazy-imports `@vercel/blob` so test runs without the package
 * resolved still pass; the constructor throws only when actually
 * instantiated without the dep.
 */
export class BlobClipStore implements ClipStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly putFn: (pathname: string, body: Buffer | Blob, opts: any) => Promise<{ url: string; pathname: string }>;

  constructor(
    options: {
      // Injected so tests can stub the upload without hitting Vercel
      // Blob's network. Production passes vercelBlobPut from the
      // top-level @vercel/blob import.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      put: (pathname: string, body: Buffer | Blob, opts: any) => Promise<{ url: string; pathname: string }>;
    }
  ) {
    this.putFn = options.put;
  }

  async put({
    listenerId,
    commentaryId,
    mimeType,
    data
  }: {
    listenerId: string;
    commentaryId?: string;
    mimeType: string;
    data: Buffer;
  }): Promise<ClipMetadata> {
    if (!LISTENER_ID_PATTERN.test(listenerId)) {
      throw new Error("Invalid listenerId.");
    }
    if (data.byteLength === 0) {
      throw new Error("Empty audio payload.");
    }
    if (data.byteLength > 8 * 1024 * 1024) {
      throw new Error("Clip too large (max 8MB).");
    }
    const id = generateClipId();
    const extension = extensionFor(mimeType);
    // Namespace by listener so a listener can later list / delete
    // their own clips without collecting somebody else's. Vercel
    // Blob's filename is treated as a path under the store.
    const pathname = `clips/${listenerId}/${id}.${extension}`;
    const result = await this.putFn(pathname, data, {
      access: "public",
      contentType: mimeType,
      // Blob filenames are unique by suffix; we already have a
      // collision-resistant id so disable suffixing to keep URLs clean.
      addRandomSuffix: false
    });
    return {
      id,
      listenerId,
      commentaryId,
      mimeType,
      byteLength: data.byteLength,
      storedAt: Date.now(),
      url: result.url
    };
  }

  // Blob-backed clips are served directly from the Blob CDN; the
  // server doesn't need to proxy them. The legacy GET route is only
  // for FileClipStore deployments.
  async read(): Promise<undefined> {
    return undefined;
  }
}

let defaultStore: ClipStore | undefined;

export function getDefaultClipStore(): ClipStore {
  if (defaultStore) return defaultStore;
  // Prefer Vercel Blob in production / preview deploys (token set by
  // the Marketplace integration). Fall back to filesystem locally so
  // npm run dev keeps working without provisioning Blob.
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    defaultStore = new BlobClipStore({ put: vercelBlobPut });
    return defaultStore;
  }
  const baseDir = process.env.CLIP_STORE_DIR ?? path.resolve("data/clips");
  defaultStore = new FileClipStore(baseDir);
  return defaultStore;
}

export function resetDefaultClipStore(store?: ClipStore): void {
  defaultStore = store;
}
