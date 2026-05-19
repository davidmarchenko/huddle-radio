import OpenAI from "openai";
import type { CommentaryKind, DialogueLine, HostId, ProviderHealth } from "../shared/contracts";
import { formatPeriodLabel } from "../shared/period";
import {
  joinDialogueLines,
  parseDialogueResponse,
  resolveHostPersona,
  sanitizeCommentary,
  selectCommentaryPrompt,
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
    // Honor the producer's editorial choice when present — the chain
    // already paid the producer cost; throwing the directive away
    // here would mean the show lurches back to "ignore the room"
    // mode every time the LLM stack falls all the way through. Pull
    // the lead host + topic from the first beat and seed the local
    // template off them.
    const directive = input.directive;
    const directiveLeadHost = directive?.beats[0]?.leadHostId;
    const leadHostId = directiveLeadHost ?? input.hostId ?? "theo";
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
 * Deterministic multi-turn dialogue used when every LLM in the chain
 * is unavailable (quota, network, missing keys). Produces 1-2 full-thought
 * turns: the lead host holds the floor with the substance (play call +
 * one color beat + forward-looking landing), and a peer optionally adds
 * a second full thought when there's a strong secondary signal worth a
 * paragraph. Each turn is a complete paragraph spoken without
 * interruption — same contract as the LLM, just deterministic content.
 */
function buildLocalDialogue(input: CommentaryDraftInput, leadHostId: HostId): DialogueLine[] {
  const peerHostId = pickPeer(leadHostId);
  // Empty/whitespace name is legal — the demo "Listen to a sample"
  // flow starts without a profile, so listener.name is "". Templates
  // that previously interpolated raw `${listenerName}` produced ",
  // welcome in." and "'s board just shifted." Guard at the boundary
  // so every downstream template can assume a non-empty string.
  const rawListenerName = input.group.listener.name?.trim() ?? "";
  const listenerName = rawListenerName || "everyone";
  const hasListenerName = rawListenerName.length > 0;
  const kind = input.kind ?? "play";

  if (kind === "opener") {
    const team = input.listenerRoster?.teamName ?? "your team";
    const starterSummary = (input.listenerRoster?.starters ?? [])
      .slice(0, 2)
      .map((s) => `${s.name} at ${s.position}`)
      .join(" and ");
    const matchupBlurb = describeMatchup(input);
    const oddsBlurb = describeOdds(input);
    const leadTurn = clip(
      [
        hasListenerName ? `${rawListenerName}, welcome in.` : "Welcome in.",
        `${team} is rolling${starterSummary ? ` with ${starterSummary}` : ""}.`,
        matchupBlurb,
        "Let's get into it."
      ].filter(Boolean).join(" ")
    );
    const turns: DialogueLine[] = [{ hostId: leadHostId, text: leadTurn }];
    if (oddsBlurb) {
      turns.push({ hostId: peerHostId, text: clip(`${oddsBlurb} We're tracking it across the whole show.`) });
    }
    return turns;
  }

  // Play turn: lead host gets the substance (call + color + landing) as
  // ONE full thought. Peer adds a second turn only when there's a
  // genuinely meaningful market swing or listener cue worth a paragraph.
  //
  // CRITICAL: `directive.beats[].topic` is a WRITER'S BRIEF — written for
  // the LLM commentary path as steering ("Act-break reflection — what
  // we've seen this half + a callback to a host's earlier take"). It
  // is NEVER speakable copy. The local fallback used to clip the
  // topic straight into the spoken line, which leaked producer
  // instructions into the listener's TTS feed verbatim. We now ignore
  // the topic entirely and synthesize a short speakable opener off
  // `sourceKind` only. For non-play beats the rest of the paragraph
  // (color + reactor) carries the substance; the opener just
  // signals tone.
  const directiveBeat = input.directive?.beats[0];
  const call =
    directiveBeat && directiveBeat.sourceKind !== "play"
      ? speakableOpenerForSourceKind(directiveBeat.sourceKind, listenerName)
      : describePlay(input);
  const color = pickColorLine(input);
  const reactor = pickReactor(input, listenerName);
  const leadParagraph = [call, color, reactor].filter(Boolean).join(" ");
  if (!leadParagraph) return [];
  const turns: DialogueLine[] = [{ hostId: leadHostId, text: clip(leadParagraph) }];

  // Second turn — only fires when a market swing or listener cue is
  // present. Otherwise we stay with one turn; padding for the sake of
  // multi-host coverage is what made the show feel chatty.
  if (input.marketSwing) {
    const dir = input.marketSwing.direction === "warming" ? "warming up" : "cooling off";
    turns.push({
      hostId: peerHostId,
      text: clip(`That market move is real — ${input.marketSwing.market.title} ${dir} ${Math.abs(input.marketSwing.deltaCents)} cents on the move. Worth watching the rest of the drive.`)
    });
  } else if (input.listenerCues && input.listenerCues.length > 0) {
    turns.push({
      hostId: peerHostId,
      text: clip(`Quick callback to what you asked — we're tracking that thread and will weigh in once the next series settles.`)
    });
  }
  return turns;
}

const HOST_ORDER: HostId[] = ["theo", "maya", "cam"];
function pickPeer(lead: HostId): HostId {
  const idx = HOST_ORDER.indexOf(lead);
  return HOST_ORDER[(idx + 1) % HOST_ORDER.length];
}

function clip(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 600 ? `${cleaned.slice(0, 597)}...` : cleaned;
}

function describeMatchup(input: CommentaryDraftInput): string {
  const team = input.play.team?.trim();
  // Some fixtures (and a couple of real providers) use "—" as an
  // empty-marker for missing teams. Treat that the same as
  // undefined so we don't emit "— is on the field, ...".
  if (!team || team === "—" || team === "-") return "";
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

/**
 * Deterministic speakable opener keyed off the producer's beat
 * `sourceKind`. Used by the local fallback when the producer picked
 * a non-play beat (callback / banter / market / etc.) — the beat's
 * `topic` is a writer's brief and isn't safe to read aloud, so we
 * substitute a short, neutral lead-in here. The rest of the
 * paragraph (color line + reactor) carries the actual content.
 *
 * Returning "" is fine — the empty string drops out of the joined
 * paragraph and the listener just hears color + reactor.
 */
function speakableOpenerForSourceKind(
  kind: import("./producer/types").BeatSourceKind,
  listenerName: string
): string {
  switch (kind) {
    case "callback":
      return "Quick callback before we move on.";
    case "banter":
      return "Real quick on the room.";
    case "news":
      return "Worth flagging this one.";
    case "picks":
      return `${listenerName}, on your card —`;
    case "listener":
      return `${listenerName}, back to your cue —`;
    case "pregame":
      return "Setting the scene before tip.";
    case "handoff":
      return "Alright, that one's in the books — moving on.";
    case "market":
    case "enrichment":
    case "vision":
    case "play":
      // pickColorLine already speaks markets / impacts; describePlay
      // covers play; vision/enrichment have no safe deterministic
      // template, so we stay silent on the opener and let color carry.
      return "";
  }
}

function describePlay(input: CommentaryDraftInput): string {
  const desc = input.play.description?.trim();
  if (desc) {
    const quarter = formatPeriodLabel(input.play.period);
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
  // listenerName is normalized to "everyone" by buildLocalDialogue
  // when the listener is anonymous, so "everyone's board" reads
  // naturally instead of the broken "'s board" we used to emit.
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

    // Token budget covers 5-7 short lines (opener) or 3-5 short lines
    // (play) plus JSON scaffolding. Earlier caps (700/500) were tight
    // enough that ~3-turn play responses truncated mid-string —
    // parseDialogueResponse then failed, and the fallback path dumped
    // the raw JSON envelope as a single host line ("[cam] { \"turns\":
    // [{ \"speaker\": \"cam\", \"text\": ... }, ..." cut off
    // mid-word). The recovery was the broken artifact a listener
    // would hear. New caps give ~60% headroom on a busy 3-turn play
    // beat so the model can finish the JSON cleanly.
    const { system, payload } = selectCommentaryPrompt(input, persona, kind);
    // gpt-5-mini rejects `reasoning.effort: "none"` (only low/medium/
    // high) — so when the listener picked effort=none, omit the
    // reasoning param entirely. Reasoning-capable models (gpt-5.2)
    // fall back to their default behavior; non-reasoning variants
    // (gpt-5-mini with effort=none) don't 400 on an unsupported value.
    const reasoning =
      this.model.startsWith("gpt-5") && this.reasoningEffort !== "none"
        ? { effort: this.reasoningEffort }
        : undefined;
    const response = await this.client.responses.create({
      model: this.model,
      max_output_tokens: kind === "opener" ? 1100 : 800,
      reasoning,
      instructions: system,
      input: JSON.stringify(payload)
    });

    const raw = response.output_text.trim();
    const parsed = parseDialogueResponse(raw, leadHostId, input.group.listener.name);
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
