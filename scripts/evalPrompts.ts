import "dotenv/config";

/**
 * Golden-scenario eval harness for the commentary prompts.
 *
 * Runs a fixed set of hand-built scenarios through the real
 * CommentaryProvider chain (whatever createCommentaryProvider()
 * returns — gpt-5-mini today via OpenAI), then grades each output
 * via the real Evaluator chain (Claude Haiku 4.5 when
 * ANTHROPIC_API_KEY is set, LocalEvaluator otherwise).
 *
 * Two reasons this exists:
 *
 *   1. Prompt iteration. The /api/diagnostics/eval surface judges
 *      DELIVERED turns from a live show, which is great for prod
 *      monitoring but useless for "did my prompt change improve
 *      things?" — every run has different game state, can't compare.
 *      This harness pins game state across runs so an eval delta IS
 *      a prompt delta.
 *
 *   2. Regression rig. Run before + after any change to
 *      commentaryPrompts.ts, persona prompts, or producer
 *      directives. If meanStayTuned dropped, you regressed; if
 *      it improved across most scenarios, ship it.
 *
 * Usage:
 *   npm run eval:prompts            # console report, exits non-zero if any scenario throws
 *   npm run eval:prompts -- --json  # JSON to stdout, machine-readable for diffs
 *   npm run eval:prompts -- --scenarios=opener,big-play   # subset by id
 *
 * Output sample (text mode):
 *   === opener-with-roster ===
 *     [Theo] Marc — week 7 lineup, here we go. Mahomes...
 *     [Maya] He's been a target magnet against this defense...
 *     scores: spec 8.5 / friction 7.0 / callbacks 6.0 / pacing 8.5 / anti 7.0
 *     stayTuned 7.4 — Strong opener; light on host friction.
 *
 *   === big-play-touchdown ===
 *     [Cam] ...
 *     scores: ...
 *     stayTuned 8.2 — ...
 *
 *   Mean stayTuned: 7.8 across 8 scenarios
 *
 * No live engine, no SSE, no TTS. Just the prompts and the judge.
 */

import { joinDialogueLines } from "../src/providers/commentaryPrompts";
import { createCommentaryProvider } from "../src/server/createCommentaryProvider";
import { createEvaluator } from "../src/server/showFactories";
import { scenarios as ALL_SCENARIOS } from "./evalScenarios";
import type { TurnEvaluation } from "../src/server/eval/types";

type RunResult = {
  scenarioId: string;
  text: string;
  hostLines: Array<{ hostId: string; text: string }>;
  evaluation: TurnEvaluation;
  durationMs: number;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const scenarioFilter = args.find((a) => a.startsWith("--scenarios="))?.slice("--scenarios=".length);
  const wantedIds = scenarioFilter ? new Set(scenarioFilter.split(",").map((s) => s.trim())) : undefined;

  const provider = createCommentaryProvider();
  const evaluator = createEvaluator();

  if (!jsonOutput) {
    console.log(`Commentary chain: ${provider.id}`);
    console.log(`Evaluator chain:  ${evaluator.id}`);
    console.log(`Scenarios:        ${wantedIds ? `${wantedIds.size} (filtered)` : ALL_SCENARIOS.length}`);
    console.log("");
  }

  const results: RunResult[] = [];
  for (const scenario of ALL_SCENARIOS) {
    if (wantedIds && !wantedIds.has(scenario.id)) continue;
    const startedAt = performance.now();
    try {
      const lines = await provider.draft(scenario.input);
      const text = joinDialogueLines(lines);
      const evaluation = await evaluator.evaluate({
        turnId: scenario.id,
        text,
        recentCommentary: scenario.input.recentCommentary,
        momentContext: scenario.momentContext,
        availableSources: scenario.availableSources
      });
      const result: RunResult = {
        scenarioId: scenario.id,
        text,
        hostLines: lines.map((l) => ({ hostId: l.hostId, text: l.text })),
        evaluation,
        durationMs: Math.round(performance.now() - startedAt)
      };
      results.push(result);
      if (!jsonOutput) printResultText(scenario.id, result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!jsonOutput) console.error(`!! scenario "${scenario.id}" threw: ${msg}\n`);
      else console.error(JSON.stringify({ scenarioId: scenario.id, error: msg }));
      process.exitCode = 1;
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ results, summary: aggregate(results) }, null, 2));
  } else {
    printSummaryText(results);
  }
}

function printResultText(scenarioId: string, r: RunResult): void {
  console.log(`=== ${scenarioId} ===`);
  for (const line of r.hostLines) {
    // Clip very long lines for terminal readability; the JSON output
    // has the full text if you need to inspect closer.
    const clipped = line.text.length > 280 ? `${line.text.slice(0, 277)}...` : line.text;
    console.log(`  [${line.hostId}] ${clipped}`);
  }
  const s = r.evaluation.scores;
  console.log(
    `  scores: spec ${s.specificity} / friction ${s.friction} / callbacks ${s.callbacks} / pacing ${s.pacing} / anti ${s.anti_genericity}`
  );
  console.log(`  stayTuned ${r.evaluation.stayTuned} — ${r.evaluation.rationale}`);
  console.log(`  (${r.durationMs}ms, judge=${r.evaluation.evaluator})`);
  console.log("");
}

function printSummaryText(results: RunResult[]): void {
  if (results.length === 0) {
    console.log("No scenarios ran.");
    return;
  }
  const agg = aggregate(results);
  console.log("--- summary ---");
  console.log(`  scenarios run:   ${results.length}`);
  console.log(`  mean stayTuned:  ${agg.meanStayTuned.toFixed(2)}`);
  console.log(`  mean dimensions: spec ${agg.mean.specificity.toFixed(1)} / friction ${agg.mean.friction.toFixed(1)} / callbacks ${agg.mean.callbacks.toFixed(1)} / pacing ${agg.mean.pacing.toFixed(1)} / anti ${agg.mean.anti_genericity.toFixed(1)}`);
  console.log(`  fastest:         ${agg.fastestMs}ms (${agg.fastestId})`);
  console.log(`  slowest:         ${agg.slowestMs}ms (${agg.slowestId})`);
}

function aggregate(results: RunResult[]) {
  if (results.length === 0) {
    return {
      meanStayTuned: 0,
      mean: { specificity: 0, friction: 0, callbacks: 0, pacing: 0, anti_genericity: 0 },
      fastestMs: 0,
      slowestMs: 0,
      fastestId: "",
      slowestId: ""
    };
  }
  const sum = results.reduce(
    (acc, r) => ({
      stayTuned: acc.stayTuned + r.evaluation.stayTuned,
      specificity: acc.specificity + r.evaluation.scores.specificity,
      friction: acc.friction + r.evaluation.scores.friction,
      callbacks: acc.callbacks + r.evaluation.scores.callbacks,
      pacing: acc.pacing + r.evaluation.scores.pacing,
      anti_genericity: acc.anti_genericity + r.evaluation.scores.anti_genericity
    }),
    { stayTuned: 0, specificity: 0, friction: 0, callbacks: 0, pacing: 0, anti_genericity: 0 }
  );
  const n = results.length;
  const sortedByMs = [...results].sort((a, b) => a.durationMs - b.durationMs);
  return {
    meanStayTuned: sum.stayTuned / n,
    mean: {
      specificity: sum.specificity / n,
      friction: sum.friction / n,
      callbacks: sum.callbacks / n,
      pacing: sum.pacing / n,
      anti_genericity: sum.anti_genericity / n
    },
    fastestMs: sortedByMs[0].durationMs,
    slowestMs: sortedByMs[sortedByMs.length - 1].durationMs,
    fastestId: sortedByMs[0].scenarioId,
    slowestId: sortedByMs[sortedByMs.length - 1].scenarioId
  };
}

main().catch((error) => {
  console.error("Eval harness crashed:", error);
  process.exit(1);
});
