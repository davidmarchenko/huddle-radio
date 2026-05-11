import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BlobClipStore, extensionFor, FileClipStore, resetDefaultClipStore } from "../server/clipStore";
import { buildApp } from "../server/app";

describe("extensionFor", () => {
  it("maps common audio mime types to file extensions", () => {
    expect(extensionFor("audio/mpeg")).toBe("mp3");
    expect(extensionFor("audio/mp3")).toBe("mp3");
    expect(extensionFor("audio/wav")).toBe("wav");
    expect(extensionFor("audio/webm")).toBe("webm");
    expect(extensionFor("audio/aac")).toBe("m4a");
    expect(extensionFor("audio/garbage")).toBe("bin");
  });
});

describe("FileClipStore", () => {
  let dir: string;
  let store: FileClipStore;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `clip-store-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    store = new FileClipStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists a clip and reads it back with metadata", async () => {
    const data = Buffer.from("audio-bytes-here", "utf8");
    const meta = await store.put({ listenerId: "L", commentaryId: "c1", mimeType: "audio/mpeg", data });
    expect(meta.id).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(meta.byteLength).toBe(data.byteLength);

    const read = await store.read(meta.id);
    expect(read?.data.equals(data)).toBe(true);
    expect(read?.metadata.commentaryId).toBe("c1");
    expect(read?.metadata.listenerId).toBe("L");
  });

  it("rejects empty payloads", async () => {
    await expect(store.put({ listenerId: "L", mimeType: "audio/mpeg", data: Buffer.alloc(0) })).rejects.toThrow(/Empty audio payload/);
  });

  it("rejects oversized payloads", async () => {
    const huge = Buffer.alloc(9 * 1024 * 1024);
    await expect(store.put({ listenerId: "L", mimeType: "audio/mpeg", data: huge })).rejects.toThrow(/too large/);
  });

  it("rejects path-traversal listener ids", async () => {
    await expect(store.put({ listenerId: "../escape", mimeType: "audio/mpeg", data: Buffer.from("x") })).rejects.toThrow(/Invalid listenerId/);
  });

  it("returns undefined for unknown clip ids", async () => {
    expect(await store.read("nope")).toBeUndefined();
  });
});

describe("clip endpoints", () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `clip-endpoints-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    resetDefaultClipStore(new FileClipStore(dir));
  });

  afterEach(async () => {
    resetDefaultClipStore(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("POST /api/clips persists the audio and GET /api/clips/:id returns it", async () => {
    const app = await buildApp();
    const listenerId = "0123abcd-ef45-6789-abcd-ef0123456789";
    const audioBase64 = Buffer.from("hello-mp3-bytes").toString("base64");
    const post = await app.inject({
      method: "POST",
      url: "/api/clips",
      payload: { listenerId, mimeType: "audio/mpeg", audioBase64 }
    });
    expect(post.statusCode).toBe(200);
    const payload = JSON.parse(post.body) as { id: string; url: string; mimeType: string };
    expect(payload.url).toBe(`/api/clips/${payload.id}`);

    const get = await app.inject({ method: "GET", url: payload.url });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("audio/mpeg");
    await app.close();
  });

  it("rejects malformed POST bodies with 400", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/clips",
      payload: { listenerId: "../escape", mimeType: "audio/mpeg", audioBase64: "x" }
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 for missing clip ids", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/clips/missing" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("BlobClipStore", () => {
  it("uploads to Vercel Blob and surfaces the CDN URL on metadata", async () => {
    // Stub the @vercel/blob put fn so the test never touches the
    // network. We assert on the upload contract: namespaced path,
    // public access, content type honored, returned URL passed
    // straight back through metadata.url.
    const put = vi.fn(async (pathname: string, _body: Buffer, _opts: unknown) => ({
      url: `https://blob.example/${pathname}`,
      pathname
    }));
    const store = new BlobClipStore({ put });
    const data = Buffer.from("audio-bytes");
    const meta = await store.put({
      listenerId: "listener-abc",
      commentaryId: "commentary-xyz",
      mimeType: "audio/webm",
      data
    });
    expect(meta.byteLength).toBe(data.byteLength);
    expect(meta.mimeType).toBe("audio/webm");
    expect(meta.url).toBe(`https://blob.example/clips/listener-abc/${meta.id}.webm`);
    // Path is namespaced by listenerId so a listener can later
    // enumerate / delete their own clips without scanning the global
    // namespace.
    const [pathname, body, opts] = put.mock.calls[0];
    expect(pathname).toMatch(/^clips\/listener-abc\//);
    expect(body).toBe(data);
    expect(opts).toMatchObject({ access: "public", contentType: "audio/webm", addRandomSuffix: false });
  });

  it("rejects an empty payload before calling the upload backend", async () => {
    const put = vi.fn();
    const store = new BlobClipStore({ put });
    await expect(
      store.put({
        listenerId: "listener-1",
        mimeType: "audio/webm",
        data: Buffer.alloc(0)
      })
    ).rejects.toThrow(/empty/i);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects an oversized payload before calling the upload backend", async () => {
    const put = vi.fn();
    const store = new BlobClipStore({ put });
    await expect(
      store.put({
        listenerId: "listener-1",
        mimeType: "audio/webm",
        data: Buffer.alloc(9 * 1024 * 1024) // 9 MB > 8 MB cap
      })
    ).rejects.toThrow(/large|max/i);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a malformed listenerId so a path-traversal attempt can't bleed across listeners", async () => {
    const put = vi.fn();
    const store = new BlobClipStore({ put });
    await expect(
      store.put({
        listenerId: "../escape",
        mimeType: "audio/webm",
        data: Buffer.from("hi")
      })
    ).rejects.toThrow(/listenerId/i);
    expect(put).not.toHaveBeenCalled();
  });

  it("read() returns undefined — Blob clips are served from the CDN, not proxied", async () => {
    const store = new BlobClipStore({ put: vi.fn() });
    expect(await store.read()).toBeUndefined();
  });
});
