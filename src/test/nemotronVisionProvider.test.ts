import { describe, expect, it } from "vitest";
import { NemotronVisionProvider } from "../providers/nemotronVisionProvider";
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

describe("NemotronVisionProvider", () => {
  it("returns an unavailable observation when no API key is configured", async () => {
    const provider = new NemotronVisionProvider(undefined);
    const obs = await provider.observe({ video, play, frame });
    expect(obs.validation?.status).toBe("unavailable");
  });

  it("posts the frame to the Nvidia OpenAI-compatible endpoint and parses the JSON payload", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    const provider = new NemotronVisionProvider(
      "test-key",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "https://integrate.api.nvidia.com/v1",
      async (input, init) => {
        capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (init?.body) capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            id: "test",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: '{"isSportsEvent":true,"sport":"football","confidence":0.92,"summary":"NFL broadcast","evidence":["scoreboard","field","helmet logos"],"reason":"Live football."}'
              },
              finish_reason: "stop"
            }],
            usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );

    const obs = await provider.observe({ video, play, frame });
    expect(obs.validation?.status).toBe("sports-event");
    expect(obs.validation?.confidence).toBeGreaterThan(0.6);
    expect(capturedUrl).toContain("integrate.api.nvidia.com");
    expect(capturedUrl).toContain("/chat/completions");
    expect(capturedBody?.model).toBe("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
    expect(capturedBody?.messages[1].content[1].image_url.url).toBe(frame.dataUrl);
  });

  it("falls through to unavailable on a non-200 response", async () => {
    const provider = new NemotronVisionProvider(
      "test-key",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "https://integrate.api.nvidia.com/v1",
      async () => new Response(JSON.stringify({ error: "rate" }), { status: 429 })
    );
    const obs = await provider.observe({ video, play, frame });
    expect(obs.validation?.status).toBe("unavailable");
  });

  it("reports ready in health when keyed", async () => {
    const provider = new NemotronVisionProvider("test-key");
    const health = await provider.health();
    expect(health.status).toBe("ready");
    expect(health.label).toContain("Nemotron");
  });

  it("reports disabled in health when no key", async () => {
    const provider = new NemotronVisionProvider(undefined);
    const health = await provider.health();
    expect(health.status).toBe("disabled");
  });
});
