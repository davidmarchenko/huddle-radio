import { afterEach, describe, expect, it } from "vitest";
import {
  computeEntryStatus,
  getEntry,
  lockEntry,
  resetPicksStore,
  submitEntry
} from "../server/picksStore";
import type { PickProp } from "../shared/picksContracts";
import type { LiveStatsMap } from "../server/picksLiveStats";

afterEach(() => resetPicksStore());

const props: PickProp[] = [
  {
    id: "p1",
    gameId: "nba-1",
    sport: "nba",
    playerName: "Jokic",
    statType: "points",
    line: 28.5,
    source: "polymarket"
  },
  {
    id: "p2",
    gameId: "nba-1",
    sport: "nba",
    playerName: "Murray",
    statType: "assists",
    line: 6.5,
    source: "polymarket"
  }
];

describe("submitEntry", () => {
  it("rejects entries with fewer than the minimum picks", () => {
    const result = submitEntry({
      listenerId: "L",
      gameId: "nba-1",
      selections: [{ propId: "p1", side: "more" }],
      availableProps: props
    });
    expect("error" in result).toBe(true);
  });

  it("rejects unknown propIds", () => {
    const result = submitEntry({
      listenerId: "L",
      gameId: "nba-1",
      selections: [
        { propId: "p1", side: "more" },
        { propId: "ghost", side: "less" }
      ],
      availableProps: props
    });
    expect("error" in result).toBe(true);
  });

  it("stores entries and overwrites on re-submit for same game", () => {
    const first = submitEntry({
      listenerId: "L",
      gameId: "nba-1",
      selections: [{ propId: "p1", side: "more" }, { propId: "p2", side: "less" }],
      availableProps: props
    });
    expect("entry" in first).toBe(true);
    const second = submitEntry({
      listenerId: "L",
      gameId: "nba-1",
      selections: [{ propId: "p1", side: "less" }, { propId: "p2", side: "more" }],
      availableProps: props
    });
    expect("entry" in second).toBe(true);
    const stored = getEntry("L", "nba-1");
    expect(stored?.selections[0]?.side).toBe("less");
  });
});

describe("lockEntry", () => {
  it("flips the entry to live and is idempotent", () => {
    submitEntry({
      listenerId: "L",
      gameId: "nba-1",
      selections: [{ propId: "p1", side: "more" }, { propId: "p2", side: "more" }],
      availableProps: props
    });
    const locked = lockEntry("L", "nba-1");
    expect(locked?.status).toBe("live");
    const lockedAt = locked?.lockedAt;
    const lockedAgain = lockEntry("L", "nba-1");
    expect(lockedAgain?.lockedAt).toBe(lockedAt);
  });
});

describe("computeEntryStatus", () => {
  function setup() {
    const result = submitEntry({
      listenerId: "L",
      gameId: "nba-1",
      selections: [
        { propId: "p1", side: "more" },
        { propId: "p2", side: "more" }
      ],
      availableProps: props
    });
    if ("error" in result) throw new Error(result.error);
    return result.entry;
  }

  it("marks live picks on track when over the line", () => {
    const entry = setup();
    const stats: LiveStatsMap = new Map([
      ["jokic", { points: 30 }],
      ["murray", { assists: 8 }]
    ]);
    const status = computeEntryStatus({ entry, stats, settle: false });
    expect(status.picks.every((p) => p.status === "live-on-track")).toBe(true);
    expect(status.payout).toBe(30); // both on track → projected
  });

  it("settles all-or-nothing", () => {
    const entry = setup();
    const stats: LiveStatsMap = new Map([
      ["jokic", { points: 30 }],
      ["murray", { assists: 5 }] // miss
    ]);
    const status = computeEntryStatus({ entry, stats, settle: true });
    expect(status.payout).toBe(0);
    expect(status.misses).toBe(1);
    expect(status.hits).toBe(1);
  });

  it("computes a hostHint highlighting the bubble pick", () => {
    setup();
    const fresh = lockEntry("L", "nba-1")!;
    const stats: LiveStatsMap = new Map([
      ["jokic", { points: 30 }],
      ["murray", { assists: 5 }] // off track by 1.5
    ]);
    const status = computeEntryStatus({ entry: fresh, stats, settle: false });
    expect(status.hostHint).toBeDefined();
    expect(status.hostHint).toContain("Murray");
    expect(status.hostHint).toContain("more");
  });

  it("treats picks with no live data as pending", () => {
    const entry = setup();
    const status = computeEntryStatus({ entry, stats: new Map(), settle: false });
    expect(status.picks.every((p) => p.status === "pending")).toBe(true);
    expect(status.payout).toBe(0);
  });
});
