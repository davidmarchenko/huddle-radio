import { describe, expect, it } from "vitest";
import {
  formatPeriodLabel,
  periodFromLegacyString,
  periodFromNumber,
  periodKindForSport
} from "../shared/period";

/**
 * The structured-period helper is what fixed the "baseball games show
 * Q9" bug. These tests pin every label convention so a future tweak
 * to one sport can't quietly regress another.
 */

describe("periodKindForSport", () => {
  it.each([
    ["nfl" as const, "quarter"],
    ["ncaaf" as const, "quarter"],
    ["nba" as const, "quarter"],
    ["wnba" as const, "quarter"],
    ["ncaab" as const, "quarter"],
    ["nhl" as const, "period"],
    ["mlb" as const, "inning"],
    ["soccer" as const, "half"],
    ["other" as const, "quarter"]
  ])("maps %s → %s", (sport, expected) => {
    expect(periodKindForSport(sport)).toBe(expected);
  });
});

describe("formatPeriodLabel — quarter sports", () => {
  it("renders Q1-Q4 verbatim", () => {
    for (const n of [1, 2, 3, 4]) {
      expect(formatPeriodLabel({ number: n, kind: "quarter" })).toBe(`Q${n}`);
    }
  });
  it("renders a single OT as plain 'OT'", () => {
    expect(formatPeriodLabel({ number: 5, kind: "quarter" })).toBe("OT");
  });
  it("renders double OT and beyond as OT2/OT3", () => {
    expect(formatPeriodLabel({ number: 6, kind: "quarter" })).toBe("OT2");
    expect(formatPeriodLabel({ number: 7, kind: "quarter" })).toBe("OT3");
  });
});

describe("formatPeriodLabel — hockey", () => {
  it("renders P1-P3 verbatim", () => {
    expect(formatPeriodLabel({ number: 1, kind: "period" })).toBe("P1");
    expect(formatPeriodLabel({ number: 3, kind: "period" })).toBe("P3");
  });
  it("renders overtime as OT, shootout as SO", () => {
    expect(formatPeriodLabel({ number: 4, kind: "period" })).toBe("OT");
    expect(formatPeriodLabel({ number: 5, kind: "period" })).toBe("SO");
  });
});

describe("formatPeriodLabel — baseball", () => {
  it("renders innings with ordinal suffix", () => {
    expect(formatPeriodLabel({ number: 1, kind: "inning" })).toBe("1st");
    expect(formatPeriodLabel({ number: 2, kind: "inning" })).toBe("2nd");
    expect(formatPeriodLabel({ number: 3, kind: "inning" })).toBe("3rd");
    // The "Q9" bug: this used to render as Q9. Now reads as 9th.
    expect(formatPeriodLabel({ number: 9, kind: "inning" })).toBe("9th");
    expect(formatPeriodLabel({ number: 11, kind: "inning" })).toBe("11th");
    expect(formatPeriodLabel({ number: 12, kind: "inning" })).toBe("12th");
    expect(formatPeriodLabel({ number: 13, kind: "inning" })).toBe("13th");
    expect(formatPeriodLabel({ number: 21, kind: "inning" })).toBe("21st");
  });
  it("prefixes top/bottom when carried on the period info", () => {
    expect(formatPeriodLabel({ number: 7, kind: "inning", half: "top" })).toBe("Top 7th");
    expect(formatPeriodLabel({ number: 7, kind: "inning", half: "bottom" })).toBe("Bot 7th");
  });
  it("prefers the upstream shortDetail when it carries digits", () => {
    // ESPN's "Bot 7th" — richer than our composed string. Use it.
    expect(
      formatPeriodLabel({ number: 7, kind: "inning", shortDetail: "Bot 7th" })
    ).toBe("Bot 7th");
  });
  it("ignores a shortDetail without digits (defensive guard)", () => {
    expect(
      formatPeriodLabel({ number: 7, kind: "inning", shortDetail: "Inning" })
    ).toBe("7th");
  });
});

describe("formatPeriodLabel — soccer", () => {
  it("renders H1, H2", () => {
    expect(formatPeriodLabel({ number: 1, kind: "half" })).toBe("H1");
    expect(formatPeriodLabel({ number: 2, kind: "half" })).toBe("H2");
  });
  it("renders anything past regulation as ET", () => {
    expect(formatPeriodLabel({ number: 3, kind: "half" })).toBe("ET");
  });
});

describe("formatPeriodLabel — pregame / unknown", () => {
  it("falls back to shortDetail when number is 0", () => {
    expect(formatPeriodLabel({ number: 0, kind: "quarter", shortDetail: "Pregame" })).toBe("Pregame");
    expect(formatPeriodLabel({ number: 0, kind: "inning", shortDetail: "Final" })).toBe("Final");
  });
  it("renders empty when number is 0 and no shortDetail", () => {
    expect(formatPeriodLabel({ number: 0, kind: "quarter" })).toBe("");
  });
});

describe("periodFromNumber", () => {
  it("tags the kind based on the sport", () => {
    expect(periodFromNumber(3, "nba")).toEqual({ number: 3, kind: "quarter" });
    expect(periodFromNumber(2, "nhl")).toEqual({ number: 2, kind: "period" });
    expect(periodFromNumber(7, "mlb")).toEqual({ number: 7, kind: "inning" });
    expect(periodFromNumber(1, "soccer")).toEqual({ number: 1, kind: "half" });
  });
  it("forwards extras (half, shortDetail) into the result", () => {
    expect(
      periodFromNumber(7, "mlb", { half: "top", shortDetail: "Top 7th" })
    ).toEqual({
      number: 7,
      kind: "inning",
      half: "top",
      shortDetail: "Top 7th"
    });
  });
});

describe("periodFromLegacyString migration", () => {
  it("pulls the digit out of a Q-prefixed legacy string", () => {
    expect(periodFromLegacyString("Q3", "nba")).toMatchObject({
      number: 3,
      kind: "quarter"
    });
  });
  it("preserves the raw string as shortDetail for unparseable inputs", () => {
    const result = periodFromLegacyString("Pregame", "nfl");
    expect(result.number).toBe(0);
    expect(result.shortDetail).toBe("Pregame");
  });
  it("infers half from a 'Top/Bot' prefix", () => {
    expect(periodFromLegacyString("Top 7th", "mlb").half).toBe("top");
    expect(periodFromLegacyString("Bot 9th", "mlb").half).toBe("bottom");
  });
  it("uses the sport's natural kind for legacy strings", () => {
    expect(periodFromLegacyString("Q3", "mlb").kind).toBe("inning");
    expect(periodFromLegacyString("Q3", "nhl").kind).toBe("period");
  });
});
