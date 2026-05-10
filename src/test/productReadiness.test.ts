import { describe, expect, it } from "vitest";
import { demoLeagueState } from "../providers/demoData";
import { buildProductReadiness } from "../shared/productReadiness";

const baseInput = {
  fantasy: demoLeagueState,
  group: {
    listener: { name: "Alex", rosterId: "roster-alex" },
    tone: "pg" as const,
    homeTeamBias: "fantasy-first" as const,
    friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" }]
  },
  providers: {
    fantasy: "Demo Fantasy",
    sportsData: "ESPN Scoreboard",
    news: "Demo News",
    video: "User Video Source",
    model: "OpenAI Vision gpt-5.2",
    commentary: "OpenAI gpt-5.2",
    tts: "ElevenLabs eleven_flash_v2_5"
  },
  health: [],
  modelStack: {
    preset: "sota" as const,
    commentary: { provider: "openai" as const, model: "gpt-5.2", reasoningEffort: "none" as const, status: "ready" as const, role: "commentary" },
    realtime: { provider: "openai-realtime" as const, model: "gpt-realtime", status: "planned" as const, role: "realtime" },
    multimodal: { provider: "openai-vision" as const, model: "gpt-5.2", status: "ready" as const, role: "vision" },
    tts: { provider: "elevenlabs" as const, model: "eleven_flash_v2_5", status: "ready" as const, role: "voice" }
  },
  ttsEnabled: true,
  hasVideoSource: true,
  mediaCacheReady: true
};

describe("buildProductReadiness", () => {
  it("marks the product ready when core services and sports validation are ready", () => {
    const readiness = buildProductReadiness({
      ...baseInput,
      streamValidation: {
        status: "sports-event",
        confidence: 0.88,
        sport: "football",
        evidence: ["field", "players"],
        reason: "Football game visible.",
        validatedAt: new Date().toISOString()
      }
    });

    expect(readiness.level).toBe("ready");
    expect(readiness.nextActions).toHaveLength(0);
  });

  it("blocks when visual validation confidently says not sports", () => {
    const readiness = buildProductReadiness({
      ...baseInput,
      streamValidation: {
        status: "not-sports",
        confidence: 0.83,
        evidence: ["team logo only"],
        reason: "Static team logo, not game action.",
        validatedAt: new Date().toISOString()
      }
    });

    expect(readiness.level).toBe("blocked");
    expect(readiness.nextActions[0]).toContain("actual game feed");
  });
});
