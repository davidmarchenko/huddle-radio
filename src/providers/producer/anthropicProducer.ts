/**
 * AnthropicProducer — the real, LLM-backed producer.
 *
 * Runs Claude Haiku 4.5 (fast, cheap, ~500-800ms p50) ahead of the
 * host LLM call. Reads the same payload the host would have read,
 * plus the running `priorShowState`, and emits a `ProducerDirective`
 * with 1-3 beats prioritized for THIS specific tick.
 *
 * Why a separate model:
 *   - The host's job is voice, character, friction. The producer's
 *     job is editorial selection. Different jobs deserve different
 *     prompts AND different models — Haiku is the right size for a
 *     "pick the 3 most important things to talk about" decision.
 *   - Running them sequentially adds latency but lets us shrink the
 *     host prompt dramatically (no more 60+ field-disposition rules)
 *     which both reduces cost and improves the host's adherence.
 *
 * Failure mode: throws. The caller (showEngine) catches and falls
 * back to LocalProducer (heuristic) so the show never goes silent.
 */

import type { ProviderHealth } from "../../shared/contracts";
import type { CommentaryDraftInput } from "../commentaryPrompts";
import type { ProducerAgent, ProducerDirective, ProducerInput } from "./types";

type Fetcher = typeof fetch;

type AnthropicResponse = {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
};

const ID = "anthropic-producer";
const LABEL = "Anthropic Producer";

export class AnthropicProducer implements ProducerAgent {
  id = ID;
  label = LABEL;
  private readonly endpoint = "https://api.anthropic.com/v1/messages";

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model = "claude-haiku-4-5-20251001",
    private readonly fetcher: Fetcher = fetch
  ) {}

  async produce(input: ProducerInput): Promise<ProducerDirective> {
    if (!this.apiKey) {
      throw new Error("AnthropicProducer: ANTHROPIC_API_KEY not configured");
    }
    const arcPosition = input.arcDirective?.position;

    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 500,
        system: buildProducerSystemPrompt(),
        messages: [{ role: "user", content: JSON.stringify(buildProducerUserPayload(input)) }]
      })
    });

    if (!response.ok) {
      const body = await safeReadError(response);
      throw new Error(`AnthropicProducer ${response.status}: ${body}`);
    }
    const json = (await response.json()) as AnthropicResponse;
    if (json.error?.message) throw new Error(`AnthropicProducer error: ${json.error.message}`);
    const raw = (json.content ?? [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join(" ")
      .trim();
    const parsed = parseProducerOutput(raw);
    // Carry the arc position into the directive so the host LLM
    // sees it via the directive payload — the host needs it to apply
    // arc-specific voice rules (pivot, climax, close, …).
    return arcPosition ? { ...parsed, arcPosition } : parsed;
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: ID,
      label: LABEL,
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey
        ? `Configured for ${this.model} via the Anthropic Messages API.`
        : "Set ANTHROPIC_API_KEY to enable the LLM producer."
    };
  }
}

function buildProducerSystemPrompt(): string {
  return [
    "You are the PRODUCER for Huddle Radio — a personalized AI fantasy sports podcast for one specific listener with three AI hosts (Maya, Theo, Cam).",
    "",
    "Hosts:",
    "- Maya: dry, stat-anchored, model-led. Good lead for numbers / matchup math / measured takes.",
    "- Theo: warm anchor, frames the moment, handles listener address, pushes back on hot/cold takes.",
    "- Cam: confident hot-take guy, mocks the data, owns it when wrong. Good lead for price moves / friction / loud reactions.",
    "",
    "Your job each tick: read the raw payload + `priorShowState` and emit 1–3 ORDERED beats the hosts should deliver. You are the editorial brain — what's worth saying RIGHT NOW, in WHAT ORDER, and WHO leads each beat.",
    "",
    "Priority order when signals compete:",
    "1. Listener push-to-talk cue (always answer first if present).",
    "2. Market swing >5¢ (the news beat — the line moved).",
    "3. High-trust enrichment signal (nba-stats / mlb-stats / espn-news beats a generic fan reaction).",
    "4. Major/interrupt play moment (buzzer-beater, turnover, score-flip).",
    "5. Pregame angle hint (rotation through matchup math / odds / lineup outlook).",
    "6. The play itself (always available — the floor).",
    "",
    "Beat sourceKind options: 'play', 'market', 'news', 'enrichment', 'vision', 'picks', 'listener', 'callback', 'pregame', 'banter', 'handoff'.",
    "",
    "Vision color (signals with `source: \"vision\"` in enrichmentSignals) is the model literally watching the broadcast — bench reactions, body language, sideline drama. Treat it as first-party observation, not as third-party news. When a vision signal fits the moment, prefer it over generic crowd flavor: it grounds the show in what's ACTUALLY ON SCREEN.",
    "",
    "Use `callback` when `recentCommentary` has a thread worth extending (an earlier prediction now resolvable, a host's take that didn't age, a tangent worth landing). Callbacks are HIGH value — when one fits cleanly, prefer it over a generic reaction.",
    "",
    "Turn budget: small. 1 turn = quick reaction; 2 turns = back-and-forth; 3 turns = multi-host break (use sparingly, only on major / interrupt moments OR a swing big enough to merit panel reaction).",
    "",
    "showState: 1-3 sentences describing the show's running editorial state for the NEXT tick — what we just covered, what thread is open, who's leading. Don't quote the dialogue, summarize the editorial situation.",
    "",
    "If `arc` is set in the payload, treat it as the highest-level constraint. `arc.position` tells you which act of the show we're in (cold-open / build / mid-show / climax / act-break / pivot / close). `arc.dramaticCue` is the editorial framing for THIS tick. `arc.pivotRecommended === true` means the game is decided and you should counter-program — don't lead with the play.",
    "",
    "If `banterMode === true` in the payload, this is a SILENCE-FILLER tick — there's no new game action worth reacting to. Output ONLY beats with sourceKind `banter`. Anchor on the rapport state (open threads, running bits, who's been quiet). Low energy — this is room conversation, not a take. ONE or two beats max, short turnCount each.",
    "",
    "If `gamePivotMode` is set, the listener just SWITCHED GAMES mid-show. The broadcast is continuous — DO NOT close the show, DO NOT re-open. Output ONE beat with sourceKind 'handoff', turnCount 2: the lead host wraps the prior game in a single breath ('alright, that one's in the books') and tees up the new matchup. Lower energy than a tip — this is a structural transition, not a re-launch. `gamePivotMode.fromSummary` and `gamePivotMode.toSummary` carry what to name. Theo is the natural lead unless a host is forced.",
    "",
    "If `slate` is set in the payload, the show is in DISCOVERY mode — it's surveying tonight's whole slate, not bound to one game. The opener beat (when `openerMode` is also true) should reference `slate.totalGames` and `slate.starterGames` to signal breadth. After the opener, slate mode auto-pivots between games at game-end (the engine fires gamePivotMode for you); your tick-level beats stay anchored on the current game.",
    "",
    "If `openerMode === true`, this is the SHOW OPENER — the very first turn the listener will hear. The whole show pivots on whether they smile in the first 15 seconds. Output 2-3 beats:",
    "  • Beat 1 (turnCount 2): lead host frames the room — name the listener (AT MOST ONCE across the whole open), name their fantasy team, name the matchup (`play.team` is in the game), set tone. Avoid 'welcome back / welcome to.' sourceKind: 'play'.",
    "  • Beat 2 (turnCount 1-2): a different host pulls on the listener's lineup — `listener.starters` carries name/position/proTeam. Pick the headliner; find ONE angle (matchup, role, prediction). If starters is empty, pivot to the matchup itself; do NOT invent players. sourceKind: 'enrichment' if anchored to a starter, else 'play'.",
    "  • Beat 3 (turnCount 1, optional): close with a forward take that hands off into the live show. Cam-shaped energy. sourceKind: 'play'.",
    "Total open should fit ~45-60s of audio (sum of turnCounts ≤ 5).",
    "",
    "Output JSON ONLY — no preamble, no code fences:",
    "{",
    '  "beats": [',
    '    {"topic": "specific subject incl. names/numbers", "angle": "framing — callback / friction / push back / etc.", "leadHostId": "maya"|"theo"|"cam", "turnCount": 1|2|3, "sourceKind": "<one of the kinds above>"}',
    "  ],",
    '  "showState": "running editorial summary for next tick"',
    "}"
  ].join("\n");
}

/** Slim payload — we send the producer the same data the host LLM
 *  would receive in the legacy path, but stripped of fields the
 *  producer doesn't need to make editorial calls (e.g. full
 *  observation guardrails, full persona examples). */
function buildProducerUserPayload(input: ProducerInput) {
  const draft = input.draft;
  const arc = input.arcDirective;
  const roster = draft.listenerRoster;
  return {
    arc: arc
      ? {
          position: arc.position,
          pacing: arc.pacing,
          dramaticCue: arc.dramaticCue,
          pivotRecommended: arc.pivotRecommended
        }
      : null,
    banterMode: input.banterMode === true,
    openerMode: input.openerMode === true,
    gamePivotMode: input.gamePivotMode
      ? {
          fromSummary: input.gamePivotMode.fromSummary,
          toSummary: input.gamePivotMode.toSummary
        }
      : null,
    slate: draft.slateContext
      ? {
          totalGames: draft.slateContext.totalGames,
          starterGames: draft.slateContext.starterGames,
          upcomingHighlights: draft.slateContext.upcomingHighlights
        }
      : null,
    play: {
      id: draft.play.id,
      headline: draft.play.headline,
      description: draft.play.description,
      excitement: draft.play.excitement,
      team: draft.play.team
    },
    moment: draft.moment,
    listener: {
      name: draft.group.listener.name,
      favoriteTeam: draft.group.listener.favoriteTeam,
      // Roster only matters at the open — beyond that, the host LLM
      // gets the starters via the host-side payload. Keeping it slim
      // for tick payloads keeps the producer prompt focused.
      teamName: input.openerMode ? roster?.teamName ?? null : undefined,
      starters: input.openerMode
        ? (roster?.starters ?? []).slice(0, 6).map((p) => ({
            name: p.name,
            position: p.position,
            proTeam: p.proTeam
          }))
        : undefined
    },
    news: (draft.news ?? []).slice(0, 2).map((n) => ({ title: n.title, source: n.source })),
    odds: draft.odds ?? null,
    markets: (draft.markets ?? []).slice(0, 4).map((m) => ({
      title: m.title,
      outcome: m.outcomeLabel,
      yesCents: m.yesPriceCents,
      source: m.source
    })),
    marketSwing: draft.marketSwing
      ? {
          title: draft.marketSwing.market.title,
          outcome: draft.marketSwing.market.outcomeLabel,
          source: draft.marketSwing.market.source,
          deltaCents: draft.marketSwing.deltaCents,
          direction: draft.marketSwing.direction
        }
      : null,
    listenerCues: (draft.listenerCues ?? []).slice(0, 2).map((c) => ({ text: c.text })),
    pickContext: draft.pickContext ?? null,
    enrichmentSignals: (draft.enrichmentSignals ?? []).slice(0, 8).map((s) => ({
      source: s.source,
      kind: s.kind,
      text: s.text
    })),
    pregameAngleHint: draft.pregameAngleHint ?? null,
    recentCommentary: (draft.recentCommentary ?? []).slice(0, 4),
    priorShowState: input.priorShowState
  };
}

export function parseProducerOutput(raw: string): ProducerDirective {
  // Strip code fences if the model added them despite instructions.
  const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(cleaned) as { beats?: unknown[]; showState?: string };
  if (!parsed || !Array.isArray(parsed.beats)) {
    throw new Error("Producer output missing `beats` array");
  }
  const beats = parsed.beats
    .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
    .map((b) => normalizeBeat(b))
    .filter((b): b is NonNullable<typeof b> => b !== null);
  if (beats.length === 0) {
    throw new Error("Producer output produced no usable beats");
  }
  return {
    beats: beats.slice(0, 3) as ProducerDirective["beats"],
    showState: typeof parsed.showState === "string" ? parsed.showState : ""
  };
}

function normalizeBeat(b: Record<string, unknown>) {
  const validKinds = new Set([
    "play",
    "market",
    "news",
    "enrichment",
    "vision",
    "picks",
    "listener",
    "callback",
    "pregame",
    "banter",
    "handoff"
  ]);
  const validHosts = new Set(["maya", "theo", "cam"]);
  const topic = typeof b.topic === "string" ? b.topic.trim() : "";
  const angle = typeof b.angle === "string" ? b.angle.trim() : "";
  const sourceKind = typeof b.sourceKind === "string" && validKinds.has(b.sourceKind) ? b.sourceKind : "play";
  const leadHostId = typeof b.leadHostId === "string" && validHosts.has(b.leadHostId) ? b.leadHostId : "theo";
  let turnCount = Number(b.turnCount);
  if (!Number.isFinite(turnCount) || turnCount < 1) turnCount = 1;
  if (turnCount > 3) turnCount = 3;
  if (!topic) return null;
  return {
    topic,
    angle: angle || "deliver the topic in voice",
    leadHostId,
    turnCount: turnCount as 1 | 2 | 3,
    sourceKind
  } as const;
}

async function safeReadError(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.slice(0, 240);
  } catch {
    return response.statusText;
  }
}

// Re-export for the showFactories chain to discriminate.
export type { CommentaryDraftInput };
