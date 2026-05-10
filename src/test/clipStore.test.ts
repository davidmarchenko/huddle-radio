import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { extensionFor, FileClipStore, resetDefaultClipStore } from "../server/clipStore";
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
