import { describe, expect, it } from "vitest";
import {
  buildCommentaryPayload,
  buildPlaySystemPrompt,
  resolveHostPersona,
  type CommentaryDraftInput
} from "../providers/commentaryPrompts";
import type { GroupSettings, ListenerCue, SportsPlay, VideoObservation } from "../shared/contracts";

const cue = (overrides: Partial<ListenerCue> = {}): ListenerCue => ({
  id: overrides.id ?? "c1",
  text: overrides.text ?? "What's happening with Mahomes?",
  capturedAt: overrides.capturedAt ?? "2026-05-10T20:00:00Z",
  confidence: overrides.confidence
});

const buildInput = (overrides: Partial<CommentaryDraftInput> = {}): CommentaryDraftInput => ({
  play: {
    id: "p1",
    description: "Run for 4",
    quarter: "Q1",
    clock: "10:00",
    playType: "rush",
    team: "KC",
    score: { away: 0, home: 0 },
    playerIds: [],
    occurredAt: "2026-05-10T20:00:00Z"
  } as unknown as SportsPlay,
  observation: { summary: "live game", confidence: 0.9 } as unknown as VideoObservation,
  impacts: [],
  group: {
    listener: { name: "Alex" },
    friends: [],
    tone: "pg",
    homeTeamBias: "fantasy-first"
  } as GroupSettings,
  news: [],
  recentCommentary: [],
  fallbackText: "—",
  ...overrides
});

describe("buildCommentaryPayload listenerCues handling", () => {
  it("emits an empty listenerCues array when none provided", () => {
    const payload = buildCommentaryPayload(buildInput(), resolveHostPersona("maya"));
    expect(payload.listenerCues).toEqual([]);
  });

  it("caps cues at the 3 most recent and forwards confidence", () => {
    const cues = [
      cue({ id: "c1", text: "first", confidence: 0.9 }),
      cue({ id: "c2", text: "second" }),
      cue({ id: "c3", text: "third", confidence: 0.4 }),
      cue({ id: "c4", text: "fourth — should be dropped" })
    ];
    const payload = buildCommentaryPayload(
      buildInput({ listenerCues: cues }),
      resolveHostPersona("maya")
    );
    expect(payload.listenerCues).toHaveLength(3);
    expect(payload.listenerCues[0]).toEqual({
      text: "first",
      capturedAt: "2026-05-10T20:00:00Z",
      confidence: 0.9
    });
    // Cues without confidence get null so the model can hedge.
    expect(payload.listenerCues[1].confidence).toBeNull();
  });

  it("filters out empty/whitespace cues so an aborted recording doesn't create a phantom cue", () => {
    const cues = [
      cue({ id: "c1", text: "real question" }),
      cue({ id: "c2", text: "   " }),
      cue({ id: "c3", text: "" })
    ];
    const payload = buildCommentaryPayload(
      buildInput({ listenerCues: cues }),
      resolveHostPersona("maya")
    );
    expect(payload.listenerCues).toHaveLength(1);
    expect(payload.listenerCues[0].text).toBe("real question");
  });
});

describe("buildPlaySystemPrompt listenerCues directive", () => {
  it("instructs the master writer to address one cue without quoting verbatim", () => {
    const prompt = buildPlaySystemPrompt(resolveHostPersona("maya"));
    expect(prompt).toMatch(/listenerCues/);
    // Phrasing shifted with the multi-turn rewrite — ONE turn (one host
    // holding the floor) addresses ONE cue, never quotes verbatim, never lists cues.
    expect(prompt).toMatch(/ONE turn addresses ONE cue/);
    expect(prompt).toMatch(/Don't quote verbatim/);
  });
});
