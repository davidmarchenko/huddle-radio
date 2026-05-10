import type { AsrWord } from "./contracts";

/**
 * Turn Nemotron ASR word timestamps into a WebVTT subtitle file.
 * The W21 "Clip-it" flow uses this to produce karaoke-style captions
 * for shareable audio posts — the model hands us word-level timing
 * (one of Nano Omni's headline ASR features), so we just batch words
 * into readable cues.
 *
 * Cues are grouped to land on natural punctuation breaks when
 * possible, otherwise capped by word count + duration so a single
 * cue never exceeds ~45 characters or ~3 seconds.
 *
 * Pure (no DOM, no fetch) so this can run on the server in a Route
 * Handler or in tests without browser shims.
 */

export type WebVttBuildOptions = {
  /** Hard cap on characters per cue. Default 45. */
  maxCharsPerCue?: number;
  /** Hard cap on duration per cue in milliseconds. Default 3000. */
  maxDurationMsPerCue?: number;
  /** Hard cap on word count per cue. Default 10. */
  maxWordsPerCue?: number;
};

const DEFAULTS: Required<WebVttBuildOptions> = {
  maxCharsPerCue: 45,
  maxDurationMsPerCue: 3000,
  maxWordsPerCue: 10
};

const SENTENCE_BREAK = /[.?!]$/;

function pad(value: number, length: number): string {
  return value.toString().padStart(length, "0");
}

export function formatVttTimestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const totalSeconds = Math.floor(safe / 1000);
  const milliseconds = safe % 1000;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(milliseconds, 3)}`;
}

type Cue = {
  startMs: number;
  endMs: number;
  text: string;
};

function flushCue(words: AsrWord[]): Cue | undefined {
  if (words.length === 0) return undefined;
  const startMs = words[0]!.startMs;
  const endMs = words[words.length - 1]!.endMs;
  return {
    startMs,
    endMs,
    text: words.map((w) => w.text).join(" ").trim()
  };
}

export function groupWordsIntoCues(
  words: AsrWord[],
  options: WebVttBuildOptions = {}
): Cue[] {
  const opts = { ...DEFAULTS, ...options };
  const cues: Cue[] = [];
  let buffer: AsrWord[] = [];
  let bufferChars = 0;

  const flush = () => {
    const cue = flushCue(buffer);
    if (cue) cues.push(cue);
    buffer = [];
    bufferChars = 0;
  };

  for (const word of words) {
    const candidateChars = bufferChars + word.text.length + (buffer.length === 0 ? 0 : 1);
    const candidateDuration = buffer.length === 0 ? 0 : word.endMs - buffer[0]!.startMs;
    const wouldOverflow =
      buffer.length >= opts.maxWordsPerCue ||
      candidateChars > opts.maxCharsPerCue ||
      candidateDuration > opts.maxDurationMsPerCue;

    if (wouldOverflow && buffer.length > 0) {
      flush();
    }

    buffer.push(word);
    bufferChars = buffer.length === 1 ? word.text.length : bufferChars + 1 + word.text.length;

    // End-of-sentence: prefer to break here even if we're under the
    // soft caps. Keeps cues aligned to punctuation when present.
    if (SENTENCE_BREAK.test(word.text)) flush();
  }
  flush();
  return cues;
}

export function buildWebVtt(words: AsrWord[], options: WebVttBuildOptions = {}): string {
  const cues = groupWordsIntoCues(words, options);
  if (cues.length === 0) return "WEBVTT\n";
  const body = cues
    .map((cue, i) => {
      // Index header is optional in WebVTT but plays nicely with
      // older browser parsers and makes diffs/tests readable.
      return `${i + 1}\n${formatVttTimestamp(cue.startMs)} --> ${formatVttTimestamp(cue.endMs)}\n${cue.text}`;
    })
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}
