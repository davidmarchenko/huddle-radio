import "dotenv/config";
import { describe, expect, it } from "vitest";
import { OpenAICommentaryProvider } from "../providers/openAICommentaryProvider";
import { ElevenLabsTTSProvider } from "../providers/ttsProviders";
import { demoPlays } from "../providers/demoData";

describe("optional real provider smoke tests", () => {
  it("can call OpenAI commentary when OPENAI_API_KEY is present", async () => {
    if (!process.env.OPENAI_API_KEY) {
      expect(true).toBe(true);
      return;
    }
    const text = await new OpenAICommentaryProvider(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL ?? "gpt-4.1-mini").draft({
      play: demoPlays[0],
      observation: {
        id: "obs",
        source: "stream-url",
        summary: "The quarterback extended the play.",
        confidence: 0.9,
        observedAt: new Date().toISOString(),
        latencyMs: 80
      },
      impacts: [],
      group: { listener: { name: "Alex", rosterId: "roster-alex" }, tone: "pg", homeTeamBias: "balanced", friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC" }] },
      news: [],
      recentCommentary: [],
      fallbackText: "fallback"
    });
    expect(text).not.toBe("fallback");
    expect(text.length).toBeGreaterThan(10);
  }, 20000);

  it("reports ElevenLabs ready when ELEVENLABS_API_KEY is present", async () => {
    const health = await new ElevenLabsTTSProvider(process.env.ELEVENLABS_API_KEY, process.env.ELEVENLABS_VOICE_ID, process.env.ELEVENLABS_MODEL_ID).health();
    expect(health.status).toBe(process.env.ELEVENLABS_API_KEY ? "ready" : "disabled");
  });
});
