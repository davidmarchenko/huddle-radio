import { describe, expect, it } from "vitest";
import { chooseFresh, stableIndex } from "../engine/livecastEngine";

describe("chooseFresh", () => {
  it("returns one of the options for a non-empty list", () => {
    const result = chooseFresh(["A long opening line about Mahomes", "B short"], [], "seed");
    expect(["A long opening line about Mahomes", "B short"]).toContain(result);
  });

  it("filters out options whose 28-char prefix appears in recent commentary", () => {
    const options = [
      "Maya here — Mahomes goes deep again folks",
      "Theo here — listen, the run game is the story"
    ];
    const recent = ["Maya here — Mahomes goes deep again. The KC offense is humming."];
    const choice = chooseFresh(options, recent, "seed-1");
    expect(choice).toBe("Theo here — listen, the run game is the story");
  });

  it("falls back to the unfiltered list if every option overlaps recent text", () => {
    const options = ["Just call it like it is here", "Just call it like it is here"];
    const recent = ["Just call it like it is here, that was a touchdown."];
    const choice = chooseFresh(options, recent, "seed");
    expect(options).toContain(choice);
  });

  it("returns empty string for an empty options list", () => {
    expect(chooseFresh([], [], "seed")).toBe("");
  });

  it("is deterministic — same options + seed always pick the same line", () => {
    const options = ["alpha line one here", "beta line two here", "gamma line three here"];
    const a = chooseFresh(options, [], "stable-seed");
    const b = chooseFresh(options, [], "stable-seed");
    expect(a).toBe(b);
  });

  it("skips empty/falsy entries even when none of recent matches", () => {
    const choice = chooseFresh(["", "real option here"], [], "seed");
    expect(choice).toBe("real option here");
  });
});

describe("stableIndex", () => {
  it("returns 0 for an empty modulo (edge case)", () => {
    expect(stableIndex("anything", 0)).toBe(0);
  });

  it("is deterministic across calls", () => {
    expect(stableIndex("hello", 5)).toBe(stableIndex("hello", 5));
  });

  it("varies with input", () => {
    const a = stableIndex("aaa", 100);
    const b = stableIndex("zzz", 100);
    expect(a).not.toBe(b);
  });
});
