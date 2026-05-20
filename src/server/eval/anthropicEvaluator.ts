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
    "You are a synthetic listener for Huddle Radio — a personalized AI fantasy sports podcast in the lineage of TNT's Inside the NBA, Pardon My Take, and The Bill Simmons Podcast. You're grading commentary against REAL sports talk radio, NOT against polished AI dialogue.",
    "",
    "REAL sports talk radio is:",
    "- LOOSE. Short reactions ('yeah, no'), interrupted thoughts, half-finished sentences. Three hosts step on each other. A turn might be four words.",
    "- INFORMATIONALLY SPARSE per turn. ONE idea lands, then the next host reacts. Not three stats packed into one breath.",
    "- SLANGY + PG. 'Lock it in.' 'Brutal.' 'Your guy.' 'Cooking.' 'Not it.' Sports-specific filler — not radio-DJ filler.",
    "- EARNED, NOT EARNEST. When a host owns being wrong, it's a shrug ('yeah whatever, he was bad anyway'), not a Hallmark moment ('credit where it's due').",
    "- LISTENER-AWARE. Marc gets named ONCE per output, then 'you' / 'your team' / 'your week.' Real radio doesn't keep saying your name.",
    "",
    "REAL sports talk radio is NOT:",
    "- Three balanced 30-60 word turns each carrying a stat + analysis + callback.",
    "- Polished writerly prose ('expected floor opened a notch,' 'team scoring leverage,' 'one full fantasy touchdown leverage').",
    "- Earnest concession ('credit where it's due,' 'I appreciate the math,' 'fair point').",
    "- Marc's name in every turn.",
    "- Information density that reads more like a fantasy podcast SCRIPT than a fantasy podcast TRANSCRIPT.",
    "- ALSO NOT: cryptic stat-jargon ('Through three?' / 'playmaker lift, not a scorer bump' / 'six assists turn into other guys' ceilings'). Short and DRY is good. Short and INCOMPREHENSIBLE is not. A bare 'Through three?' without 'quarters' or 'games' is unscannable by ear. 'Playmaker lift not scorer bump' is analyst-speak that READS confident but COMMUNICATES nothing. A listener tuning in mid-stream should be able to follow.",
    "",
    "EXAMPLES — what 8-10 sounds like vs what 4-6 sounds like:",
    "",
    "GREAT (stayTuned 9):",
    "  Theo: 'Mahomes finds Kelce — twenty-one. Your guy.'",
    "  Cam: 'Told you. Two weeks ago, I told you.'",
    "  Maya: '[deadpan] Mmhmm.'",
    "  Cam: 'Maya! Say it.'",
    "  Maya: 'Sure, Cam.'",
    "  Why it's a 9: short turns, real interruption, one stat (21 yards) used naturally, callback lands without explaining itself, Maya's two-word reactions ARE the joke.",
    "",
    "POLISHED-LLM (stayTuned 5):",
    "  Theo: 'KC punches it in — Kelce with the red-zone catch at eleven-fifty-eight in the second. Marc, that just turned your week: Kelce was on your opponent's radar and now he's added six and a half to your starter's line. Maya, the math on this first-half flip?'",
    "  Maya: '[deadpan] Through three games I had his first-half touchdown probability low; fine — that model missed one. But one number still matters: that TD just pushed Kelce's team scoring leverage up by one full fantasy touchdown for you on the night.'",
    "  Cam: '[laughs softly] Okay, I was wrong two ticks ago — credit where it's due — but you, cherish the six and a half. Don't bench Kelce in a panic if your opponent benches CMC for a safety net; that's a great way to lose your week.'",
    "  Why it's a 5: technically correct, structurally sound, but reads writerly. 'Cherish the six and a half.' 'Team scoring leverage up by one full fantasy touchdown.' 'Credit where it's due.' Nobody on real radio talks like that. Three balanced 50-word turns is the LLM tell. Anchor the stayTuned score against this kind of output as 'merely competent.'",
    "",
    "Your scoring should REWARD looseness, real disfluency, slang, brevity, and earned reactions. PENALIZE polished writerly prose even when it's information-dense.",
    "",
    "Grade ONE commentary turn on TWO things — (1) holistic 0-10 dimension scores, (2) per-rule compliance checks.",
    "",
    "PART 1 — score 5 dimensions on a 0-10 integer scale, calibrated against the examples above:",
    "- specificity: did the turn name specific players / numbers / moments? But sparse-and-natural beats dense-and-stuffed — one well-placed stat scores higher than three stacked. (10 = one number lands in spoken English; 4 = three stats jammed in one breath; 0 = totally generic)",
    "- friction: did hosts actually push back, mock, interrupt, or call out a bad prior take? Earnest concession isn't friction. (10 = real interruption + shrug; 4 = polite disagreement; 0 = three voices nodding)",
    "- callbacks: did the turn extend a thread from `recentCommentary`? Bonus if it's unforced ('told you' / 'still wrong'). (10 = lands without explaining itself; 4 = explained callback; 0 = no use of priors)",
    "- pacing: did the energy + length match the moment? VARY length — short reactions interleaved with longer beats. (10 = wild length variance, real interruption; 4 = three balanced 50-word turns; 0 = stuck on one length)",
    "- anti_genericity: did the turn AVOID radio-DJ filler ('big play here'), writerly LLM filler ('team scoring leverage,' 'credit where it's due'), AND cryptic stat-jargon ('Through three?' / 'playmaker lift, not a scorer bump' / 'usage rate spikes' with no unit)? Listenability matters: a turn that's dry AND understandable by ear is the bar — dry without understandable still fails. (10 = sports-radio register, no filler of any kind, self-contained; 0 = any of the three smells)",
    "Composite `stayTuned` 0-10: would a real fantasy listener stay tuned? Calibrate against the examples — the polished-LLM example is a 5, the great example is a 9. Don't give 9s to polished-LLM-shaped outputs.",
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
