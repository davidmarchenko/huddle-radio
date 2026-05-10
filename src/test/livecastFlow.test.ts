import { describe, expect, it } from "vitest";
import { createLivecastCommentary } from "../engine/livecastEngine";
import { demoLeagueState, demoPlays } from "../providers/demoData";
import { MockModelProvider } from "../providers/mockModelProvider";
import { MockTTSProvider } from "../providers/ttsProviders";

describe("demo livecast flow", () => {
  it("moves from play to model observation to commentary to mock TTS", async () => {
    const play = demoPlays[0];
    const model = new MockModelProvider();
    const observation = await model.observe({ video: { mode: "stream-url" }, play });
    const commentary = createLivecastCommentary({
      league: demoLeagueState,
      play,
      observation,
      group: {
        listener: { name: "Alex", rosterId: "roster-alex" },
        tone: "pg",
        homeTeamBias: "fantasy-first",
        friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" }]
      },
      news: [],
      startedAt: performance.now()
    });

    const chunks = [];
    for await (const chunk of new MockTTSProvider().synthesize({ commentaryId: commentary.id, text: commentary.text })) {
      chunks.push(chunk);
    }

    expect(commentary.text).toContain(play.headline);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ commentaryId: commentary.id, isFinal: true });
  });
});
