import { describe, expect, it } from "vitest";
import { selectHost } from "../shared/hostPersonas";
import type { FantasyImpact, MomentCue, SportsPlay } from "../shared/contracts";

const play = (overrides: Partial<SportsPlay> = {}): SportsPlay => ({
  id: "p1",
  type: "pass",
  excitement: 3,
  clock: "0:00",
  period: { number: 1, kind: "quarter" },
  possession: "KC",
  headline: "x",
  description: "y",
  playerIds: [],
  team: "KC",
  score: { away: 0, home: 0 },
  occurredAt: "2026-05-09T00:00:00Z",
  ...overrides
});

const moment = (priority: MomentCue["priority"]): MomentCue => ({
  priority,
  headline: "h",
  summary: "s",
  reasons: [],
  targetFriendIds: [],
  score: 0
});

const impact = (overrides: Partial<FantasyImpact> = {}): FantasyImpact => ({
  rosterId: "r-listener",
  ownerName: "you",
  teamName: "Your team",
  playerName: "Player",
  isStarter: true,
  pointsDelta: 1,
  reason: "x",
  ...overrides
});

describe("selectHost", () => {
  it("interrupt-priority moment routes to Cam (Wildcard)", () => {
    expect(selectHost({ moment: moment("interrupt"), impacts: [], play: play() })).toBe("cam");
  });

  it("a big absolute fantasy swing (>=6) routes to Maya (Analyst)", () => {
    expect(selectHost({ impacts: [impact({ pointsDelta: 6 })], play: play() })).toBe("maya");
    expect(selectHost({ impacts: [impact({ pointsDelta: -8 })], play: play() })).toBe("maya");
  });

  it("major moment with no impact routes to Maya", () => {
    expect(selectHost({ moment: moment("major"), impacts: [], play: play() })).toBe("maya");
  });

  it("a friend-affecting impact (not 'you') routes to Cam if delta >= 3", () => {
    const friendImpact = impact({ ownerName: "Devon", pointsDelta: 4 });
    expect(selectHost({ impacts: [friendImpact], play: play() })).toBe("cam");
  });

  it("a small friend impact (delta < 3) does NOT route to Cam", () => {
    const friendImpact = impact({ ownerName: "Devon", pointsDelta: 2 });
    // Falls through to type-based + default → Theo for non-touchdown/turnover.
    expect(selectHost({ impacts: [friendImpact], play: play() })).toBe("theo");
  });

  it("touchdown / turnover routes to Theo (Fan)", () => {
    expect(selectHost({ impacts: [], play: play({ type: "touchdown" }) })).toBe("theo");
    expect(selectHost({ impacts: [], play: play({ type: "turnover" }) })).toBe("theo");
  });

  it("default falls through to Theo", () => {
    expect(selectHost({ impacts: [], play: play() })).toBe("theo");
  });

  it("anti-repetition: when last two were the same host, candidate is rerouted", () => {
    // Two Theos in a row + a play that would naturally pick Theo → Maya.
    expect(selectHost({ impacts: [], play: play(), recentHostIds: ["theo", "theo"] })).not.toBe("theo");
  });

  it("anti-repetition only kicks in when the last two are identical", () => {
    // theo,maya pattern shouldn't reroute even if candidate is Theo.
    expect(selectHost({ impacts: [], play: play(), recentHostIds: ["theo", "maya"] })).toBe("theo");
  });

  it("listener (you) impact at low magnitude stays Theo", () => {
    expect(selectHost({ impacts: [impact({ ownerName: "you", pointsDelta: 2 })], play: play() })).toBe("theo");
  });
});
