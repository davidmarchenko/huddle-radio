/**
 * AnthropicEvaluator — Haiku-backed synthetic-listener judge.
 *
 * Runs as fire-and-forget AFTER the listener already heard the turn,
 * so its latency doesn't matter for the show experience — it only
 * matters for how fresh the eval data is in the diagnostics endpoint.
 *
 * Same chain pattern as the host LLM + producer: LLM first, local
 * heuristic fallback so the eval ring buffer always gets *something*.
 */

import type { ProviderHealth } from "../../shared/contracts";
import type { Evaluator, EvalDimension, EvalInput, RuleComplianceCheck, TurnEvaluation } from "./types";

type Fetcher = typeof fetch;

const ID = "anthropic-evaluator";
const LABEL = "Anthropic Evaluator";

type AnthropicResponse = {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
};

export class AnthropicEvaluator implements Evaluator {
  id = ID;
  label = LABEL;
  private readonly endpoint = "https://api.anthropic.com/v1/messages";

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model = "claude-haiku-4-5-20251001",
    private readonly fetcher: Fetcher = fetch
  ) {}

  async evaluate(input: EvalInput): Promise<TurnEvaluation> {
    if (!this.apiKey) throw new Error("AnthropicEvaluator: ANTHROPIC_API_KEY not set");

    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        // 300 was tight for scores + rationale alone. With 5
        // ruleCompliance entries (each ~80-200 chars evidence) we
        // need ~1200-1500 tokens to avoid truncation that would
        // invalidate the JSON parse and bounce the eval to the local
        // heuristic fallback. Initial 900 cap was hitting truncation
        // on harder scenarios where the judge wanted to be specific
        // in evidence quotes.
        max_tokens: 1500,
        system: buildEvalSystemPrompt(),
        messages: [{ role: "user", content: JSON.stringify(buildEvalUserPayload(input)) }]
      })
    });

    if (!response.ok) {
      const body = await safeReadError(response);
      throw new Error(`AnthropicEvaluator ${response.status}: ${body}`);
    }
    const json = (await response.json()) as AnthropicResponse;
    if (json.error?.message) throw new Error(`AnthropicEvaluator error: ${json.error.message}`);
    const raw = (json.content ?? [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join(" ")
      .trim();
    return parseEvalOutput(raw, input.turnId);
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: ID,
      label: LABEL,
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey
        ? `Configured for ${this.model} via the Anthropic Messages API.`
        : "Set ANTHROPIC_API_KEY to enable the LLM evaluator."
    };
  }
}

function buildEvalSystemPrompt(): string {
  return [
    "You are a synthetic listener for Huddle Radio — a personalized AI fantasy sports podcast.",
    "Your job: grade ONE commentary turn on TWO things — (1) holistic 0-10 dimension scores, (2) per-rule compliance checks.",
    "",
    "PART 1 — score 5 dimensions on a 0-10 integer scale:",
    "- specificity: did the turn name specific players / numbers / moments? (10 = anchored in a concrete fact; 0 = totally generic)",
    "- friction: did hosts disagree, push back, mock, or callback to a prior take? (10 = real conversational friction; 0 = three voices nodding)",
    "- callbacks: did the turn extend a thread from `recentCommentary` (a prior prediction, an unresolved tangent, a previously-mocked take)? (10 = clean callback that lands; 0 = no use of priors)",
    "- pacing: did the energy + length match the moment? (10 = perfectly scaled to the moment context; 0 = under- or over-reacted)",
    "- anti_genericity: did the turn AVOID stock radio filler ('big slate tonight', 'welcome back folks', 'big play here', 'no doubt')? (10 = zero filler; 0 = all filler)",
    "Composite `stayTuned` 0-10: would a real fantasy listener stay tuned past this turn?",
    "",
    "PART 2 — per-rule compliance. For each rule below, return:",
    "  fired: 'yes' = rule's positive behavior is observable in the output;",
    "         'no'  = rule applied and the output failed it;",
    "         'n/a' = rule didn't apply (e.g. friction_quota on a 1-turn output).",
    "  evidence: ≤120 chars — quote the offending or supporting phrase.",
    "",
    "Rules:",
    "- friction_quota: when there are 2+ turns, at least one host visibly DISAGREES with another. 'Sure, but' / 'Mmhmm' = agreement theater = no.",
    "- steel_man_two_step: when a turn responds to another host's claim, it must (1) restate the strongest version in one clause AND (2) approve with a NEW reason OR reject with a SPECIFIC flaw. Vague restatement + nod = no. Empty 'no, that's wrong' without specifics = no.",
    "- direct_listener_answer: if `recentCommentary` or context shows a yes/no roster question, exactly one turn must give a clear yes/no with reasoning. Hedges only = no.",
    "- turn_shape_payload: every turn carries ONE of (a) specific consequence with number/effect, (b) named disagreement, (c) callback to recentCommentary, (d) concrete single number with meaning, (e) short reaction <20 words. Pure transitions/filler = no.",
    "- no_transition_filler: no 'this matters', 'big play', 'rack points', 'warm market', 'first drive matters for fantasy rhythm', 'a touchdown is a touchdown' style filler in the spoken text. One slip = no.",
    "",
    "Output JSON ONLY — no preamble, no code fences:",
    "{",
    '  "scores": { "specificity": <0-10>, "friction": <0-10>, "callbacks": <0-10>, "pacing": <0-10>, "anti_genericity": <0-10> },',
    '  "stayTuned": <0-10>,',
    '  "rationale": "one sentence — what specifically lifted or hurt the score",',
    '  "ruleCompliance": [',
    '    {"ruleId": "friction_quota", "fired": "yes"|"no"|"n/a", "evidence": "≤120 chars quote or reason"},',
    '    {"ruleId": "steel_man_two_step", "fired": "yes"|"no"|"n/a", "evidence": "..."},',
    '    {"ruleId": "direct_listener_answer", "fired": "yes"|"no"|"n/a", "evidence": "..."},',
    '    {"ruleId": "turn_shape_payload", "fired": "yes"|"no"|"n/a", "evidence": "..."},',
    '    {"ruleId": "no_transition_filler", "fired": "yes"|"no"|"n/a", "evidence": "..."}',
    "  ]",
    "}",
    "",
    "Be honest. A 6 average is fine; not every turn is a 10. Reserve 9-10 for turns that actually feel like a listener would lean in.",
    "Be honest about lows too: turns with no specifics, no friction, no callbacks, AND filler should land at 3-4 — that's the signal we need to hear.",
    "Be strict on rule compliance. The CheckEval pattern works because judges err on the side of 'no' when something is borderline — that's the signal."
  ].join("\n");
}

function buildEvalUserPayload(input: EvalInput) {
  return {
    momentContext: input.momentContext,
    availableSources: input.availableSources,
    recentCommentary: input.recentCommentary.slice(0, 4),
    turn: input.text
  };
}

const TRACKED_RULE_IDS = [
  "friction_quota",
  "steel_man_two_step",
  "direct_listener_answer",
  "turn_shape_payload",
  "no_transition_filler"
] as const;

export function parseEvalOutput(raw: string, turnId: string): TurnEvaluation {
  const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(cleaned) as {
    scores?: Record<string, unknown>;
    stayTuned?: unknown;
    rationale?: unknown;
    ruleCompliance?: unknown;
  };
  const dims: EvalDimension[] = ["specificity", "friction", "callbacks", "pacing", "anti_genericity"];
  const scores: Record<EvalDimension, number> = {
    specificity: clampScore(parsed.scores?.specificity),
    friction: clampScore(parsed.scores?.friction),
    callbacks: clampScore(parsed.scores?.callbacks),
    pacing: clampScore(parsed.scores?.pacing),
    anti_genericity: clampScore(parsed.scores?.anti_genericity)
  };
  // Voiding the unused-var lint warning by referencing dims for the
  // schema-completeness check — every dim must appear in scores.
  for (const d of dims) {
    if (typeof scores[d] !== "number") throw new Error(`Eval missing dimension: ${d}`);
  }
  const stayTuned = clampScore(parsed.stayTuned);
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
  // ruleCompliance parsing is defensive — the judge LLM may omit it,
  // include rules out of order, or invent extra ones. We accept the
  // valid subset and ignore the rest. Missing rules → field omitted
  // entirely (rather than synthetically marked n/a) so the harness
  // distinguishes "judge didn't return ruleCompliance" from "judge
  // explicitly said n/a." Old evaluations (pre-v2 judge prompt) keep
  // working since the field is optional on TurnEvaluation.
  const rawRules = Array.isArray(parsed.ruleCompliance) ? parsed.ruleCompliance : [];
  const ruleCompliance: RuleComplianceCheck[] = [];
  for (const entry of rawRules) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as { ruleId?: unknown; fired?: unknown; evidence?: unknown };
    const ruleId = typeof r.ruleId === "string" ? r.ruleId : "";
    if (!TRACKED_RULE_IDS.includes(ruleId as (typeof TRACKED_RULE_IDS)[number])) continue;
    const fired = r.fired === "yes" || r.fired === "no" || r.fired === "n/a" ? r.fired : "n/a";
    const evidence = typeof r.evidence === "string" ? r.evidence.trim().slice(0, 200) : "";
    ruleCompliance.push({
      ruleId: ruleId as RuleComplianceCheck["ruleId"],
      fired: fired as RuleComplianceCheck["fired"],
      evidence
    });
  }
  return {
    turnId,
    evaluator: ID,
    scores,
    stayTuned,
    rationale: rationale || "(no rationale provided)",
    evaluatedAt: new Date().toISOString(),
    ruleCompliance: ruleCompliance.length > 0 ? ruleCompliance : undefined
  };
}

function clampScore(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(10, Math.round(num * 10) / 10));
}

async function safeReadError(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.slice(0, 240);
  } catch {
    return response.statusText;
  }
}
