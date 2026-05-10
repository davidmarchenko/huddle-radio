import { describe, expect, it } from "vitest";
import { buildApp, parseLivecastRequest, parseSocketMessage, redactSecret } from "../server/app";

describe("parseLivecastRequest", () => {
  it("defaults a minimal demo request into a valid livecast request", () => {
    const result = parseLivecastRequest(JSON.stringify({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.providerMode).toBe("demo");
    expect(result.request.video.mode).toBe("stream-url");
    expect(result.request.cadenceMs).toBe(5000);
    expect(result.request.ttsEnabled).toBe(true);
  });

  it("rejects Sleeper mode without a league id", () => {
    const result = parseLivecastRequest(JSON.stringify({ providerMode: "sleeper" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Sleeper mode needs a league ID");
  });

  it("rejects ESPN mode without a league id", () => {
    const result = parseLivecastRequest(JSON.stringify({ providerMode: "espn" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("ESPN mode needs a league ID");
  });

  it("accepts ESPN mode with league id and season", () => {
    const result = parseLivecastRequest(JSON.stringify({ providerMode: "espn", espnLeagueId: "123", espnSeason: 2026, week: 7, sportsGameId: "401" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.espnLeagueId).toBe("123");
    expect(result.request.espnSeason).toBe(2026);
    expect(result.request.sportsGameId).toBe("401");
  });

  it("rejects cadence values outside the supported latency range", () => {
    const result = parseLivecastRequest(JSON.stringify({ cadenceMs: 100 }));
    expect(result.ok).toBe(false);
  });

  it("rejects malformed video URLs", () => {
    const result = parseLivecastRequest(JSON.stringify({ video: { mode: "vod", url: "not-a-url" } }));
    expect(result.ok).toBe(false);
  });

  it("accepts a custom demo league payload", () => {
    const result = parseLivecastRequest(
      JSON.stringify({
        customLeague: {
          provider: "custom-demo",
          leagueId: "custom",
          leagueName: "Custom League",
          sport: "nfl",
          season: "2026",
          scoringSummary: "test",
          updatedAt: new Date().toISOString(),
          matchups: [{ id: "m1", week: 1, rosters: [] }]
        }
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.customLeague?.leagueName).toBe("Custom League");
  });

  it("redacts common API key shapes in error messages", () => {
    expect(redactSecret("failed sk-proj-abcdef_1234567890SECRET and abcdefabcdefabcdefabcdefabcdef:abcdefabcdefabcdefabcdefabcdef")).not.toMatch(/SECRET|abcdefabcdef/);
  });
});

describe("parseSocketMessage", () => {
  it("recognizes a frame message", () => {
    const frame = {
      id: "f1",
      capturedAt: new Date().toISOString(),
      source: "stream-url",
      width: 640,
      height: 360,
      dataUrl: "data:image/png;base64,xxx"
    };
    const result = parseSocketMessage(JSON.stringify({ type: "frame", frame }));
    expect(result.type).toBe("frame");
    if (result.type === "frame") expect(result.frame.id).toBe("f1");
  });

  it("recognizes a nudge for a valid host", () => {
    const result = parseSocketMessage(JSON.stringify({ type: "nudge", hostId: "cam" }));
    expect(result.type).toBe("nudge");
    if (result.type === "nudge") expect(result.hostId).toBe("cam");
  });

  it("falls back to start when nudge specifies an invalid hostId", () => {
    // Unknown host shouldn't be treated as a nudge — falls through to
    // the legacy "start" path, where the request schema then rejects
    // the bad payload at the LivecastRequest layer.
    const result = parseSocketMessage(JSON.stringify({ type: "nudge", hostId: "rogue" }));
    expect(result.type).toBe("start");
  });

  it("recognizes a wrapped start message", () => {
    const result = parseSocketMessage(JSON.stringify({ type: "start", request: { providerMode: "demo" } }));
    expect(result.type).toBe("start");
    if (result.type === "start") expect(result.rawRequest).toContain("\"providerMode\":\"demo\"");
  });

  it("treats unwrapped legacy payloads as start", () => {
    // Legacy clients send the request directly — parseLivecastRequest
    // handles validation downstream.
    const raw = JSON.stringify({ providerMode: "demo" });
    const result = parseSocketMessage(raw);
    expect(result.type).toBe("start");
    if (result.type === "start") expect(result.rawRequest).toBe(raw);
  });
});

describe("Fastify app endpoints", () => {
  it("returns demo bootstrap data with health providers", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/bootstrap" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.fantasy.leagueName).toBe("Sunday Group Chat Championship");
    expect(payload.game.awayTeam).toBe("KC");
    expect(payload.health.some((item: { id: string }) => item.id === "mock-model")).toBe(true);
    expect(payload.providers.commentary).toBeTruthy();
  });

  it("returns aggregate provider health", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.ok).toBe(true);
    expect(payload.health.length).toBeGreaterThanOrEqual(6);
    expect(payload.providers.tts).toBeTruthy();
  });

  it("returns a fantasy import preview with readiness checks", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/fantasy/preview?providerMode=demo&week=7" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.ok).toBe(true);
    expect(payload.summary.rosterCount).toBeGreaterThan(0);
    expect(payload.readiness.some((item: { id: string }) => item.id === "players")).toBe(true);
  });

  it("returns provider diagnostics", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/diagnostics" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.checks.some((item: { id: string }) => item.id === "media-cache")).toBe(true);
    expect(payload.providers.sportsData).toBeTruthy();
  });

  it("returns game options for the selected sports data source", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/sports/games?sportsDataMode=demo" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.games[0].id).toBe("demo-kc-det");
    expect(payload.games[0].status).toBe("demo");
    // Demo mode never errors per-sport, so failedSports is always empty.
    expect(payload.failedSports).toEqual([]);
  });

  it("returns sport-aware storylines from /api/news/storylines", async () => {
    const app = await buildApp();
    const nfl = await app.inject({ method: "GET", url: "/api/news/storylines?sport=nfl&teams=KC,DET" });
    const nba = await app.inject({ method: "GET", url: "/api/news/storylines?sport=nba&teams=DEN,OKC" });
    await app.close();

    expect(nfl.statusCode).toBe(200);
    expect(nba.statusCode).toBe(200);
    const nflPayload = nfl.json() as { news: Array<{ title: string }> };
    const nbaPayload = nba.json() as { news: Array<{ title: string }> };
    expect(nflPayload.news.length).toBeGreaterThan(0);
    expect(nbaPayload.news.length).toBeGreaterThan(0);
    // Sport-specific copy ensures we're not just returning the same
    // generic placeholder for every sport.
    expect(nflPayload.news.map((n) => n.title)).not.toEqual(nbaPayload.news.map((n) => n.title));
  });

  it("returns the active SOTA model stack", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/model-stack" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.preset).toBeTruthy();
    expect(payload.commentary.model).toBeTruthy();
    expect(payload.tts.model).toBeTruthy();
  });

  it("rejects invalid manual frame validation payloads", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/api/video/validate-frame", payload: {} });
    await app.close();

    expect(response.statusCode).toBe(400);
  });
});
