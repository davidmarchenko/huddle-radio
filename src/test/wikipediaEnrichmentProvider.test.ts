import { describe, expect, it, vi } from "vitest";
import { WikipediaProvider } from "../providers/enrichment/wikipediaProvider";
import type { SportsGameState } from "../shared/contracts";

const game: SportsGameState = {
  provider: "espn-scoreboard",
  gameId: "wnba-401856904",
  sport: "wnba",
  awayTeam: "SEA",
  homeTeam: "LV",
  awayMeta: { abbreviation: "SEA", shortName: "Storm", displayName: "Seattle Storm" },
  homeMeta: { abbreviation: "LV", shortName: "Aces", displayName: "Las Vegas Aces" },
  status: "live",
  currentPlay: {
    id: "p1",
    type: "other",
    excitement: 4,
    clock: "5:00",
    quarter: "Q3",
    possession: "LV",
    headline: "Aja Wilson hits a three from the wing",
    description: "Aja Wilson catch-and-shoot three over Skylar Diggins",
    playerIds: ["wilson"],
    team: "LV",
    score: { away: 60, home: 65 },
    occurredAt: new Date().toISOString()
  },
  recentPlays: [],
  updatedAt: new Date().toISOString()
};

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: "OK",
    json: async () => body
  } as unknown as Response;
}

describe("WikipediaProvider", () => {
  it("emits a context signal per team using the team displayName", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("Las_Vegas_Aces")) {
        return jsonResponse({ extract: "The Las Vegas Aces are an American professional basketball team." });
      }
      if (url.includes("Seattle_Storm")) {
        return jsonResponse({ extract: "The Seattle Storm are a WNBA franchise based in Seattle." });
      }
      return jsonResponse({}, { ok: false, status: 404 });
    });
    const provider = new WikipediaProvider({ fetcher: fetcher as unknown as typeof fetch });
    const signals = await provider.gather({ game, deadlineMs: 1000 });
    const teamSignals = signals.filter((s) => s.id.startsWith("wiki-team-"));
    expect(teamSignals).toHaveLength(2);
    expect(teamSignals[0].source).toBe("wiki");
    expect(teamSignals[0].kind).toBe("context");
  });

  it("extracts player names from the play headline and looks them up", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("opensearch") && url.includes("Aja%20Wilson")) {
        return jsonResponse(["Aja Wilson", ["A'ja Wilson"], [], []]);
      }
      if (url.includes("opensearch") && url.includes("Skylar%20Diggins")) {
        return jsonResponse(["Skylar Diggins", ["Skylar Diggins"], [], []]);
      }
      // encodeURIComponent leaves apostrophes alone but encodes
      // spaces as %20; both forms are valid Wikipedia title URLs.
      if (url.includes("A'ja") || url.includes("A%27ja")) {
        return jsonResponse({ extract: "A'ja Wilson is a basketball player for the Las Vegas Aces." });
      }
      if (url.includes("Skylar")) {
        return jsonResponse({ extract: "Skylar Diggins-Smith is a WNBA point guard." });
      }
      // Team summary calls.
      return jsonResponse({}, { ok: false, status: 404 });
    });
    const provider = new WikipediaProvider({ fetcher: fetcher as unknown as typeof fetch });
    const signals = await provider.gather({ game, deadlineMs: 1000 });
    const playerSignals = signals.filter((s) => s.id.startsWith("wiki-player-"));
    expect(playerSignals.length).toBeGreaterThanOrEqual(1);
    expect(playerSignals[0].text).toMatch(/Wilson|Diggins/);
  });

  it("trims the extract to the first sentence and respects the max length", async () => {
    const longExtract =
      "Aja Wilson is a basketball player. She has won multiple MVP awards. She plays for the Aces. " +
      "x".repeat(400);
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("Las_Vegas_Aces")) return jsonResponse({ extract: longExtract });
      return jsonResponse({}, { ok: false, status: 404 });
    });
    const provider = new WikipediaProvider({ fetcher: fetcher as unknown as typeof fetch });
    const signals = await provider.gather({ game, deadlineMs: 1000 });
    const teamSignal = signals.find((s) => s.id.startsWith("wiki-team-"));
    expect(teamSignal!.text).toBe("Aja Wilson is a basketball player.");
  });

  it("ignores Wikipedia disambiguation pages (no useful fact)", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ type: "disambiguation", extract: "Storm may refer to..." })
    );
    const provider = new WikipediaProvider({ fetcher: fetcher as unknown as typeof fetch });
    const signals = await provider.gather({ game, deadlineMs: 1000 });
    expect(signals.filter((s) => s.id.startsWith("wiki-team-"))).toEqual([]);
  });

  it("caches successful summaries (6h for teams, 24h for players)", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("Las_Vegas_Aces") || url.includes("Seattle_Storm")) {
        return jsonResponse({ extract: "team blurb" });
      }
      return jsonResponse({}, { ok: false, status: 404 });
    });
    let now = 1_000_000;
    const provider = new WikipediaProvider({ fetcher: fetcher as unknown as typeof fetch, now: () => now });
    await provider.gather({ game, deadlineMs: 1000 });
    const callCount1 = fetcher.mock.calls.length;
    now += 60 * 60 * 1000; // 1h — within team TTL
    await provider.gather({ game, deadlineMs: 1000 });
    // Team summaries cached → second call shouldn't re-hit them.
    // (Player paths may still fire — assert only on the team URLs.)
    const teamCallsBefore = fetcher.mock.calls
      .slice(0, callCount1)
      .filter(([url]) => String(url).includes("Las_Vegas_Aces") || String(url).includes("Seattle_Storm")).length;
    const teamCallsAfter = fetcher.mock.calls.filter(
      ([url]) => String(url).includes("Las_Vegas_Aces") || String(url).includes("Seattle_Storm")
    ).length;
    expect(teamCallsAfter).toBe(teamCallsBefore);
  });

  it("negative-caches a missed lookup so we don't keep retrying every tick", async () => {
    const fetcher = vi.fn(async () => jsonResponse({}, { ok: false, status: 404 }));
    let now = 1_000_000;
    const provider = new WikipediaProvider({ fetcher: fetcher as unknown as typeof fetch, now: () => now });
    await provider.gather({ game, deadlineMs: 1000 });
    const calls1 = fetcher.mock.calls.length;
    now += 60 * 1000; // 1 min — within negative TTL
    await provider.gather({ game, deadlineMs: 1000 });
    expect(fetcher.mock.calls.length).toBe(calls1);
  });

  it("never throws on fetch errors — returns []", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const provider = new WikipediaProvider({ fetcher: fetcher as unknown as typeof fetch });
    const signals = await provider.gather({ game, deadlineMs: 1000 });
    expect(signals).toEqual([]);
  });

  it("returns [] when the play has no extractable player names + Wikipedia returns nothing for teams", async () => {
    const naked = { ...game, currentPlay: undefined };
    const fetcher = vi.fn(async () => jsonResponse({}, { ok: false, status: 404 }));
    const provider = new WikipediaProvider({ fetcher: fetcher as unknown as typeof fetch });
    const signals = await provider.gather({ game: naked, deadlineMs: 1000 });
    expect(signals).toEqual([]);
  });
});
