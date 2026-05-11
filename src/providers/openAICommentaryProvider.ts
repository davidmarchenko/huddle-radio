import OpenAI from "openai";
import type { CommentaryKind, DialogueLine, HostId, ProviderHealth } from "../shared/contracts";
import {
  buildCommentaryPayload,
  buildOpenerSystemPrompt,
  buildPlaySystemPrompt,
  joinDialogueLines,
  parseDialogueResponse,
  resolveHostPersona,
  sanitizeCommentary,
  type CommentaryDraftInput
} from "./commentaryPrompts";

export type { CommentaryDraftInput } from "./commentaryPrompts";

export interface CommentaryProvider {
  id: string;
  /**
   * Generate one TURN of multi-speaker dialogue. Returns ≥1 lines.
   * The first line's `hostId` is always `input.hostId` (the lead host
   * picked by the engine's host selector). Subsequent lines may
   * route to other hosts as the LLM's dialogue dictates.
   *
   * On any failure (parse error, model unavailable, key missing) the
   * provider returns a single-line fallback so the engine never has
   * to handle an empty array.
   */
  draft(input: CommentaryDraftInput): Promise<DialogueLine[]>;
  health(): Promise<ProviderHealth>;
}

/**
 * Wrap a single block of fallback text in the dialogue shape so the
 * engine has a uniform contract to consume. Used by the local
 * provider AND by the OpenAI provider when the LLM response can't be
 * parsed as multi-speaker JSON.
 */
function fallbackDialogue(text: string, hostId: HostId): DialogueLine[] {
  return [{ hostId, text: sanitizeCommentary(text, text) }];
}

export class LocalCommentaryProvider implements CommentaryProvider {
  id = "local-commentary";

  async draft(input: CommentaryDraftInput): Promise<DialogueLine[]> {
    const leadHostId = input.hostId ?? "theo";
    const lines = buildLocalDialogue(input, leadHostId);
    if (lines.length === 0) {
      return fallbackDialogue(input.fallbackText, leadHostId);
    }
    return lines;
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Local Commentary",
      status: "ready",
      detail: "Using deterministic local commentary templates with multi-speaker rotation."
    };
  }
}

/**
 * Deterministic multi-speaker dialogue used when every LLM in the chain
 * is unavailable (quota, network, missing keys). Three short lines that
 * rotate the lead host, a contextual color line, and a reactor — so the
 * show still feels like a two-or-three person podcast instead of one
 * person monologuing.
 *
 * The contracts are intentionally narrow: never quotes raw input verbatim
 * (would let upstream junk leak into TTS), routes the second/third lines
 * to peers of the lead (rotation feels conversational), and pulls color
 * from whichever signal happens to be richest this turn (odds, markets,
 * fantasy impact, listener cue). The fallbackText is always a viable
 * single-line replacement if every signal is empty.
 */
function buildLocalDialogue(input: CommentaryDraftInput, leadHostId: HostId): DialogueLine[] {
  const peers = pickPeers(leadHostId);
  const listenerName = input.group.listener.name;
  const kind = input.kind ?? "play";

  if (kind === "opener") {
    const team = input.listenerRoster?.teamName ?? "your team";
    const starterSummary = (input.listenerRoster?.starters ?? [])
      .slice(0, 2)
      .map((s) => `${s.name} at ${s.position}`)
      .join(" and ");
    const matchupBlurb = describeMatchup(input);
    const oddsBlurb = describeOdds(input);
    const lines: DialogueLine[] = [
      { hostId: leadHostId, text: clip(`${listenerName}, welcome in. ${team} is rolling${starterSummary ? ` with ${starterSummary}` : ""}.`) },
      { hostId: peers[0], text: clip(matchupBlurb || "We've got a live one ahead — let's get into it.") }
    ];
    if (oddsBlurb) lines.push({ hostId: peers[1], text: clip(oddsBlurb) });
    return lines;
  }

  // Play turn. Lead does the call, peer 1 adds color, peer 2 reacts.
  const callBlurb = describePlay(input);
  const colorBlurb = pickColorLine(input);
  const reactorBlurb = pickReactor(input, listenerName);

  const lines: DialogueLine[] = [];
  if (callBlurb) lines.push({ hostId: leadHostId, text: clip(callBlurb) });
  if (colorBlurb) lines.push({ hostId: peers[0], text: clip(colorBlurb) });
  if (reactorBlurb) lines.push({ hostId: peers[1], text: clip(reactorBlurb) });
  return lines;
}

const HOST_ORDER: HostId[] = ["theo", "maya", "cam"];

function pickPeers(lead: HostId): [HostId, HostId] {
  const idx = HOST_ORDER.indexOf(lead);
  return [HOST_ORDER[(idx + 1) % 3], HOST_ORDER[(idx + 2) % 3]];
}

function clip(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}

function describeMatchup(input: CommentaryDraftInput): string {
  const team = input.play.team;
  if (!team) return "";
  return `${team} is on the field, and there's plenty riding on this one.`;
}

function describeOdds(input: CommentaryDraftInput): string {
  const odds = input.odds;
  if (!odds) return "";
  if (typeof odds.spread === "number") {
    // Positive spread = home favored, negative = away favored.
    const favorite = odds.spread > 0 ? odds.homeTeam : odds.awayTeam;
    return `Vegas has ${favorite} laying ${Math.abs(odds.spread)}.`;
  }
  if (typeof odds.total === "number") return `Total is sitting at ${odds.total}.`;
  return "";
}

function describePlay(input: CommentaryDraftInput): string {
  const desc = input.play.description?.trim();
  if (desc) {
    const quarter = input.play.quarter ? `${input.play.quarter}` : "";
    const clock = input.play.clock ? `${input.play.clock}` : "";
    const prefix = [quarter, clock].filter(Boolean).join(", ");
    return prefix ? `${prefix}: ${desc}.` : `${desc}.`;
  }
  return input.fallbackText;
}

function pickColorLine(input: CommentaryDraftInput): string {
  const swing = input.marketSwing;
  if (swing) {
    const dir = swing.direction === "warming" ? "warming up" : "cooling off";
    return `Market just moved — ${swing.market.title} ${dir} ${Math.abs(swing.deltaCents)} cents.`;
  }
  const impact = input.impacts.find((i) => Math.abs(i.pointsDelta) >= 0.5);
  if (impact) {
    const sign = impact.pointsDelta > 0 ? "+" : "";
    return `That's ${sign}${impact.pointsDelta.toFixed(1)} fantasy${impact.playerName ? ` for ${impact.playerName}` : ""}.`;
  }
  if (input.listenerCues && input.listenerCues.length > 0) {
    return `Quick callback to your question — we're tracking it.`;
  }
  const market = input.markets?.[0];
  if (market) {
    return `${market.source === "kalshi" ? "Kalshi" : "Polymarket"} pricing ${market.outcomeLabel ?? market.title} at ${market.yesPriceCents} cents right now.`;
  }
  const headline = input.news[0]?.title;
  if (headline) return `Worth flagging: ${headline}.`;
  return "";
}

function pickReactor(input: CommentaryDraftInput, listenerName: string): string {
  const playType = input.play.type;
  if (playType === "touchdown") return `Big one. ${listenerName}'s board just shifted.`;
  if (playType === "field-goal") return "Field goal's on the board.";
  if (playType === "turnover") return "Field flipped. That changes the math.";
  if (playType === "first-down") return "Move the sticks.";
  if (playType === "rush") return "Run game's doing work.";
  if (playType === "pass") return "Through the air there.";
  if (input.play.excitement && input.play.excitement >= 4) return "That's a big play.";
  return "We'll see how this drive shapes up.";
}

export class OpenAICommentaryProvider implements CommentaryProvider {
  id = "openai-commentary";
  private readonly client?: OpenAI;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model = "gpt-5.2",
    private readonly reasoningEffort: "none" | "low" | "medium" | "high" = "none"
  ) {
    this.client = apiKey ? new OpenAI({ apiKey }) : undefined;
  }

  async draft(input: CommentaryDraftInput): Promise<DialogueLine[]> {
    const leadHostId = input.hostId ?? "theo";
    if (!this.client) {
      return fallbackDialogue(input.fallbackText, leadHostId);
    }

    const persona = resolveHostPersona(leadHostId);
    const kind: CommentaryKind = input.kind ?? "play";

    // Higher token budget than the old single-line path: 5-7 short
    // lines (opener) or 3-5 short lines (play) plus JSON scaffolding
    // round-trips at ~500-700 tokens. Still well under the response
    // ceiling and keeps latency tight at flash-TTS pace.
    const response = await this.client.responses.create({
      model: this.model,
      max_output_tokens: kind === "opener" ? 700 : 500,
      reasoning: this.model.startsWith("gpt-5") ? { effort: this.reasoningEffort } : undefined,
      instructions: kind === "opener" ? buildOpenerSystemPrompt(persona) : buildPlaySystemPrompt(persona),
      input: JSON.stringify(buildCommentaryPayload(input, persona))
    });

    const raw = response.output_text.trim();
    const parsed = parseDialogueResponse(raw, leadHostId);
    if (parsed && parsed.length > 0) {
      // Final guard on the joined transcript so the credential filter
      // still catches anything slipped past the per-line sanitizer.
      const joined = joinDialogueLines(parsed);
      const safe = sanitizeCommentary(joined, input.fallbackText);
      // sanitizeCommentary returns the fallback verbatim when it
      // detects credentials — in that case we discard the dialogue
      // and fall back to a single-line response.
      if (safe === input.fallbackText) {
        return fallbackDialogue(input.fallbackText, leadHostId);
      }
      return parsed;
    }
    // Unparseable response: try to recover the raw text as a single line
    // so the listener still hears something rather than silence.
    if (raw) {
      return fallbackDialogue(sanitizeCommentary(raw.replace(/\s+/g, " "), input.fallbackText), leadHostId);
    }
    return fallbackDialogue(input.fallbackText, leadHostId);
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "OpenAI Commentary",
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey ? `Configured for ${this.model} via the Responses API with reasoning=${this.reasoningEffort}.` : "Set OPENAI_API_KEY and COMMENTARY_PROVIDER=openai to enable."
    };
  }
}
