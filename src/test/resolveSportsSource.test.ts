import { describe, expect, it } from "vitest";
import {
  createSportsDataProvider,
  deriveSportsLabelMode,
  resolveSportsSource
} from "../server/showFactories";

/**
 * resolveSportsSource is the single source of truth for which sports
 * backend a gameId routes to. The previous design carried a separate
 * `sportsDataMode` request field that could disagree with the gameId —
 * when it disagreed, the demo provider silently substituted KC@DET and
 * the wrong play-by-play leaked into real-game shows. These tests pin
 * the new contract so that regression can't reintroduce itself.
 */
describe("resolveSportsSource", () => {
  it("treats undefined / empty gameId as the bundled demo default", () => {
    expect(resolveSportsSource(undefined).kind).toBe("demo");
    expect(resolveSportsSource("").kind).toBe("demo");
  });

  it("routes a sport-prefixed id to ESPN with the right sport path and event id", () => {
    const result = resolveSportsSource("nba-401741234");
    expect(result.kind).toBe("espn");
    if (result.kind !== "espn") throw new Error("expected espn");
    expect(result.sportPath.sport).toBe("nba");
    expect(result.eventId).toBe("401741234");
  });

  it("routes 'demo-' ids to the demo provider with the full key preserved", () => {
    const result = resolveSportsSource("demo-bos-dal");
    expect(result.kind).toBe("demo");
    if (result.kind !== "demo") throw new Error("expected demo");
    expect(result.gameId).toBe("demo-bos-dal");
  });

  it("routes 'sportradar:' prefix to the paid Sportradar feed", () => {
    const result = resolveSportsSource("sportradar:abc-123");
    expect(result.kind).toBe("sportradar");
    if (result.kind !== "sportradar") throw new Error("expected sportradar");
    expect(result.gameId).toBe("abc-123");
  });

  it("flags an unrecognized prefix as 'unknown' instead of guessing", () => {
    const result = resolveSportsSource("never-heard-of-it");
    expect(result.kind).toBe("unknown");
  });
});

describe("createSportsDataProvider", () => {
  it("returns the demo provider for a known demo id", () => {
    const provider = createSportsDataProvider("demo-bos-dal");
    expect(provider.id).toBe("demo-sports-data");
  });

  it("returns the ESPN provider for a sport-prefixed id", () => {
    const provider = createSportsDataProvider("nba-401741234");
    expect(provider.id).toBe("espn-scoreboard");
  });

  it("returns the demo provider for an empty/undefined id", () => {
    expect(createSportsDataProvider().id).toBe("demo-sports-data");
    expect(createSportsDataProvider("").id).toBe("demo-sports-data");
  });

  it("throws on an unrecognized gameId instead of falling back to KC@DET", () => {
    expect(() => createSportsDataProvider("never-heard-of-it")).toThrow(/Unrecognized sportsGameId/);
  });
});

describe("deriveSportsLabelMode", () => {
  it("labels demo-prefixed ids as 'demo'", () => {
    expect(deriveSportsLabelMode("demo-kc-det")).toBe("demo");
  });

  it("labels sport-prefixed ids as 'espn'", () => {
    expect(deriveSportsLabelMode("nfl-401547439")).toBe("espn");
    expect(deriveSportsLabelMode("nba-401741234")).toBe("espn");
  });

  it("labels paid-feed prefixes as 'espn' (closest live-feed bucket)", () => {
    expect(deriveSportsLabelMode("sportradar:abc")).toBe("espn");
    expect(deriveSportsLabelMode("sportsdataio:xyz")).toBe("espn");
  });

  it("labels empty/unknown ids as 'demo' (safest default for the producer label)", () => {
    expect(deriveSportsLabelMode(undefined)).toBe("demo");
    expect(deriveSportsLabelMode("never-heard-of-it")).toBe("demo");
  });
});
