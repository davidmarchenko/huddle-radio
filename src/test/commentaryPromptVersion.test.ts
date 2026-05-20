import { describe, expect, it } from "vitest";
import { getCommentaryPromptVersion } from "../providers/commentaryPrompts";

/**
 * Pins the prompt-version contract:
 *
 *   1. Stable across repeated calls in the same process (memoized).
 *   2. 12-hex-char short SHA shape — readable like a short git SHA in
 *      eval reports, no leading "0x", lowercase only.
 *   3. Not the trivially-empty hash (catches "we accidentally hashed
 *      an empty string" regressions if a prompt builder gets removed).
 *
 * What we INTENTIONALLY don't test: that the hash is a specific value.
 * Pinning the exact hash would couple this file to every prompt edit
 * downstream — defeating the point of the version tag (which is to
 * CHANGE on every edit). The behavioral contract is shape + stability,
 * not a fixed digest.
 */
describe("getCommentaryPromptVersion", () => {
  it("returns the same value on repeated calls (memoized)", () => {
    const a = getCommentaryPromptVersion();
    const b = getCommentaryPromptVersion();
    expect(a).toBe(b);
  });

  it("returns a 12-char lowercase hex string", () => {
    const version = getCommentaryPromptVersion();
    expect(version).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is not the empty-string FNV-1a digest", () => {
    // FNV-1a of empty input is 0xcbf29ce484222325 (first 12 chars
    // "cbf29ce48422"). Anything matching that means we wired the hash
    // helper to nothing — a real prompt-builder regression we want to
    // catch.
    const version = getCommentaryPromptVersion();
    expect(version).not.toBe("cbf29ce48422");
  });
});
