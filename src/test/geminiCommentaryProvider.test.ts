import { describe, expect, it } from "vitest";
import { GeminiCommentaryProvider } from "../providers/geminiCommentaryProvider";
import type { CommentaryDraftInput } from "../providers/commentaryPrompts";

const input: CommentaryDraftInput = {
  play: {
    id: "p1",
    type: "pass",
    excitement: 3,
    clock: "0:00",
    quarter: "Q1",
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
  it("returns the fallback text when no API key is configured", async () => {
    expect(await new GeminiCommentaryProvider(undefined).draft(input)).toBe(input.fallbackText);
  });

  it("posts to generateContent with the systemInstruction and contents", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const provider = new GeminiCommentaryProvider("test-key", "gemini-1.5-pro", async (url, init) => {
      captured.url = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      captured.init = init;
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "Theo here — Mahomes goes deep." }] } }] }),
        { status: 200 }
      );
    });

    const text = await provider.draft(input);
    expect(text).toBe("Theo here — Mahomes goes deep.");
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
