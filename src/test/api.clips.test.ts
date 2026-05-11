import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/clips/route";
import { resetDefaultClipStore, BlobClipStore, FileClipStore } from "../server/clipStore";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Integration tests for POST /api/clips (the Vercel-deployable
 * replacement for the legacy Fastify clip upload).
 *
 * Two modes covered:
 *  - File-backed (default in dev / no BLOB_READ_WRITE_TOKEN):
 *    metadata.url is undefined and the route synthesizes a relative
 *    /api/clips/<id> URL the legacy Fastify GET serves.
 *  - Blob-backed (BLOB_READ_WRITE_TOKEN set): metadata.url is the
 *    Vercel Blob CDN URL and the route returns it directly.
 *
 * We swap the default store via `resetDefaultClipStore` so each test
 * controls which path runs without mutating env state.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `api-clips-${process.pid}-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  resetDefaultClipStore(undefined);
  await rm(tmpDir, { recursive: true, force: true });
});

function makeRequest(body: unknown): Request {
  return new Request("http://test.local/api/clips", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

const sampleAudioBase64 = Buffer.from("audio-bytes").toString("base64");

describe("POST /api/clips", () => {
  it("uploads via FileClipStore when no Blob token is configured and returns a relative /api/clips/<id> URL", async () => {
    resetDefaultClipStore(new FileClipStore(tmpDir));
    const response = await POST(
      makeRequest({
        listenerId: "listener-1",
        commentaryId: "c-abc",
        mimeType: "audio/webm",
        audioBase64: sampleAudioBase64
      })
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { id: string; url: string; mimeType: string; byteLength: number };
    expect(payload.id).toBeTruthy();
    expect(payload.mimeType).toBe("audio/webm");
    expect(payload.byteLength).toBeGreaterThan(0);
    // FileClipStore returns no canonical url; the route synthesizes
    // a relative path the legacy Fastify GET handler serves.
    expect(payload.url).toBe(`/api/clips/${payload.id}`);
  });

  it("uploads via BlobClipStore and returns the Blob CDN URL when one is configured", async () => {
    const put = vi.fn(async (pathname: string) => ({
      url: `https://blob.example.com/${pathname}`,
      pathname
    }));
    resetDefaultClipStore(new BlobClipStore({ put }));
    const response = await POST(
      makeRequest({
        listenerId: "listener-2",
        mimeType: "audio/webm",
        audioBase64: sampleAudioBase64
      })
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { url: string };
    expect(payload.url).toMatch(/^https:\/\/blob\.example\.com\/clips\/listener-2\//);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("rejects a request whose body is not JSON", async () => {
    const response = await POST(
      new Request("http://test.local/api/clips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json"
      })
    );
    expect(response.status).toBe(400);
  });

  it("rejects a request with a malformed listenerId (path-traversal guard)", async () => {
    resetDefaultClipStore(new FileClipStore(tmpDir));
    const response = await POST(
      makeRequest({
        listenerId: "../escape",
        mimeType: "audio/webm",
        audioBase64: sampleAudioBase64
      })
    );
    expect(response.status).toBe(400);
  });

  it("rejects a request missing the audioBase64 field", async () => {
    resetDefaultClipStore(new FileClipStore(tmpDir));
    const response = await POST(
      makeRequest({
        listenerId: "listener-3",
        mimeType: "audio/webm"
      })
    );
    expect(response.status).toBe(400);
  });
});
