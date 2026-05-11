import { describe, expect, it } from "vitest";
import { POST } from "../app/api/vision/observe/route";
import type { FrameValidationResponse, VideoFrameSnapshot } from "../shared/contracts";

/**
 * Integration tests for POST /api/vision/observe.
 *
 * Imports the handler directly + invokes it with a constructed
 * Request — no test server needed because Route Handlers are pure
 * `(Request) => Response` functions. Provider chain runs in mock
 * mode (NODE_ENV=test forces RESOLVED_MODEL_PROVIDER="mock"), so
 * the response shape is deterministic without external dependencies.
 */

const validFrame: VideoFrameSnapshot = {
  id: "frame-1",
  capturedAt: "2026-05-10T20:00:00Z",
  source: "screen-share",
  width: 1280,
  height: 720,
  dataUrl: "data:image/jpeg;base64,QUJD"
};

const blockedFrame: VideoFrameSnapshot = {
  ...validFrame,
  dataUrl: "",
  blockedReason: "YouTube embed cannot be pixel-sampled."
};

function makeRequest(body: unknown): Request {
  return new Request("http://test.local/api/vision/observe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/vision/observe", () => {
  it("returns a FrameValidationResponse for a valid frame in mock mode", async () => {
    const response = await POST(makeRequest({ frame: validFrame }));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as FrameValidationResponse;
    expect(payload.observation).toBeDefined();
    expect(payload.observation.id).toBeTruthy();
    expect(payload.observation.source).toBe("screen-share");
    expect(typeof payload.observation.confidence).toBe("number");
    // Mock mode still emits a validation envelope, so the consumer
    // can rely on observation.validation being present.
    expect(payload.observation.validation).toBeDefined();
  });

  it("still returns an observation (not an error) when the frame is blocked", async () => {
    // A frame can carry blockedReason instead of pixel data when the
    // browser couldn't sample the source (cross-origin DRM, YouTube
    // embed, etc.). The handler must still return 200 + a valid
    // observation envelope so the UI can surface the blocked reason
    // without crashing.
    const response = await POST(makeRequest({ frame: blockedFrame }));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as FrameValidationResponse;
    expect(payload.observation).toBeDefined();
    expect(payload.observation.validation).toBeDefined();
  });

  it("threads the optional video context (mode + url) into the provider call", async () => {
    const response = await POST(
      makeRequest({
        frame: validFrame,
        video: { mode: "stream-url", url: "https://example.com/stream.m3u8" }
      })
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as FrameValidationResponse;
    expect(payload.observation.source).toBe("stream-url");
  });

  it("rejects a request whose body is not JSON", async () => {
    const response = await POST(
      new Request("http://test.local/api/vision/observe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json"
      })
    );
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/JSON/);
  });

  it("rejects a request missing the required frame field", async () => {
    const response = await POST(makeRequest({ video: { mode: "stream-url" } }));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/frame/i);
  });

  it("rejects a frame snapshot missing required identity fields", async () => {
    const response = await POST(
      makeRequest({
        frame: {
          // Missing id + capturedAt — predicate should reject.
          source: "screen-share",
          width: 100,
          height: 100,
          dataUrl: "data:image/jpeg;base64,QUJD"
        }
      })
    );
    expect(response.status).toBe(400);
  });
});
