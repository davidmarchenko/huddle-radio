import { describe, expect, it } from "vitest";
import { NemotronAsrProvider } from "../providers/nemotronAsrProvider";
import type { AudioClip, SportsPlay } from "../shared/contracts";

const audio: AudioClip = {
  id: "a1",
  capturedAt: "2026-05-09T00:00:00Z",
  source: "broadcast",
  mimeType: "audio/webm;codecs=opus",
  dataUrl: "data:audio/webm;base64,QUJD",
  durationMs: 8000
};

const play: SportsPlay = {
  id: "p1",
  type: "pass",
  excitement: 3,
  clock: "0:00",
  period: { number: 1, kind: "quarter" },
  possession: "KC",
  headline: "h",
  description: "d",
  playerIds: [],
  team: "KC",
  score: { away: 0, home: 0 },
  occurredAt: "2026-05-09T00:00:00Z"
};

describe("NemotronAsrProvider", () => {
  it("returns an empty transcript with confidence 0 when no API key is configured", async () => {
    const provider = new NemotronAsrProvider(undefined);
    const transcript = await provider.transcribe({ audio });
    expect(transcript.text).toBe("");
    expect(transcript.confidence).toBe(0);
    expect(transcript.provider).toBe("nemotron-asr");
  });

  it("returns an empty transcript when audio dataUrl is missing", async () => {
    const provider = new NemotronAsrProvider("test-key");
    const transcript = await provider.transcribe({
      audio: { ...audio, dataUrl: "" }
    });
    expect(transcript.text).toBe("");
    expect(transcript.confidence).toBe(0);
  });

  it("posts the audio clip as input_audio and parses the JSON transcript with word timestamps", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    const provider = new NemotronAsrProvider(
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
                content: '{"text":"Touchdown Kansas City.","language":"en","confidence":0.94,"words":[{"text":"Touchdown","startMs":120,"endMs":640,"confidence":0.95},{"text":"Kansas","startMs":680,"endMs":920,"confidence":0.92},{"text":"City.","startMs":960,"endMs":1240,"confidence":0.93}]}'
              },
              finish_reason: "stop"
            }],
            usage: { prompt_tokens: 8, completion_tokens: 60, total_tokens: 68 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );

    const transcript = await provider.transcribe({ audio, play });
    expect(transcript.text).toBe("Touchdown Kansas City.");
    expect(transcript.language).toBe("en");
    expect(transcript.confidence).toBeGreaterThan(0.9);
    expect(transcript.words).toHaveLength(3);
    expect(transcript.words?.[0]).toMatchObject({ text: "Touchdown", startMs: 120, endMs: 640 });
    expect(capturedUrl).toContain("integrate.api.nvidia.com");
    expect(capturedUrl).toContain("/chat/completions");
    expect(capturedBody?.model).toBe("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
    // The audio payload uses input_audio with base64-stripped data and a webm format hint.
    const audioPart = capturedBody?.messages[1].content[1];
    expect(audioPart?.type).toBe("input_audio");
    expect(audioPart?.input_audio?.data).toBe("QUJD");
    expect(audioPart?.input_audio?.format).toBe("webm");
  });

  it("falls through to an empty transcript when the model returns a non-200", async () => {
    const provider = new NemotronAsrProvider(
      "test-key",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "https://integrate.api.nvidia.com/v1",
      async () => new Response(JSON.stringify({ error: "rate" }), { status: 429 })
    );
    const transcript = await provider.transcribe({ audio });
    expect(transcript.text).toBe("");
    expect(transcript.confidence).toBe(0);
  });

  it("infers mp3 format from mimeType when MediaRecorder produced an mp3 chunk", async () => {
    let capturedBody: any = null;
    const provider = new NemotronAsrProvider(
      "test-key",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "https://integrate.api.nvidia.com/v1",
      async (_input, init) => {
        if (init?.body) capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content: '{"text":"hi"}' }, finish_reason: "stop" }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );
    await provider.transcribe({
      audio: { ...audio, mimeType: "audio/mp3", dataUrl: "data:audio/mp3;base64,QUJD" }
    });
    expect(capturedBody?.messages[1].content[1].input_audio.format).toBe("mp3");
  });

  it("drops malformed words that lack timestamps", async () => {
    const provider = new NemotronAsrProvider(
      "test-key",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "https://integrate.api.nvidia.com/v1",
      async () =>
        new Response(
          JSON.stringify({
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: '{"text":"go","words":[{"text":"go","startMs":0,"endMs":200},{"text":"bad","startMs":300},{"text":"","startMs":400,"endMs":500}]}'
              },
              finish_reason: "stop"
            }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const transcript = await provider.transcribe({ audio });
    expect(transcript.words).toHaveLength(1);
    expect(transcript.words?.[0].text).toBe("go");
  });

  it("reports ready in health when keyed", async () => {
    const provider = new NemotronAsrProvider("test-key");
    const health = await provider.health();
    expect(health.status).toBe("ready");
    expect(health.label).toContain("Nemotron");
  });

  it("reports disabled in health when no key", async () => {
    const provider = new NemotronAsrProvider(undefined);
    const health = await provider.health();
    expect(health.status).toBe("disabled");
  });
});
