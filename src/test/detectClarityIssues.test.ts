import { describe, expect, it } from "vitest";
import { detectClarityIssues } from "../providers/commentaryPrompts";
import type { DialogueLine } from "../shared/contracts";

/**
 * Pins the heuristic that decides whether a turn needs a clarity
 * retry. False positives are expensive (every false positive doubles
 * latency for that turn); false negatives are why we shipped the rule
 * in the first place ("Through three? ..." reached the listener).
 * Tune narrow on purpose.
 *
 * Each case maps to a specific user complaint or judge-flagged
 * smell — keep that traceability so future edits don't regress the
 * original signal.
 */
function lines(...texts: string[]): DialogueLine[] {
  return texts.map((text, i) => ({ hostId: i === 0 ? "theo" : i === 1 ? "maya" : "cam", text }));
}

describe("detectClarityIssues", () => {
  // --- ORPHAN PERIOD REFERENCE — the user-reported smell ----------
  it("flags 'Through three?' with no qualifier (the user-reported case)", () => {
    const issues = detectClarityIssues(lines("Through three? Shai's usage is up."));
    expect(issues.some((i) => /Through \[N\]/i.test(i))).toBe(true);
  });

  it("flags 'Through three —' followed by anything that isn't a period noun", () => {
    const issues = detectClarityIssues(lines("Through three — Hill has six targets."));
    expect(issues.some((i) => /Through \[N\]/i.test(i))).toBe(true);
  });

  it("does NOT flag 'Through three quarters' (proper period qualifier)", () => {
    const issues = detectClarityIssues(lines("Through three quarters Hill has six targets."));
    expect(issues.some((i) => /Through \[N\]/i.test(i))).toBe(false);
  });

  it("does NOT flag 'Through two games' or 'Through five drives'", () => {
    expect(detectClarityIssues(lines("Through two games he's averaging 22."))).toEqual([]);
    expect(detectClarityIssues(lines("Through five drives the offense is humming."))).toEqual([]);
  });

  // --- ANALYST SHORTHAND — also user-reported -------------------
  it("flags 'playmaker lift'", () => {
    const issues = detectClarityIssues(lines("One playmaker lift, not a scorer bump."));
    expect(issues.some((i) => /playmaker lift/i.test(i))).toBe(true);
  });

  it("flags 'scorer bump'", () => {
    const issues = detectClarityIssues(lines("Pure scorer bump tonight."));
    expect(issues.some((i) => /scorer bump/i.test(i))).toBe(true);
  });

  it("flags 'usage rate spikes'", () => {
    const issues = detectClarityIssues(lines("Shai's usage rate spikes at home."));
    expect(issues.some((i) => /usage rate spikes/i.test(i))).toBe(true);
  });

  it("flags 'ceiling swing' / 'ceiling lift' / 'ceiling bump'", () => {
    expect(detectClarityIssues(lines("It's a ceiling swing for him."))[0]).toMatch(/ceiling/);
    expect(detectClarityIssues(lines("Real ceiling lift here."))[0]).toMatch(/ceiling/);
    expect(detectClarityIssues(lines("Tonight's a ceiling bump."))[0]).toMatch(/ceiling/);
  });

  // --- BARE COUNTS — need period qualifier --------------------
  it("flags 'six assists' with no qualifier", () => {
    const issues = detectClarityIssues(lines("Mmhmm. Six assists, the role's there."));
    expect(issues.some((i) => /six assists/i.test(i))).toBe(true);
  });

  it("does NOT flag 'six assists in the half'", () => {
    const issues = detectClarityIssues(lines("Six assists in the half — role's clear."));
    expect(issues.some((i) => /six assists/i.test(i))).toBe(false);
  });

  it("does NOT flag 'twelve targets through three quarters'", () => {
    expect(detectClarityIssues(lines("Twelve targets through three quarters."))).toEqual([]);
  });

  // --- PASSING CASES — known-good outputs shouldn't trigger -----
  it("passes on a clean reaction turn", () => {
    expect(detectClarityIssues(lines("Mmhmm.", "Lock it in.", "Told you."))).toEqual([]);
  });

  it("passes on a clean specific take with units", () => {
    expect(
      detectClarityIssues(
        lines(
          "Kelce just took a 21-yard catch to the red zone — six points for Marc.",
          "[deadpan] Through three games his target share is 22%."
        )
      )
    ).toEqual([]);
  });

  // --- DEDUPLICATION — same issue noted once even if it repeats --
  it("deduplicates the same shorthand mentioned twice", () => {
    const issues = detectClarityIssues(
      lines("One playmaker lift now.", "Maybe another playmaker lift next quarter.")
    );
    const playmakerNotes = issues.filter((i) => /playmaker lift/i.test(i));
    expect(playmakerNotes).toHaveLength(1);
  });
});
