import { describe, expect, it } from "vitest";
import { normalizeDeliveryTags, stripDeliveryTags } from "../providers/commentaryPrompts";

/**
 * Pins delivery-tag normalization. Inworld TTS-2 only reliably
 * interprets steering tags ([deadpan], [skeptical]) when they LEAD
 * the utterance — mid-sentence tags get spoken aloud literally. We
 * hoist all tags to the front, combine them, dedupe, and preserve
 * the rest of the text. Stat brackets like [Q2], [+2.1], [22%] are
 * NOT tags and must pass through untouched.
 */
describe("normalizeDeliveryTags", () => {
  // --- HOIST MID-SENTENCE TAGS TO FRONT --------------------------
  it("hoists a mid-sentence tag to the front", () => {
    expect(normalizeDeliveryTags("Six targets [deadpan] through three quarters.")).toBe(
      "[deadpan] Six targets through three quarters."
    );
  });

  it("hoists a trailing tag to the front", () => {
    expect(normalizeDeliveryTags("Through three. [exhales]")).toBe("[exhales] Through three.");
  });

  it("combines multiple tags into one bracket, preserving first-seen order", () => {
    expect(normalizeDeliveryTags("[deadpan] [skeptical] Wait, what?")).toBe(
      "[deadpan, skeptical] Wait, what?"
    );
  });

  it("dedupes repeated tags (case-insensitive)", () => {
    expect(normalizeDeliveryTags("[deadpan] Yeah. [Deadpan] no.")).toBe("[deadpan] Yeah. no.");
  });

  it("preserves multi-word tag content", () => {
    expect(normalizeDeliveryTags("Theo, [chuckles softly] you're gonna let him?")).toBe(
      "[chuckles softly] Theo, you're gonna let him?"
    );
  });

  it("handles a comma-grouped tag without breaking it apart", () => {
    expect(normalizeDeliveryTags("Wait. [deadpan, slow] What was that?")).toBe(
      "[deadpan, slow] Wait. What was that?"
    );
  });

  // --- NO-OP CASES -----------------------------------------------
  it("returns text verbatim when no tags present", () => {
    const text = "Just a clean line with no brackets.";
    expect(normalizeDeliveryTags(text)).toBe(text);
  });

  it("ignores stat brackets like [Q2]", () => {
    const text = "Through [Q2] he's at 18%.";
    expect(normalizeDeliveryTags(text)).toBe(text);
  });

  it("ignores number brackets like [+2.1] and [22%]", () => {
    expect(normalizeDeliveryTags("Marc lit up [+2.1] tonight.")).toBe(
      "Marc lit up [+2.1] tonight."
    );
    expect(normalizeDeliveryTags("Target share is at [22%].")).toBe("Target share is at [22%].");
  });

  // --- ALREADY-AT-FRONT PASSES THROUGH ---------------------------
  it("leaves a single front-tag in place", () => {
    expect(normalizeDeliveryTags("[deadpan] Six targets. Through three quarters.")).toBe(
      "[deadpan] Six targets. Through three quarters."
    );
  });
});

describe("stripDeliveryTags", () => {
  it("removes all tags + collapses whitespace", () => {
    expect(stripDeliveryTags("[deadpan] Six targets [exhales] tonight.")).toBe(
      "Six targets tonight."
    );
  });

  it("preserves text that has no tags", () => {
    expect(stripDeliveryTags("Plain text.")).toBe("Plain text.");
  });

  it("preserves stat brackets", () => {
    expect(stripDeliveryTags("Through [Q2] he's hot.")).toBe("Through [Q2] he's hot.");
  });
});
