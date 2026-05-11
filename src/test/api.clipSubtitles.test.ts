import { describe, expect, it } from "vitest";
import { POST } from "../app/api/clip/subtitles/route";
import type { AudioClip } from "../shared/contracts";

/**
 * Integration tests for POST /api/clip/subtitles.
 *
 * The route runs the audio through the same ASR provider chain used
 * by /api/asr/transcribe and then formats the words as WebVTT. With
 * no NEMOTRON_API_KEY in the test env the words array is empty, so
 * we end up validating the WebVTT envelope + the wire shape rather
 * than caption content.
 */

const validAudio: AudioClip = {
  id: "audio-1",
  capturedAt: "2026-05-10T20:00:00Z",
  source: "broadcast",
  mimeType: "audio/webm;codecs=opus",
  dataUrl: "data:audio/webm;base64,QUJD",
  durationMs: 4500
};

function makeRequest(body: unknown): Request {
  return new Request("http://test.local/api/clip/subtitles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/clip/subtitles", () => {
  it("returns a subtitle envelope with a WEBVTT header for a valid clip", async () => {
    const response = await POST(makeRequest({ audio: validAudio }));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      transcriptId: string;
      text: string;
      vtt: string;
      words: unknown[];
      latencyMs: number;
    };
    expect(payload.transcriptId).toBeTruthy();
    expect(payload.vtt).toMatch(/^WEBVTT/);
    expect(Array.isArray(payload.words)).toBe(true);
    expect(typeof payload.latencyMs).toBe("number");
  });

  it("rejects a request whose body is not JSON", async () => {
    const response = await POST(
      new Request("http://test.local/api/clip/subtitles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      })
    );
    expect(response.status).toBe(400);
  });

  it("rejects a request with a missing or malformed audio field", async () => {
    const response = await POST(makeRequest({ audio: { id: "no-source" } }));
    expect(response.status).toBe(400);
  });
});
