import { describe, expect, it } from "vitest";
import { demoLeagueState } from "../providers/demoData";
import { buildProductReadiness } from "../shared/productReadiness";
import { buildSessionDirector } from "../shared/sessionDirector";

const providers = {
  fantasy: "Demo Fantasy",
  sportsData: "ESPN Scoreboard",
  news: "Demo News",
  enrichment: "Reddit Game Threads",
  video: "User Video Source",
  model: "OpenAI Vision gpt-5.2",
  commentary: "OpenAI gpt-5.2",
  tts: "ElevenLabs eleven_flash_v2_5"
};

const group = {
  listener: { name: "Alex", rosterId: "roster-alex" },
  tone: "pg" as const,
  homeTeamBias: "fantasy-first" as const,
  friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" }]
};

const modelStack = {
  preset: "sota" as const,
  commentary: { provider: "openai" as const, model: "gpt-5.2", reasoningEffort: "none" as const, status: "ready" as const, role: "commentary" },
  realtime: { provider: "openai-realtime" as const, model: "gpt-realtime", status: "planned" as const, role: "realtime" },
  multimodal: { provider: "openai-vision" as const, model: "gpt-5.2", status: "ready" as const, role: "vision" },
  tts: { provider: "elevenlabs" as const, model: "eleven_flash_v2_5", status: "ready" as const, role: "voice" }
};

describe("buildSessionDirector", () => {
  it("creates a live-ready plan when product readiness is fully green", () => {
    const validation = {
      status: "sports-event" as const,
      confidence: 0.91,
      sport: "football" as const,
      evidence: ["field", "players", "scorebug"],
      reason: "Football game visible.",
      validatedAt: new Date().toISOString()
    };
    const readiness = buildProductReadiness({
      fantasy: demoLeagueState,
      group,
      providers: { ...providers, fantasy: "Sleeper Fantasy", news: "Sports News" },
      health: [],
      modelStack,
      streamValidation: validation,
      ttsEnabled: true,
      hasVideoSource: true,
      mediaCacheReady: true
    });

    const plan = buildSessionDirector({
      readiness,
      providers: { ...providers, fantasy: "Sleeper Fantasy", news: "Sports News" },
      fantasy: demoLeagueState,
      group,
      streamValidation: validation,
      isLive: true,
      commentaryCount: 2,
      playCount: 2
    });

    expect(plan.mode).toBe("live-ready");
    expect(plan.score).toBe(100);
    expect(plan.steps.find((step) => step.id === "live")?.state).toBe("active");
  });

  it("keeps blocked plans from looking startable", () => {
    const readiness = buildProductReadiness({
      fantasy: demoLeagueState,
      group,
      providers,
      health: [],
      modelStack,
      streamValidation: {
        status: "not-sports",
        confidence: 0.8,
        evidence: ["music video"],
        reason: "Not a game feed.",
        validatedAt: new Date().toISOString()
      },
      ttsEnabled: true,
      hasVideoSource: true,
      mediaCacheReady: true
    });

    const plan = buildSessionDirector({
      readiness,
      providers,
      fantasy: demoLeagueState,
      group,
      isLive: false,
      commentaryCount: 0,
      playCount: 0
    });

    expect(plan.mode).toBe("blocked");
    expect(plan.steps.find((step) => step.id === "live")?.state).toBe("blocked");
    expect(plan.fallbackPlan[0]).toContain("actual game feed");
  });

  it("surfaces latency guidance during data-only runs", () => {
    const readiness = buildProductReadiness({
      fantasy: demoLeagueState,
      group,
      providers: { ...providers, fantasy: "Sleeper Fantasy", news: "Sports News" },
      health: [],
      modelStack,
      streamValidation: {
        status: "unavailable",
        confidence: 0,
        evidence: ["cross-origin video"],
        reason: "Frame capture unavailable.",
        validatedAt: new Date().toISOString()
      },
      ttsEnabled: true,
      hasVideoSource: true,
      mediaCacheReady: true
    });

    const plan = buildSessionDirector({
      readiness,
      providers: { ...providers, fantasy: "Sleeper Fantasy", news: "Sports News" },
      fantasy: demoLeagueState,
      group,
      streamValidation: {
        status: "unavailable",
        confidence: 0,
        evidence: ["cross-origin video"],
        reason: "Frame capture unavailable.",
        validatedAt: new Date().toISOString()
      },
      isLive: true,
      commentaryCount: 1,
      playCount: 1,
      averageLatency: { endToEnd: 3200 }
    });

    expect(plan.mode).toBe("data-only");
    expect(plan.cues.some((cue) => cue.includes("Latency"))).toBe(true);
    expect(plan.fallbackPlan).toContain("Drop visual claims when video validation is unavailable.");
  });
});
