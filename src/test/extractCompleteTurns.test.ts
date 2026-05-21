import { describe, expect, it } from "vitest";
import { extractCompleteTurns } from "../providers/openAICommentaryProvider";

/**
 * Pins the streaming JSON extractor that drives the opener pipeline.
 * The contract is intentionally narrow:
 *
 *  - Returns complete `{speaker, text}` objects from inside the
 *    "turns": [...] array as they close.
 *  - Never emits a partial object — caller relies on "if I see it, it
 *    parsed cleanly."
 *  - The cursor it returns is the resume position for the NEXT chunk,
 *    so concatenating chunks + calling repeatedly behaves the same as
 *    one big parse.
 *  - Quoted braces don't bump depth; escapes inside strings are
 *    respected.
 */
describe("extractCompleteTurns", () => {
  it("returns nothing when the array hasn't opened yet", () => {
    const result = extractCompleteTurns('{"meta": "still ramping', 0);
    expect(result.turns).toEqual([]);
    expect(result.nextCursor).toBe(0);
  });

  it("extracts a single complete turn from a sealed buffer", () => {
    const buf = '{"turns": [{"speaker": "theo", "text": "Your guy."}]}';
    const result = extractCompleteTurns(buf, 0);
    expect(result.turns).toEqual([{ speaker: "theo", text: "Your guy." }]);
    expect(result.nextCursor).toBeGreaterThan(buf.indexOf("]"));
  });

  it("yields turns one at a time as the buffer grows (the streaming case)", () => {
    // Simulate the buffer arriving in three chunks.
    const chunk1 = '{"turns": [{"speaker": "theo", "text": "Marc — Kelce'; // mid-text-string
    const chunk2 = ', twenty-one. Maya?"}, {"speaker": "maya", "text": "Mmhmm.';
    const chunk3 = '"}, {"speaker": "cam", "text": "Lock it in."}]}';

    let buffer = chunk1;
    let cursor = 0;
    let collected: unknown[] = [];

    let result = extractCompleteTurns(buffer, cursor);
    collected = collected.concat(result.turns);
    cursor = result.nextCursor;
    expect(collected).toHaveLength(0); // first turn isn't closed yet

    buffer += chunk2;
    result = extractCompleteTurns(buffer, cursor);
    collected = collected.concat(result.turns);
    cursor = result.nextCursor;
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual({ speaker: "theo", text: "Marc — Kelce, twenty-one. Maya?" });

    buffer += chunk3;
    result = extractCompleteTurns(buffer, cursor);
    collected = collected.concat(result.turns);
    cursor = result.nextCursor;
    expect(collected).toHaveLength(3);
    expect(collected[1]).toEqual({ speaker: "maya", text: "Mmhmm." });
    expect(collected[2]).toEqual({ speaker: "cam", text: "Lock it in." });
  });

  it("does not bump depth for braces inside quoted text", () => {
    // A turn whose text contains a literal "{" — naive brace counters
    // would think the object closes early.
    const buf = '{"turns": [{"speaker": "theo", "text": "He said { wait }."}]}';
    const result = extractCompleteTurns(buf, 0);
    expect(result.turns).toEqual([{ speaker: "theo", text: "He said { wait }." }]);
  });

  it("respects backslash escapes inside strings", () => {
    // The text field contains an escaped quote — must not flip the
    // inString flag.
    const buf = '{"turns": [{"speaker": "maya", "text": "She said \\"sure\\"."}]}';
    const result = extractCompleteTurns(buf, 0);
    expect(result.turns).toHaveLength(1);
    const turn = result.turns[0] as { text: string };
    expect(turn.text).toBe('She said "sure".');
  });

  it("returns when the closing ] arrives — even if trailing buffer follows", () => {
    const buf = '{"turns": [{"speaker": "theo", "text": "Your guy."}], "footer": "ignored"}';
    const result = extractCompleteTurns(buf, 0);
    expect(result.turns).toHaveLength(1);
    // nextCursor should be past the "]" so a follow-up call doesn't
    // re-scan the same chunk.
    expect(buf.slice(result.nextCursor).trim().startsWith(",")).toBe(true);
  });

  it("idempotent: calling twice on a fully-consumed buffer returns nothing", () => {
    const buf = '{"turns": [{"speaker": "theo", "text": "Hi."}]}';
    const first = extractCompleteTurns(buf, 0);
    expect(first.turns).toHaveLength(1);
    const second = extractCompleteTurns(buf, first.nextCursor);
    expect(second.turns).toEqual([]);
    expect(second.nextCursor).toBe(first.nextCursor);
  });

  it("handles multiple chunks landing in the same call cleanly", () => {
    // Two objects arrive in a single chunk after the array opens.
    const buf = '{"turns": [{"speaker": "theo", "text": "A."}, {"speaker": "maya", "text": "B."}]}';
    const result = extractCompleteTurns(buf, 0);
    expect(result.turns).toEqual([
      { speaker: "theo", text: "A." },
      { speaker: "maya", text: "B." }
    ]);
  });

  it("waits when an object closes mid-stream (no premature emit)", () => {
    // Buffer has the brace-counts adding up but the closing } is
    // missing — extractor must NOT emit.
    const buf = '{"turns": [{"speaker": "theo", "text": "still going';
    const result = extractCompleteTurns(buf, 0);
    expect(result.turns).toEqual([]);
  });

  // --- ROBUST ANCHOR — preamble keys ---------------------------
  it('anchors on `"turns": [` even when preamble keys appear earlier', () => {
    // gpt-5-mini sometimes emits auxiliary keys (`thinking`, `meta`,
    // `intent`) before `turns`. The first `[` is the preamble array.
    // Anchor must skip past it.
    const buf =
      '{"thinking": ["intro", "build", "land"], "turns": [{"speaker": "theo", "text": "Welcome in."}]}';
    const result = extractCompleteTurns(buf, 0);
    expect(result.turns).toEqual([{ speaker: "theo", text: "Welcome in." }]);
  });

  it('waits when buffer is short and lacks `"turns"` (key may still be streaming)', () => {
    // Buffer has a `[` but no `"turns":` yet, AND total length is
    // under the safety threshold — wait for more bytes.
    const buf = '{"meta": [';
    const result = extractCompleteTurns(buf, 0);
    expect(result.turns).toEqual([]);
    expect(result.nextCursor).toBe(0); // didn't advance — re-try on next chunk
  });

  it('refuses to anchor on a stray `[` without a `"turns":` key', () => {
    // Long buffers without `"turns":` could be a preamble array that
    // happens to span more than 100+ chars (e.g. {"meta": ["x", "y",
    // ...]} where the array hasn't closed yet). Mis-anchoring on the
    // first `[` would parse meta strings as turn objects and pollute
    // the stream. We choose to wait instead — the caller has the
    // output_text.done text as a final-parse fallback for legacy
    // schemas that lack a "turns" wrapper.
    const padding = " ".repeat(150);
    const buf = padding + '[{"speaker": "theo", "text": "Hi."}]';
    const result = extractCompleteTurns(buf, 0);
    expect(result.turns).toEqual([]);
  });

  it('refuses to anchor when the preamble array itself looks like turns', () => {
    // The dangerous case from the audit: gpt-5-mini emits a long
    // auxiliary array before the turns key. Without the strict anchor
    // we'd parse the meta strings as turn objects (coerce would skip
    // them but we'd advance the cursor past the wrong array). With
    // the strict anchor we wait until "turns": [ appears.
    const buf =
      '{"meta": ["intro frame", "build the tension", "deliver the take", "land it clean", "outro hook"';
    const result = extractCompleteTurns(buf, 0);
    expect(result.turns).toEqual([]);
    expect(result.nextCursor).toBe(0);
  });
});
