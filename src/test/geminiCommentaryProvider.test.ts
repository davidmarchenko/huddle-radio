import { describe, expect, it } from "vitest";
import { GeminiCommentaryProvider } from "../providers/geminiCommentaryProvider";
import type { CommentaryDraftInput } from "../providers/commentaryPrompts";

const input: CommentaryDraftInput = {
  play: {
    id: "p1",
    type: "pass",
    excitement: 3,
    clock: "0:00",
    period: { number: 1, kind: "quarter" },
    possession: "KC",
    headline: "Mahomes throws long",
    description: "Mahomes pass complete deep to Worthy.",
    playerIds: ["4046"],
    team: "KC",
    score: { away: 7, home: 3 },
    occurredAt: "2026-05-09T00:00:00Z"
  },
  observation: {
    id: "obs",
    source: "stream-url",
    summary: "",
    confidence: 0.5,
    observedAt: "2026-05-09T00:00:00Z",
    latencyMs: 10
  },
  impacts: [],
  group: {
    listener: { name: "Alex", favoriteTeam: "KC" },
    friends: [],
    tone: "pg",
    homeTeamBias: "fantasy-first"
  },
  news: [],
  recentCommentary: [],
  fallbackText: "Local fallback text.",
  hostId: "theo"
};

describe("GeminiCommentaryProvider", () => {
  it("returns the fallback wrapped as a single dialogue line when no API key is configured", async () => {
    const lines = await new GeminiCommentaryProvider(undefined).draft(input);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe(input.fallbackText);
  });

  it("posts to generateContent and parses the JSON dialogue response", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const dialogueJson = JSON.stringify({
      lines: [
        { speaker: "theo", text: "Mahomes goes deep, Alex." },
        { speaker: "maya", text: "Right, and the safety bit." }
      ]
    });
    const provider = new GeminiCommentaryProvider("test-key", "gemini-1.5-pro", async (url, init) => {
      captured.url = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      captured.init = init;
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: dialogueJson }] } }] }),
        { status: 200 }
      );
    });

    const lines = await provider.draft(input);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ hostId: "theo", text: "Mahomes goes deep, Alex." });
    expect(lines[1]).toMatchObject({ hostId: "maya" });
    expect(captured.url).toContain("gemini-1.5-pro");
    expect(captured.url).toContain("key=test-key");
    const body = JSON.parse(String(captured.init?.body));
    expect(body.systemInstruction.parts[0].text).toContain("Huddle Radio");
    expect(body.contents[0].parts[0].text).toContain("Alex");
  });

  it("throws on a non-200 response so the chain can advance", async () => {
    const provider = new GeminiCommentaryProvider("test-key", "gemini-1.5-pro", async () =>
      new Response("quota exceeded", { status: 429 })
    );
    await expect(provider.draft(input)).rejects.toThrow(/Gemini commentary request failed: 429/);
  });
});
