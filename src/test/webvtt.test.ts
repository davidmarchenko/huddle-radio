import { describe, expect, it } from "vitest";
import { buildWebVtt, formatVttTimestamp, groupWordsIntoCues } from "../shared/webvtt";
import type { AsrWord } from "../shared/contracts";

const w = (text: string, startMs: number, endMs: number): AsrWord => ({ text, startMs, endMs });

describe("formatVttTimestamp", () => {
  it("formats milliseconds into hh:mm:ss.mmm", () => {
    expect(formatVttTimestamp(0)).toBe("00:00:00.000");
    expect(formatVttTimestamp(1234)).toBe("00:00:01.234");
    expect(formatVttTimestamp(65_500)).toBe("00:01:05.500");
    expect(formatVttTimestamp(3_600_000)).toBe("01:00:00.000");
  });

  it("clamps negative input to 0 and rounds fractional ms", () => {
    expect(formatVttTimestamp(-50)).toBe("00:00:00.000");
    expect(formatVttTimestamp(123.6)).toBe("00:00:00.124");
  });
});

describe("groupWordsIntoCues", () => {
  it("breaks at sentence-ending punctuation", () => {
    const words = [
      w("Touchdown", 0, 500),
      w("Kansas", 520, 700),
      w("City.", 720, 950),
      w("That", 1100, 1200),
      w("changes", 1220, 1500),
      w("everything.", 1520, 1900)
    ];
    const cues = groupWordsIntoCues(words);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe("Touchdown Kansas City.");
    expect(cues[1]!.text).toBe("That changes everything.");
  });

  it("respects the character cap when no punctuation lands first", () => {
    const longWords = Array.from({ length: 12 }, (_, i) => w(`word${i}`, i * 200, i * 200 + 150));
    const cues = groupWordsIntoCues(longWords, { maxCharsPerCue: 30 });
    // No cue should overflow the char cap.
    for (const cue of cues) {
      expect(cue.text.length).toBeLessThanOrEqual(30);
    }
    // And we should have produced at least 2 cues for 12 words.
    expect(cues.length).toBeGreaterThanOrEqual(2);
  });

  it("respects the duration cap when a sentence runs long", () => {
    const words = [
      w("a", 0, 100),
      w("b", 200, 300),
      w("c", 400, 500),
      w("d", 600, 700),
      // Big jump into the next "phrase"
      w("e", 4000, 4100),
      w("f", 4200, 4300)
    ];
    const cues = groupWordsIntoCues(words, { maxDurationMsPerCue: 2000 });
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (const cue of cues) {
      expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(2000);
    }
  });

  it("returns an empty array when given no words", () => {
    expect(groupWordsIntoCues([])).toEqual([]);
  });
});

describe("buildWebVtt", () => {
  it("returns a minimal WEBVTT header when given no words", () => {
    expect(buildWebVtt([])).toBe("WEBVTT\n");
  });

  it("emits indexed cues with WebVTT-formatted timestamps", () => {
    const words = [
      w("Hello", 250, 500),
      w("world.", 520, 900),
      w("Next", 1100, 1300),
      w("cue.", 1320, 1700)
    ];
    const vtt = buildWebVtt(words);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    // Two cues, each with index headers and the WebVTT arrow.
    expect(vtt).toMatch(/^1\n00:00:00\.250 --> 00:00:00\.900\nHello world\.$/m);
    expect(vtt).toMatch(/^2\n00:00:01\.100 --> 00:00:01\.700\nNext cue\.$/m);
  });
});
