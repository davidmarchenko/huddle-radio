import { describe, expect, it } from "vitest";
import { AnthropicCommentaryProvider } from "../providers/anthropicCommentaryProvider";
import type { CommentaryDraftInput } from "../providers/commentaryPrompts";

const input: CommentaryDraftInput = {
  play: {
    id: "p1",
    type: "pass",
    excitement: 3,
    clock: "0:00",
    quarter: "Q1",
    possession: "KC",
    headline: "Mahomes connects with Kelce",
    description: "Mahomes pass complete to Kelce.",
    playerIds: ["4046", "1466"],
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
  hostId: "maya"
};

describe("AnthropicCommentaryProvider", () => {
  it("returns the fallback wrapped as a single dialogue line when no API key is configured", async () => {
    const provider = new AnthropicCommentaryProvider(undefined);
    const lines = await provider.draft(input);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe(input.fallbackText);
  });

  it("posts to the Messages API and parses the JSON dialogue response", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const dialogueJson = JSON.stringify({
      lines: [
        { speaker: "maya", text: "Mahomes is at 9.4 yards an attempt." },
        { speaker: "theo", text: "Right, exactly the script Alex needed." }
      ]
    });
    const provider = new AnthropicCommentaryProvider("test-key", "claude-sonnet-4-6", async (url, init) => {
      captured.url = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      captured.init = init;
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: dialogueJson }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const lines = await provider.draft(input);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ hostId: "maya", text: "Mahomes is at 9.4 yards an attempt." });
    expect(lines[1]).toMatchObject({ hostId: "theo" });
    expect(captured.url).toBe("https://api.anthropic.com/v1/messages");
    expect((captured.init?.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    const body = JSON.parse(String(captured.init?.body));
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.system).toContain("Huddle Radio");
    expect(body.messages[0].role).toBe("user");
    // Payload contains the listener name to prove buildCommentaryPayload was used.
    expect(body.messages[0].content).toContain("Alex");
  });

  it("throws on a non-200 response so the chain can fall through", async () => {
    const provider = new AnthropicCommentaryProvider("test-key", "claude-sonnet-4-6", async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" })
    );

    await expect(provider.draft(input)).rejects.toThrow(/Anthropic commentary request failed: 429/);
  });

  it("scrubs dialogue that leaks credentials and falls back to a safe single line", async () => {
    const dialogueJson = JSON.stringify({
      lines: [{ speaker: "maya", text: "your api key is sk-foo" }]
    });
    const provider = new AnthropicCommentaryProvider("test-key", "claude-sonnet-4-6", async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: dialogueJson }] }), { status: 200 })
    );
    const lines = await provider.draft(input);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe(input.fallbackText);
  });

  it("reports ready when keyed and disabled when not", async () => {
    expect((await new AnthropicCommentaryProvider(undefined).health()).status).toBe("disabled");
    expect((await new AnthropicCommentaryProvider("k").health()).status).toBe("ready");
  });
});
