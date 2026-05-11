import { describe, expect, it } from "vitest";
import { DemoFantasyProvider } from "../providers/demoFantasyProvider";
import { DemoNewsProvider } from "../providers/demoNewsProvider";
import { DemoSportsDataProvider } from "../providers/demoSportsDataProvider";
import { MockModelProvider } from "../providers/mockModelProvider";
import { OpenAICommentaryProvider, LocalCommentaryProvider } from "../providers/openAICommentaryProvider";
import { MockTTSProvider, ElevenLabsTTSProvider } from "../providers/ttsProviders";
import { UserVideoProvider } from "../providers/userVideoProvider";
import { demoPlays } from "../providers/demoData";

describe("demo providers", () => {
  it("returns a stable demo fantasy league contract", async () => {
    const league = await new DemoFantasyProvider().getLeagueState();
    expect(league.provider).toBe("demo");
    expect(league.matchups[0].rosters).toHaveLength(2);
    expect(league.matchups[0].rosters.flatMap((roster) => roster.starters).some((player) => player.id === "kc-te-87")).toBe(true);
  });

  it("cycles scripted sports plays and retains recent game state", async () => {
    const provider = new DemoSportsDataProvider();
    const first = await provider.nextPlay();
    const second = await provider.nextPlay();
    const game = await provider.getGameState();
    expect(first.id).not.toBe(second.id);
    expect(game.currentPlay?.id).toBe(second.id);
    expect(game.recentPlays).toHaveLength(2);
  });

  it("routes plays by gameId — NBA gameId streams NBA plays, NFL gameId streams NFL plays", async () => {
    const nflProvider = new DemoSportsDataProvider("demo-kc-det");
    const nflPlay = await nflProvider.nextPlay();
    const nflGame = await nflProvider.getGameState();
    expect(nflGame.sport).toBe("nfl");
    expect(nflGame.awayTeam).toBe("KC");
    expect(nflGame.homeTeam).toBe("DET");
    expect(nflPlay.id).toMatch(/^play-/);

    const nbaProvider = new DemoSportsDataProvider("demo-den-okc");
    const nbaPlay = await nbaProvider.nextPlay();
    const nbaGame = await nbaProvider.getGameState();
    expect(nbaGame.sport).toBe("nba");
    expect(nbaGame.awayTeam).toBe("DEN");
    expect(nbaGame.homeTeam).toBe("OKC");
    expect(nbaPlay.id).toMatch(/^nba-play-/);
  });

  it("falls back to the default NFL game when given an unknown gameId", async () => {
    const provider = new DemoSportsDataProvider("never-heard-of-it");
    const game = await provider.getGameState();
    expect(game.sport).toBe("nfl");
    expect(game.gameId).toBe("demo-kc-det");
  });

  it("returns demo news scoped to the requested team and player ids", async () => {
    const news = await new DemoNewsProvider().getLatest({ playerIds: ["p1", "p2", "p3"], teams: ["KC"] });
    expect(news[0].team).toBe("KC");
    expect(news[0].playerIds).toEqual(["p1", "p2"]);
  });

  it("mock model varies observation language by play type", async () => {
    const provider = new MockModelProvider();
    const pass = await provider.observe({ video: { mode: "stream-url" }, play: demoPlays[0] });
    const turnover = await provider.observe({ video: { mode: "stream-url" }, play: demoPlays[4] });
    expect(pass.summary).not.toBe(turnover.summary);
    expect(turnover.summary.toLowerCase()).toMatch(/turnover|pressure|mistake|defense|manager/);
  });

  it("user video provider reports configured source mode", async () => {
    const observation = await new UserVideoProvider().observe({ mode: "vod", url: "https://example.com/demo.mp4" });
    expect(observation.source).toBe("vod");
    expect(observation.confidence).toBeGreaterThan(0.5);
  });
});

describe("commentary and TTS providers", () => {
  it("local commentary returns fallback text wrapped as a single dialogue line", async () => {
    const lines = await new LocalCommentaryProvider().draft({
      play: demoPlays[0],
      observation: { id: "obs", source: "stream-url", summary: "summary", confidence: 0.8, observedAt: new Date().toISOString(), latencyMs: 1 },
      impacts: [],
      group: { listener: { name: "Alex", rosterId: "roster-alex" }, tone: "pg", homeTeamBias: "balanced", friends: [{ id: "a", name: "Alex", favoriteTeam: "KC" }] },
      news: [],
      recentCommentary: [],
      fallbackText: "fallback"
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("fallback");
  });

  it("OpenAI commentary falls back to a single line when no API key is configured", async () => {
    const lines = await new OpenAICommentaryProvider(undefined).draft({
      play: demoPlays[0],
      observation: { id: "obs", source: "stream-url", summary: "summary", confidence: 0.8, observedAt: new Date().toISOString(), latencyMs: 1 },
      impacts: [],
      group: { listener: { name: "Alex", rosterId: "roster-alex" }, tone: "pg", homeTeamBias: "balanced", friends: [{ id: "a", name: "Alex", favoriteTeam: "KC" }] },
      news: [],
      recentCommentary: [],
      fallbackText: "safe fallback"
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("safe fallback");
  });

  it("mock TTS yields one final non-audio metadata chunk", async () => {
    const chunks = [];
    for await (const chunk of new MockTTSProvider().synthesize({ commentaryId: "c1", text: "hello" })) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ commentaryId: "c1", provider: "mock-tts", isFinal: true });
  });

  it("ElevenLabs health is disabled without a key", async () => {
    const health = await new ElevenLabsTTSProvider(undefined).health();
    expect(health.status).toBe("disabled");
  });

  it("ElevenLabs health surfaces per-host voice configuration when set", async () => {
    const health = await new ElevenLabsTTSProvider(
      "test-key",
      "default-voice",
      "model-x",
      { maya: "voice-maya", cam: "voice-cam" }
    ).health();
    expect(health.status).toBe("ready");
    expect(health.detail).toMatch(/Per-host voices configured for: maya, cam/);
  });

  it("ElevenLabs health hides per-host summary when no overrides are set", async () => {
    const health = await new ElevenLabsTTSProvider("test-key").health();
    expect(health.detail).not.toMatch(/Per-host voices configured/);
  });
});
