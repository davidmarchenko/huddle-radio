/**
 * LocalEvaluator — deterministic, dependency-free judge.
 *
 * Two roles:
 *
 *   1. Test substrate. Lets the eval pipeline + storage be exercised
 *      without an LLM key.
 *   2. Last-resort fallback. If the LLM evaluator is unavailable or
 *      throws, the engine falls through here so the eval ring buffer
 *      always gets *something* per turn.
 *
 * The heuristics are intentionally simple — they catch obvious wins
 * and obvious failures, but they're a floor, not a ceiling. Production
 * decisions should rely on the LLM evaluator when it's available.
 *
 * Heuristics in brief:
 *
 *   - specificity: count of capitalized noun-likes (player names,
 *     team names) and standalone numbers. More = more specific.
 *   - friction: count of phrases that signal disagreement / push-back
 *     ("no,", "actually,", "wait —", "I'm not buying").
 *   - callbacks: any 3-word substring shared with `recentCommentary`
 *     that isn't a generic phrase.
 *   - pacing: word count check vs the moment context — buzzer-beater
 *     deserves more words; routine play deserves fewer.
 *   - anti_genericity: penalise known filler ("big slate tonight,"
 *     "welcome back, folks," "big play here").
 *
 * Composite stayTuned = mean of dimensions, rounded to 1 decimal.
 */

import type { Evaluator, EvalInput, TurnEvaluation } from "./types";

const ID = "local-evaluator";
const LABEL = "Local Evaluator";

const GENERIC_FILLER = [
  "big slate",
  "welcome back",
  "big play",
  "what a play",
  "big play here",
  "big game tonight",
  "big night",
  "no doubt about it",
  "at the end of the day",
  "all i'm saying"
];

const FRICTION_MARKERS = [
  "no,",
  "no -",
  "no —",
  "actually",
  "wait,",
  "wait —",
  "i'm not buying",
  "i don't buy",
  "you said",
  "last week you",
  "you predicted"
];

export class LocalEvaluator implements Evaluator {
  id = ID;
  label = LABEL;

  async evaluate(input: EvalInput): Promise<TurnEvaluation> {
    const lower = input.text.toLowerCase();

    const specificity = scoreSpecificity(input.text);
    const friction = scoreFriction(lower);
    const callbacks = scoreCallbacks(input.text, input.recentCommentary);
    const pacing = scorePacing(input.text, input.momentContext);
    const antiGenericity = scoreAntiGenericity(lower);

    const scores = {
      specificity,
      friction,
      callbacks,
      pacing,
      anti_genericity: antiGenericity
    } as const;
    const stayTuned = Math.round(
      ((specificity + friction + callbacks + pacing + antiGenericity) / 5) * 10
    ) / 10;

    return {
      turnId: input.turnId,
      evaluator: ID,
      scores,
      stayTuned,
      rationale: buildRationale(scores),
      evaluatedAt: new Date().toISOString()
    };
  }

  async health() {
    return {
      id: ID,
      label: LABEL,
      status: "ready" as const,
      detail: "Local heuristic evaluator always available."
    };
  }
}

function scoreSpecificity(text: string): number {
  // Count capitalized 2+ letter words after the first token of each
  // sentence (likely names) + standalone numbers. Cap at 10.
  const properNouns = (text.match(/(?<=[\.\!\?\:\;]\s|\s)[A-Z][a-zA-Z']{2,}/g) ?? []).length;
  const numbers = (text.match(/\b\d{1,3}(?:\.\d+)?\b/g) ?? []).length;
  const raw = properNouns + numbers * 2; // numbers count double — they're concrete
  if (raw <= 1) return 2;
  if (raw <= 3) return 5;
  if (raw <= 6) return 8;
  return 10;
}

function scoreFriction(textLower: string): number {
  let count = 0;
  for (const marker of FRICTION_MARKERS) {
    if (textLower.includes(marker)) count += 1;
  }
  if (count === 0) return 4; // baseline — most turns aren't conflict turns
  if (count === 1) return 7;
  return 9;
}

function scoreCallbacks(text: string, recent: string[]): number {
  if (recent.length === 0) return 5; // no callbacks possible — neutral
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  // Look for any 3-token shingle from the current turn that appears in
  // a prior turn — modulo generic filler.
  const trigrams = new Set<string>();
  for (let i = 0; i < tokens.length - 2; i += 1) {
    const tri = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
    if (!GENERIC_FILLER.some((f) => tri.includes(f))) {
      trigrams.add(tri);
    }
  }
  for (const prior of recent) {
    const priorLower = prior.toLowerCase();
    for (const tri of trigrams) {
      if (priorLower.includes(tri)) return 9;
    }
  }
  return 4;
}

function scorePacing(text: string, momentContext: string): number {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const contextLower = momentContext.toLowerCase();
  const isHighEnergy = /buzzer|interrupt|game[- ]?winn|major|clutch|swung/.test(contextLower);
  if (isHighEnergy) {
    if (wordCount < 60) return 4; // under-reacted
    if (wordCount > 200) return 6; // over-reacted
    return 9;
  }
  // Routine moment — keep it short.
  if (wordCount < 15) return 5;
  if (wordCount < 80) return 9;
  if (wordCount < 130) return 7;
  return 4; // way too long for a routine play
}

function scoreAntiGenericity(textLower: string): number {
  let hits = 0;
  for (const filler of GENERIC_FILLER) {
    if (textLower.includes(filler)) hits += 1;
  }
  if (hits === 0) return 9;
  if (hits === 1) return 5;
  return 2;
}

function buildRationale(scores: Record<string, number>): string {
  const lows: string[] = [];
  const highs: string[] = [];
  for (const [k, v] of Object.entries(scores)) {
    if (v <= 4) lows.push(k);
    if (v >= 8) highs.push(k);
  }
  if (lows.length === 0 && highs.length === 0) return "Mid-pack across all dimensions.";
  if (lows.length === 0) return `Strong on ${highs.join(", ")}.`;
  if (highs.length === 0) return `Weak on ${lows.join(", ")}.`;
  return `Strong on ${highs.join(", ")}; weak on ${lows.join(", ")}.`;
}
