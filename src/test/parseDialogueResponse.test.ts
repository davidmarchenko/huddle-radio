import { describe, expect, it } from "vitest";
import {
  detectClosingHandoff,
  joinDialogueLines,
  parseDialogueResponse
} from "../providers/commentaryPrompts";

/**
 * Tests for the post-parse fixups that defend against LLM slips:
 *
 *   1. First turn snaps to the lead host when the model reordered.
 *   2. When turn N ends by addressing another host by name, turn N+1
 *      snaps to that addressed host. (Prompt-level rule is in
 *      commentaryPrompts.ts; this is the belt-and-suspenders layer.)
 */

describe("parseDialogueResponse", () => {
  it("snaps the first turn to the lead host when the model reordered", () => {
    const raw = JSON.stringify({
      turns: [
        { speaker: "cam", text: "Out of order opener." },
        { speaker: "theo", text: "Second beat." }
      ]
    });
    const lines = parseDialogueResponse(raw, "maya");
    expect(lines?.[0].hostId).toBe("maya");
    expect(lines?.[1].hostId).toBe("theo");
  });

  it("snaps the next turn to the host that was addressed by name", () => {
    // Theo addresses Maya at the end of turn 1; the model wrongly
    // assigned turn 2 to Cam. The fixup must reassign turn 2 → Maya.
    const raw = JSON.stringify({
      turns: [
        { speaker: "theo", text: "Maya, matchup math — what's the stress point?" },
        { speaker: "cam", text: "Pregame line talk, huh? Fine — if the Spurs are sitting at minus nine..." }
      ]
    });
    const lines = parseDialogueResponse(raw, "theo");
    expect(lines).toHaveLength(2);
    expect(lines?.[0].hostId).toBe("theo");
    expect(lines?.[1].hostId).toBe("maya");
  });

  it("recognises em-dash and hyphen as address delimiters", () => {
    const raw = JSON.stringify({
      turns: [
        { speaker: "maya", text: "Cam — push back on that take." },
        { speaker: "theo", text: "I think she's wrong." }
      ]
    });
    const lines = parseDialogueResponse(raw, "maya");
    expect(lines?.[1].hostId).toBe("cam");
  });

  it("does not reassign when the addressed name is the speaker themself", () => {
    // "Cam" inside Cam's own turn should not flip the next speaker to Cam.
    const raw = JSON.stringify({
      turns: [
        { speaker: "cam", text: "Cam's take here is simple — they cover the spread." },
        { speaker: "theo", text: "I disagree." }
      ]
    });
    const lines = parseDialogueResponse(raw, "cam");
    expect(lines?.[1].hostId).toBe("theo");
  });

  it("leaves the next host alone when the addressed handoff already matches", () => {
    const raw = JSON.stringify({
      turns: [
        { speaker: "theo", text: "Maya, what do you see?" },
        { speaker: "maya", text: "Through three quarters, the volume is the volume." }
      ]
    });
    const lines = parseDialogueResponse(raw, "theo");
    expect(lines?.[1].hostId).toBe("maya");
  });

  it("keeps the first listener-name use and rewrites subsequent ones to 'you'", () => {
    const raw = JSON.stringify({
      turns: [
        { speaker: "maya", text: "Marc, your roster is up." },
        { speaker: "theo", text: "Marc — look at this play." },
        { speaker: "cam", text: "And Marc, the model already saw it." }
      ]
    });
    const lines = parseDialogueResponse(raw, "maya", "Marc");
    expect(lines?.[0].text).toBe("Marc, your roster is up.");
    expect(lines?.[1].text).toBe("You — look at this play.");
    expect(lines?.[2].text).toBe("And you, the model already saw it.");
  });

  it("preserves possessive forms of the listener name", () => {
    const raw = JSON.stringify({
      turns: [
        { speaker: "maya", text: "Marc's lineup is heavy on receivers." },
        { speaker: "theo", text: "Marc's roster, Marc's call — let's see how it plays." }
      ]
    });
    const lines = parseDialogueResponse(raw, "maya", "Marc");
    // Possessive `Marc's` is preserved everywhere; only a standalone
    // `Marc` would have been replaced. None present here.
    expect(lines?.[0].text).toBe("Marc's lineup is heavy on receivers.");
    expect(lines?.[1].text).toBe("Marc's roster, Marc's call — let's see how it plays.");
  });

  it("is a no-op when listenerName is empty (non-demo, no profile)", () => {
    const raw = JSON.stringify({
      turns: [
        { speaker: "maya", text: "Listener, your roster is up." },
        { speaker: "theo", text: "Listener, look at this." }
      ]
    });
    const lines = parseDialogueResponse(raw, "maya", "");
    expect(lines?.[1].text).toBe("Listener, look at this.");
  });

  it("strips audio tags when joining for transcript/clip surfaces", () => {
    const raw = JSON.stringify({
      turns: [
        { speaker: "maya", text: "[deadpan] Sure." },
        { speaker: "theo", text: "[laughs softly] You and your model, Maya." }
      ]
    });
    const lines = parseDialogueResponse(raw, "maya");
    expect(lines).toBeDefined();
    const joined = joinDialogueLines(lines!);
    expect(joined).not.toMatch(/\[/);
    expect(joined).toBe("Sure. You and your model, Maya.");
  });

  it("detectClosingHandoff returns the addressed host on the LAST turn only", () => {
    // Theo's final turn ends by handing the floor to Maya. The next
    // commentary block's lead host should be forced to Maya.
    const lines = [
      { hostId: "maya" as const, text: "One number: zero." },
      { hostId: "cam" as const, text: "A reliability portfolio, Maya? That's a retirement seminar." },
      {
        hostId: "theo" as const,
        text:
          "Pregame on Wolves at Spurs — for your fantasy night, that's pace versus patience. Maya, math it up without turning it into a retirement seminar."
      }
    ];
    expect(detectClosingHandoff(lines)).toBe("maya");
  });

  it("detectClosingHandoff returns undefined when the last turn ends generically", () => {
    const lines = [
      { hostId: "theo" as const, text: "It's gonna be a fun one." }
    ];
    expect(detectClosingHandoff(lines)).toBeUndefined();
  });

  it("detectClosingHandoff ignores self-references in the closer", () => {
    const lines = [
      { hostId: "cam" as const, text: "Cam's call: Spurs by twelve." }
    ];
    expect(detectClosingHandoff(lines)).toBeUndefined();
  });

  it("does not snap on mid-sentence mentions far from the end", () => {
    // "Cam" appears mid-turn (not in the trailing address window). The
    // next host should not flip to Cam — this is a callback, not a
    // handoff.
    const raw = JSON.stringify({
      turns: [
        { speaker: "theo", text: "Cam was right last week about this matchup, and the model agrees again tonight — through three quarters it's the same shape, exact same shape, and the listener's roster is built to ride that wave from start to finish." },
        { speaker: "maya", text: "Sure." }
      ]
    });
    const lines = parseDialogueResponse(raw, "theo");
    expect(lines?.[1].hostId).toBe("maya");
  });
});
