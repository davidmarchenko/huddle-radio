import { describe, expect, it } from "vitest";
import { createLivecastCommentary } from "../engine/livecastEngine";
import { demoLeagueState, demoPlays } from "../providers/demoData";
import { buildTranscriptExport } from "../shared/transcriptExport";

describe("buildTranscriptExport", () => {
  it("exports session highlights, moments, impacts, and transcript text", () => {
    const commentary = createLivecastCommentary({
      league: demoLeagueState,
      play: demoPlays[1],
      observation: {
        id: "obs",
        source: "stream-url",
        summary: "validated field view",
        confidence: 0.9,
        observedAt: new Date().toISOString(),
        latencyMs: 50
      },
      group: {
        listener: { name: "Alex", rosterId: "roster-alex" },
        tone: "pg",
        homeTeamBias: "fantasy-first",
        friends: [{ id: "maya", name: "Maya", favoriteTeam: "DET", rosterId: "roster-maya" }]
      },
      news: [],
      startedAt: performance.now()
    });

    const text = buildTranscriptExport({
      fantasy: demoLeagueState,
      game: {
        provider: "demo",
        gameId: "demo",
        sport: "nfl",
        awayTeam: "KC",
        homeTeam: "DET",
        status: "demo",
        recentPlays: [],
        currentPlay: demoPlays[1],
        updatedAt: new Date().toISOString()
      },
      providers: {
        fantasy: "Demo Fantasy",
        sportsData: "Demo Sports Data",
        news: "Demo News",
        enrichment: "(none)",
        video: "User Video Source",
        model: "Mock Model",
        commentary: "Local Commentary",
        tts: "Mock TTS"
      },
      commentary: [commentary],
      generatedAt: "2026-05-08T00:00:00.000Z"
    });

    expect(text).toContain("# Fantasy Livecast Recap");
    expect(text).toContain("Biggest moment");
    expect(text).toContain("Biggest fantasy swing");
    expect(text).toContain(commentary.moment.priority.toUpperCase());
    expect(text).toContain(commentary.text);
  });
});
