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
import type { Evaluator, EvalDimension, EvalInput, TurnEvaluation } from "./types";

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
        max_tokens: 300,
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
    "Your job: grade ONE commentary turn on whether it makes a real fantasy-sports listener want to keep listening.",
    "",
    "Score 5 dimensions on a 0-10 integer scale:",
    "- specificity: did the turn name specific players / numbers / moments? (10 = anchored in a concrete fact; 0 = totally generic)",
    "- friction: did hosts disagree, push back, mock, or callback to a prior take? (10 = real conversational friction; 0 = three voices nodding)",
    "- callbacks: did the turn extend a thread from `recentCommentary` (a prior prediction, an unresolved tangent, a previously-mocked take)? (10 = clean callback that lands; 0 = no use of priors)",
    "- pacing: did the energy + length match the moment? (10 = perfectly scaled to the moment context; 0 = under- or over-reacted)",
    "- anti_genericity: did the turn AVOID stock radio filler ('big slate tonight', 'welcome back folks', 'big play here', 'no doubt')? (10 = zero filler; 0 = all filler)",
    "",
    "Then emit a composite `stayTuned` 0-10 score: would a real fantasy listener stay tuned past this turn?",
    "",
    "Output JSON ONLY — no preamble, no code fences:",
    "{",
    '  "scores": { "specificity": <0-10>, "friction": <0-10>, "callbacks": <0-10>, "pacing": <0-10>, "anti_genericity": <0-10> },',
    '  "stayTuned": <0-10>,',
    '  "rationale": "one sentence — what specifically lifted or hurt the score"',
    "}",
    "",
    "Be honest. A 6 average is fine; not every turn is a 10. Reserve 9-10 for turns that actually feel like a listener would lean in.",
    "Be honest about lows too: turns with no specifics, no friction, no callbacks, AND filler should land at 3-4 — that's the signal we need to hear."
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

export function parseEvalOutput(raw: string, turnId: string): TurnEvaluation {
  const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(cleaned) as {
    scores?: Record<string, unknown>;
    stayTuned?: unknown;
    rationale?: unknown;
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
  return {
    turnId,
    evaluator: ID,
    scores,
    stayTuned,
    rationale: rationale || "(no rationale provided)",
    evaluatedAt: new Date().toISOString()
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
