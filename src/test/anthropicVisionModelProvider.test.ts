import { describe, expect, it } from "vitest";
import { AnthropicVisionModelProvider } from "../providers/anthropicVisionModelProvider";
import type { SportsPlay, VideoFrameSnapshot, VideoSourceConfig } from "../shared/contracts";

const play: SportsPlay = {
  id: "p1",
  type: "pass",
  excitement: 3,
  clock: "0:00",
  quarter: "Q1",
  possession: "KC",
  headline: "h",
  description: "d",
  playerIds: [],
  team: "KC",
  score: { away: 0, home: 0 },
  occurredAt: "2026-05-09T00:00:00Z"
};

const frame: VideoFrameSnapshot = {
  id: "f1",
  dataUrl: "data:image/jpeg;base64,QUJD",
  capturedAt: "2026-05-09T00:00:00Z",
  source: "stream-url",
  width: 64,
  height: 64
};

const video: VideoSourceConfig = { mode: "stream-url", url: "https://example/stream" };

describe("AnthropicVisionModelProvider", () => {
  it("returns an unavailable observation when no API key is configured", async () => {
    const provider = new AnthropicVisionModelProvider(undefined);
    const obs = await provider.observe({ video, play, frame });
    expect(obs.validation?.status).toBe("unavailable");
  });

  it("posts the frame as base64 to Anthropic and parses the JSON payload", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const provider = new AnthropicVisionModelProvider("test-key", "claude-sonnet-4-6", async (url, init) => {
      captured.url = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      captured.init = init;
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"isSportsEvent":true,"sport":"football","confidence":0.91,"summary":"Live NFL broadcast","evidence":["scoreboard","field"],"reason":"Looks like an NFL game."}' }]
        }),
        { status: 200 }
      );
    });

    const obs = await provider.observe({ video, play, frame });
    expect(obs.validation?.status).toBe("sports-event");
    expect(obs.validation?.confidence).toBeGreaterThan(0.6);
    const body = JSON.parse(String(captured.init?.body));
    expect(body.messages[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } });
  });

  it("returns an unavailable observation on a non-200 response", async () => {
    const provider = new AnthropicVisionModelProvider("test-key", "claude-sonnet-4-6", async () => new Response("rate", { status: 429 }));
    const obs = await provider.observe({ video, play, frame });
    expect(obs.validation?.status).toBe("unavailable");
    expect(obs.validation?.reason).toContain("Anthropic vision request failed");
  });
});
