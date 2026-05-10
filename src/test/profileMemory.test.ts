import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyProfileToGroup,
  buildPriorContext,
  formatRelativeTime,
  sportNounForContext,
  type ShowHistoryEntry,
  type UserProfile
} from "../client/profileMemory";
import { demoLeagueState, demoNbaLeagueState } from "../providers/demoData";
import type { GroupSettings } from "../shared/contracts";

const baseGroup: GroupSettings = {
  listener: { name: "Alex" },
  tone: "pg",
  homeTeamBias: "fantasy-first",
  friends: [{ id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex" }]
};

describe("applyProfileToGroup", () => {
  it("returns the group untouched when no profile is provided", () => {
    expect(applyProfileToGroup(baseGroup, undefined, [demoLeagueState], "nfl")).toBe(baseGroup);
  });

  it("prefers a per-sport LeagueClaim over the legacy single rosterId", () => {
    const profile: UserProfile = {
      name: "Alex",
      rosterId: "roster-alex", // NFL
      leagues: [
        { sport: "nba", provider: "demo", leagueId: "demo-nba-league", rosterId: "roster-alex-nba", teamName: "Crossover Kings" }
      ]
    };
    const result = applyProfileToGroup(baseGroup, profile, [demoLeagueState, demoNbaLeagueState], "nba");
    expect(result.listener.rosterId).toBe("roster-alex-nba");
  });

  it("falls back to the legacy single rosterId when no per-sport claim exists", () => {
    const profile: UserProfile = { name: "Alex", rosterId: "roster-alex" };
    const result = applyProfileToGroup(baseGroup, profile, [demoLeagueState], "nfl");
    expect(result.listener.rosterId).toBe("roster-alex");
  });

  it("auto-matches by ownerName when no rosterId is set on the profile", () => {
    const profile: UserProfile = { name: "Alex" };
    const result = applyProfileToGroup(baseGroup, profile, [demoLeagueState], "nfl");
    expect(result.listener.rosterId).toBe("roster-alex"); // owned by "Alex" in demo NFL league
  });

  it("ownerName auto-match is case-insensitive", () => {
    const profile: UserProfile = { name: "ALEX" };
    const result = applyProfileToGroup(baseGroup, profile, [demoLeagueState], "nfl");
    expect(result.listener.rosterId).toBe("roster-alex");
  });

  it("leaves rosterId undefined when no league exists for the requested sport", () => {
    const profile: UserProfile = { name: "Alex" };
    const result = applyProfileToGroup(baseGroup, profile, [demoLeagueState], "nba");
    expect(result.listener.rosterId).toBeUndefined();
  });

  it("preserves favoriteTeam from profile, falling back to existing group listener", () => {
    const profile: UserProfile = { name: "Alex", favoriteTeam: "KC" };
    const result = applyProfileToGroup(baseGroup, profile, [demoLeagueState], "nfl");
    expect(result.listener.favoriteTeam).toBe("KC");

    const noFavoriteProfile: UserProfile = { name: "Alex" };
    const groupWithFavorite: GroupSettings = {
      ...baseGroup,
      listener: { ...baseGroup.listener, favoriteTeam: "DET" }
    };
    const result2 = applyProfileToGroup(groupWithFavorite, noFavoriteProfile, [demoLeagueState], "nfl");
    expect(result2.listener.favoriteTeam).toBe("DET");
  });

  it("uses the first league when no sport is specified", () => {
    const profile: UserProfile = { name: "Alex" };
    const result = applyProfileToGroup(baseGroup, profile, [demoLeagueState, demoNbaLeagueState], undefined);
    expect(result.listener.rosterId).toBe("roster-alex"); // demoLeagueState (NFL) is first
  });
});

describe("sportNounForContext", () => {
  it.each([
    ["nfl", "NFL"],
    ["nba", "NBA"],
    ["wnba", "WNBA"],
    ["mlb", "MLB"],
    ["nhl", "NHL"],
    ["ncaaf", "college football"],
    ["ncaab", "college basketball"],
    ["soccer", "soccer"],
    ["other", "fantasy"]
  ] as const)("maps %s → %s", (sport, expected) => {
    expect(sportNounForContext(sport)).toBe(expected);
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for sub-minute deltas", () => {
    expect(formatRelativeTime(new Date("2026-05-09T11:59:30Z").toISOString())).toBe("just now");
  });

  it("formats minutes within the hour", () => {
    expect(formatRelativeTime(new Date("2026-05-09T11:45:00Z").toISOString())).toBe("15m ago");
  });

  it("formats hours within the day", () => {
    expect(formatRelativeTime(new Date("2026-05-09T09:00:00Z").toISOString())).toBe("3h ago");
  });

  it("formats days within the week", () => {
    expect(formatRelativeTime(new Date("2026-05-06T12:00:00Z").toISOString())).toBe("3d ago");
  });

  it("falls back to a date string beyond a week", () => {
    const result = formatRelativeTime(new Date("2026-04-01T12:00:00Z").toISOString());
    expect(result).toMatch(/Apr/);
  });

  it("returns empty string for invalid input rather than throwing", () => {
    // @ts-expect-error — deliberately bad
    expect(() => formatRelativeTime(undefined)).not.toThrow();
  });
});

describe("buildPriorContext", () => {
  const nflShow: ShowHistoryEntry = {
    id: "h1",
    startedAt: "2026-05-08T20:00:00Z",
    endedAt: "2026-05-08T22:00:00Z",
    sport: "nfl",
    gameId: "demo-kc-det",
    gameLabel: "KC vs DET",
    listenerName: "Alex",
    listenerTeamName: "Fourth & Snack",
    topMoment: { playerName: "Mahomes", pointsDelta: 12.3, hostText: "what a throw" },
    totalCommentary: 8
  };

  const nbaShow: ShowHistoryEntry = {
    id: "h2",
    startedAt: "2026-05-09T00:00:00Z",
    endedAt: "2026-05-09T02:00:00Z",
    sport: "nba",
    gameId: "demo-den-okc",
    gameLabel: "DEN vs OKC",
    listenerName: "Alex",
    topMoment: { playerName: "Jokić", pointsDelta: -3.5, hostText: "rough trip" },
    totalCommentary: 5
  };

  const otherListenerShow: ShowHistoryEntry = {
    ...nflShow,
    id: "h3",
    listenerName: "Sam",
    topMoment: { playerName: "Allen", pointsDelta: 6, hostText: "smooth" }
  };

  it("returns undefined when history is empty", () => {
    expect(buildPriorContext([], "nfl", "Alex")).toBeUndefined();
  });

  it("prefers a same-sport same-listener entry", () => {
    const result = buildPriorContext([nbaShow, nflShow], "nfl", "Alex");
    expect(result).toMatch(/KC vs DET/);
    expect(result).toMatch(/Mahomes/);
    expect(result).toMatch(/NFL/);
  });

  it("falls back to a same-listener entry across sports when no sport match exists", () => {
    const result = buildPriorContext([nbaShow], "nfl", "Alex");
    expect(result).toMatch(/DEN vs OKC/);
    expect(result).toMatch(/NBA/);
  });

  it("falls back to the most recent entry when no listener match exists", () => {
    const result = buildPriorContext([otherListenerShow], "nfl", "Alex");
    expect(result).toMatch(/KC vs DET/); // it's the only entry and it gets used
  });

  it("includes a moment snippet when topMoment is present", () => {
    const result = buildPriorContext([nflShow], "nfl", "Alex");
    expect(result).toMatch(/Mahomes went \+12\.3/);
  });

  it("falls back to a 'quiet on their roster' line when topMoment is missing", () => {
    const quietShow: ShowHistoryEntry = { ...nflShow, topMoment: undefined };
    const result = buildPriorContext([quietShow], "nfl", "Alex");
    expect(result).toMatch(/quiet on their roster/);
  });

  it("formats negative deltas without a leading plus sign", () => {
    const result = buildPriorContext([nbaShow], "nba", "Alex");
    expect(result).toMatch(/Jokić went -3\.5/);
  });
});
