import { describe, expect, it } from "vitest";
import { RapportTracker } from "../server/rapport/tracker";
import type { DialogueLine } from "../shared/contracts";

function dialogue(lines: Array<[string, string]>): DialogueLine[] {
  return lines.map(([hostId, text]) => ({ hostId: hostId as DialogueLine["hostId"], text }));
}

describe("RapportTracker", () => {
  it("starts with empty state — no threads, no bits, all hosts equally quiet", () => {
    const t = new RapportTracker();
    const s = t.state();
    expect(s.openThreads).toEqual([]);
    expect(s.runningBits).toEqual([]);
    expect(s.ticksDelivered).toBe(0);
    expect(s.hostStanding.maya.ticksSinceLastSpoke).toBe(0);
  });

  it("increments ticksSinceLastSpoke for hosts who didn't speak", () => {
    const t = new RapportTracker();
    t.update({
      turnId: "t1",
      leadHostId: "theo",
      dialogue: dialogue([["theo", "test text here long enough"]]),
      shippedAt: new Date().toISOString()
    });
    const s = t.state();
    expect(s.hostStanding.theo.ticksSinceLastSpoke).toBe(0);
    expect(s.hostStanding.maya.ticksSinceLastSpoke).toBe(1);
    expect(s.hostStanding.cam.ticksSinceLastSpoke).toBe(1);
  });

  it("tracks recentLeads (most-recent first, capped at 5)", () => {
    const t = new RapportTracker();
    for (let i = 0; i < 7; i += 1) {
      t.update({
        turnId: `t${i}`,
        leadHostId: "theo",
        dialogue: dialogue([["theo", `text ${i} reasonably long`]]),
        shippedAt: new Date().toISOString()
      });
    }
    const s = t.state();
    expect(s.hostStanding.theo.recentLeads).toEqual(["t6", "t5", "t4", "t3", "t2"]);
  });

  it("introduces new threads from extracted claims", () => {
    const t = new RapportTracker();
    t.update({
      turnId: "t1",
      leadHostId: "cam",
      dialogue: dialogue([["cam", "Wilson goes for 30 tonight"]]),
      shippedAt: new Date().toISOString(),
      newThreads: [{ id: "claim-1", text: "Wilson goes for 30", hostId: "cam" }]
    });
    const s = t.state();
    expect(s.openThreads).toHaveLength(1);
    expect(s.openThreads[0].acknowledged).toBe(false);
    expect(s.openThreads[0].hostId).toBe("cam");
  });

  it("dedupes threads by id across multiple updates", () => {
    const t = new RapportTracker();
    for (let i = 0; i < 3; i += 1) {
      t.update({
        turnId: `t${i}`,
        leadHostId: "cam",
        dialogue: dialogue([["cam", "fresh text"]]),
        shippedAt: new Date().toISOString(),
        newThreads: [{ id: "same-id", text: "Wilson goes for 30", hostId: "cam" }]
      });
    }
    expect(t.state().openThreads).toHaveLength(1);
  });

  it("marks a thread acknowledged when another host name-references the owner", () => {
    const t = new RapportTracker();
    t.update({
      turnId: "t1",
      leadHostId: "cam",
      dialogue: dialogue([["cam", "Wilson goes for 30 tonight"]]),
      shippedAt: new Date().toISOString(),
      newThreads: [{ id: "c1", text: "Wilson goes for 30", hostId: "cam" }]
    });
    expect(t.state().openThreads[0].acknowledged).toBe(false);

    t.update({
      turnId: "t2",
      leadHostId: "maya",
      dialogue: dialogue([["maya", "yeah no cam, the take stands tonight"]]),
      shippedAt: new Date().toISOString()
    });
    expect(t.state().openThreads[0].acknowledged).toBe(true);
  });

  it("detects running bits (phrases that recur across turns)", () => {
    const t = new RapportTracker();
    t.update({
      turnId: "t1",
      leadHostId: "maya",
      dialogue: dialogue([["maya", "Wilson three pointer from deep tonight"]]),
      shippedAt: new Date().toISOString()
    });
    t.update({
      turnId: "t2",
      leadHostId: "cam",
      dialogue: dialogue([["cam", "another Wilson three pointer she keeps hitting"]]),
      shippedAt: new Date().toISOString()
    });
    const bits = t.state().runningBits;
    // "wilson three" or "three pointer" should have surfaced.
    expect(bits.length).toBeGreaterThan(0);
    expect(bits[0].occurrences).toBeGreaterThanOrEqual(2);
  });

  it("computes tonal energy from audio markers + cadence", () => {
    const t = new RapportTracker();
    t.update({
      turnId: "t1",
      leadHostId: "cam",
      dialogue: dialogue([
        ["cam", "WHAT A SHOT — [laughs] she's locked in!"],
        ["maya", "[chuckles] yeah no — she really is."]
      ]),
      shippedAt: new Date().toISOString()
    });
    expect(t.state().tonal.energy).toBeGreaterThan(5);

    const flat = new RapportTracker();
    flat.update({
      turnId: "t1",
      leadHostId: "maya",
      dialogue: dialogue([
        ["maya", "Through three quarters Wilson has the volume on the season she usually does."]
      ]),
      shippedAt: new Date().toISOString()
    });
    expect(flat.state().tonal.energy).toBeLessThan(5);
  });

  it("records lastLaughTurnId when a laugh tag fires", () => {
    const t = new RapportTracker();
    t.update({
      turnId: "t1",
      leadHostId: "cam",
      dialogue: dialogue([["cam", "[laughs] yeah no, that play was something else."]]),
      shippedAt: new Date().toISOString()
    });
    expect(t.state().tonal.lastLaughTurnId).toBe("t1");
  });

  it("updates lastResolvedOutcome from resolver feedback", () => {
    const t = new RapportTracker();
    t.update({
      turnId: "t1",
      leadHostId: "cam",
      dialogue: dialogue([["cam", "test"]]),
      shippedAt: new Date().toISOString(),
      resolvedOutcomes: [{ hostId: "cam", outcome: "right" }]
    });
    expect(t.state().hostStanding.cam.lastResolvedOutcome).toBe("right");
  });

  it("state() returns a clone — external mutation doesn't poison the tracker", () => {
    const t = new RapportTracker();
    t.update({
      turnId: "t1",
      leadHostId: "cam",
      dialogue: dialogue([["cam", "test text"]]),
      shippedAt: new Date().toISOString(),
      newThreads: [{ id: "c1", text: "test claim", hostId: "cam" }]
    });
    const s1 = t.state();
    s1.openThreads.push({
      id: "outside",
      text: "external mutation",
      hostId: "maya",
      introducedTurnId: "x",
      introducedAt: "x",
      acknowledged: false
    });
    const s2 = t.state();
    expect(s2.openThreads).toHaveLength(1);
  });
});
