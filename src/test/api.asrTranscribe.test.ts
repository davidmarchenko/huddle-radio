import { describe, expect, it } from "vitest";
import { POST } from "../app/api/asr/transcribe/route";
import type { AsrTranscript, AudioClip } from "../shared/contracts";

/**
 * Integration tests for POST /api/asr/transcribe.
 *
 * Provider chain falls back to NemotronAsrProvider with no API key
 * in the test environment, which yields an empty transcript with
 * confidence 0 — deterministic without external dependencies. We
 * validate the wire shape, not the model output.
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
  return new Request("http://test.local/api/asr/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/asr/transcribe", () => {
  it("returns an AsrTranscript for a valid clip in mock mode", async () => {
    const response = await POST(makeRequest({ audio: validAudio }));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as AsrTranscript;
    expect(payload.id).toBeTruthy();
    expect(payload.provider).toBe("nemotron-asr");
    expect(typeof payload.text).toBe("string");
    expect(typeof payload.latencyMs).toBe("number");
  });

  it("does not echo the raw provider response on the wire (it stays in server logs)", async () => {
    // We strip `raw` server-side so a 60+ KB chat-completion blob
    // doesn't ride along to the client on every cue.
    const response = await POST(makeRequest({ audio: validAudio }));
    const payload = (await response.json()) as AsrTranscript & { raw?: unknown };
    expect(payload.raw).toBeUndefined();
  });

  it("rejects a request whose body is not JSON", async () => {
    const response = await POST(
      new Request("http://test.local/api/asr/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "<<not-json>>"
      })
    );
    expect(response.status).toBe(400);
  });

  it("rejects a request missing the required audio field", async () => {
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/audio/i);
  });

  it("rejects an audio clip with a non-data URL", async () => {
    const response = await POST(
      makeRequest({ audio: { ...validAudio, dataUrl: "https://example.com/clip.webm" } })
    );
    expect(response.status).toBe(400);
  });

  it("accepts the optional play context without error", async () => {
    const response = await POST(
      makeRequest({
        audio: validAudio,
        play: {
          id: "play-1",
          type: "pass",
          excitement: 3,
          clock: "0:00",
          period: { number: 1, kind: "quarter" },
          possession: "KC",
          headline: "Test play",
          description: "Test description",
          playerIds: [],
          team: "KC",
          score: { away: 0, home: 0 },
          occurredAt: "2026-05-10T20:00:00Z"
        }
      })
    );
    expect(response.status).toBe(200);
  });
});
