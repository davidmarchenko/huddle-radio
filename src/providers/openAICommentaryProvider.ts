import OpenAI from "openai";
import type { CommentaryKind, DialogueLine, HostId, ProviderHealth } from "../shared/contracts";
import { formatPeriodLabel } from "../shared/period";
import {
  detectClarityIssues,
  joinDialogueLines,
  normalizeDeliveryTags,
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
   * OPTIONAL — true streaming variant. When the provider implements
   * this, the engine MAY consume turns as they arrive instead of
   * waiting for the full draft. Saves ~5-10s on opener latency
   * because TTS for line 1 can start before the LLM finishes
   * line 3.
   *
   * Yields DialogueLine values as soon as each complete turn object
   * lands in the streamed buffer. The consumer is expected to push
   * each line into TTS immediately.
   *
   * Falls back to .draft() (full-wait) for providers that don't
   * implement this — the engine checks for its presence.
   */
  draftStream?(input: CommentaryDraftInput, options?: { signal?: AbortSignal }): AsyncIterable<DialogueLine>;
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

/**
 * Greedy partial-JSON extractor for the streaming dialogue path.
 * Walks forward from `cursor` looking for complete `{speaker, text}`
 * turn objects inside the `"turns": [...]` array. Returns each fully-
 * closed object as it's found, plus the cursor position to resume
 * from on the next chunk.
 *
 * Brace-counting only — no real JSON parser. We need to support
 * partial buffers where the array hasn't closed and the most recent
 * object is still mid-stream. Handles strings + backslash escapes so
 * a brace inside a quoted text field doesn't bump the depth count.
 */
export function extractCompleteTurns(buffer: string, cursor: number): { turns: unknown[]; nextCursor: number } {
  // First time through, advance the cursor to just past the '['
  // that opens the turns array. After that, cursor points at the
  // position to resume from (just past the last closed object).
  //
  // Prefer to anchor on `"turns": [` so preamble keys like
  // `{"thinking": [...], "turns": [...]}` don't make us try to parse
  // the wrong array. The naive first-`[` anchor breaks for any JSON
  // that includes another array before the turns array — gpt-5-mini
  // has been observed inserting auxiliary keys.
  //
  // The "turns" key itself may also stream in piece by piece. If we
  // haven't seen the full `"turns": [` token yet, return empty and
  // wait — extractCompleteTurns is called again on the next chunk
  // with cursor still 0, so we re-try the anchor each time.
  if (cursor === 0) {
    const turnsMatch = buffer.match(/"turns"\s*:\s*\[/);
    let arrayOpen: number;
    if (turnsMatch && typeof turnsMatch.index === "number") {
      arrayOpen = turnsMatch.index + turnsMatch[0].length - 1;
    } else {
      // No `"turns":` key seen yet. Wait — DO NOT fall back to the
      // first `[`. If a model decides to emit a preamble array (e.g.
      // `{"meta": ["a", "b", ...], "turns": [...]}`), the first `[`
      // belongs to the meta array and parsing it as turn objects
      // pollutes the output with strings we can't coerce into
      // DialogueLines. Better to wait — if no `"turns":` ever
      // arrives, the streaming path yields nothing and the caller
      // falls back to parseDialogueResponse on the final
      // output_text.done text, which has its own schema-tolerance.
      return { turns: [], nextCursor: 0 };
    }
    cursor = arrayOpen + 1;
  }
  const turns: unknown[] = [];
  let pos = cursor;
  while (pos < buffer.length) {
    // Skip whitespace + commas between objects.
    while (pos < buffer.length && /[\s,]/.test(buffer[pos])) pos++;
    if (pos >= buffer.length) break;
    if (buffer[pos] === "]") {
      // Array closed. Advance cursor past it so we don't re-scan.
      return { turns, nextCursor: pos + 1 };
    }
    if (buffer[pos] !== "{") {
      // Unexpected char — likely partial token mid-write. Wait for
      // more buffer; don't advance cursor.
      break;
    }
    // Find the matching close brace, tracking strings + escapes.
    const objStart = pos;
    let depth = 1;
    let inString = false;
    let escape = false;
    let i = pos + 1;
    while (i < buffer.length && depth > 0) {
      const ch = buffer[i];
      if (escape) {
        escape = false;
      } else if (ch === "\\" && inString) {
        escape = true;
      } else if (ch === '"') {
        inString = !inString;
      } else if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      i++;
    }
    if (depth !== 0) {
      // Object isn't closed yet — wait for more buffer. Don't
      // advance cursor; this same object will be re-tested next chunk.
      break;
    }
    const objStr = buffer.slice(objStart, i);
    try {
      turns.push(JSON.parse(objStr));
    } catch {
      // Malformed object. Give up on streaming — caller falls back to
      // full-parse on the final buffer. Returning what we have so far.
      return { turns, nextCursor: pos };
    }
    pos = i;
  }
  return { turns, nextCursor: pos };
}

/**
 * Coerce one streamed JSON turn object into a DialogueLine. Mirrors
 * the same validation parseDialogueResponse does on the
 * non-streaming path: speaker must be a known host id, text must be
 * a non-empty string post-sanitization. Returns undefined to skip
 * the streamed turn cleanly (e.g. unknown speaker, empty text).
 */
function coerceStreamedTurn(raw: unknown, leadHostId: HostId): DialogueLine | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { speaker?: unknown; text?: unknown };
  const speakerRaw = typeof r.speaker === "string" ? r.speaker.toLowerCase() : "";
  const knownHosts: HostId[] = ["maya", "theo", "cam"];
  const hostId: HostId = (knownHosts as string[]).includes(speakerRaw)
    ? (speakerRaw as HostId)
    : leadHostId;
  const textRaw = typeof r.text === "string" ? r.text.trim() : "";
  if (textRaw.length === 0) return undefined;
  // Mirror coerceSingleTurn: hoist delivery tags to the front so
  // Inworld interprets them rather than reading them aloud. Tags stay
  // in line.text; the client strips them for display.
  return { hostId, text: normalizeDeliveryTags(textRaw) };
}

/**
 * Single-line warn log for any silent fallback path inside the
 * OpenAI commentary provider. Pre-this-helper, the provider fell
 * back to seed text in four places without logging — listeners
 * heard robot template output for hours with no signal anywhere
 * (no chain warning, no error event, no diagnostics entry) that
 * the LLM had silently stopped contributing. JSON-shaped so a
 * future log scraper can find these by event name.
 */
function logFallback(reason: string): void {
  console.warn(JSON.stringify({
    event: "commentary.provider.silent_fallback",
    providerId: "openai-commentary",
    reason
  }));
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
      // Empty listenerName would render as ", on your card —" — the
      // same leading-vocative bug the local opener fallback had.
      return listenerName.trim() ? `${listenerName}, on your card —` : "On your card —";
    case "listener":
      return listenerName.trim() ? `${listenerName}, back to your cue —` : "Back to your cue —";
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
      // Silent until now — fixed because the listener was hearing
      // the engine's raw template seed text and we had no signal
      // anywhere that the LLM wasn't running. Single concise log
      // per call so a misconfigured key surfaces immediately in the
      // server console instead of leaking robot dialogue.
      logFallback("openai-commentary: no API client configured (set OPENAI_API_KEY)");
      return fallbackDialogue(input.fallbackText, leadHostId);
    }

    const persona = resolveHostPersona(leadHostId);
    const kind: CommentaryKind = input.kind ?? "play";

    // Token budget tuned for two competing risks:
    //   - too low: gpt-5 family does reasoning by default and reasoning
    //     tokens come OUT of max_output_tokens. The eval harness caught
    //     gpt-5-mini consuming 576/600 tokens on reasoning alone and
    //     emitting zero output text (`incomplete: max_output_tokens`,
    //     outputItemTypes=["reasoning"]). Budget must be reasoning +
    //     actual response, not just response.
    //   - too high: latency scales with the cap when the model fills
    //     it — opener already pushes 10-15s on gpt-5-mini.
    // 4000/3000 leaves comfortable room for medium-effort reasoning
    // + the 3-7 dialogue turns the prompt asks for. Wall-clock impact
    // is bounded by the chain timeout (25s default) — if a turn
    // genuinely takes longer we want the chain to fall through, not
    // truncate the response into empty.
    const { system, payload } = selectCommentaryPrompt(input, persona, kind);
    // gpt-5-mini accepts reasoning.effort: "minimal" | "low" | "medium"
    // | "high" (NOT "none"). The user-facing "none" preset maps to
    // "minimal" for gpt-5-mini — the closest thing to no reasoning the
    // model accepts. Previously this passed reasoning=undefined, which
    // gpt-5-mini interpreted as medium effort, eating the entire
    // output budget on reasoning. For non-gpt-5 models the param is
    // omitted entirely (the old behavior).
    const effort: "minimal" | "low" | "medium" | "high" =
      this.reasoningEffort === "none" ? "minimal" : this.reasoningEffort;
    const reasoning = this.model.startsWith("gpt-5") ? { effort } : undefined;
    const response = await this.client.responses.create({
      model: this.model,
      max_output_tokens: kind === "opener" ? 4000 : 3000,
      reasoning,
      instructions: system,
      input: JSON.stringify(payload)
    });

    const raw = response.output_text.trim();
    // When raw is empty, surface the shape of the OpenAI response so
    // we can tell WHY — reasoning-token-only completion, content
    // filter, max-token cutoff before any text, etc. The diagnostic
    // is critical because the silent-fallback path used to ship
    // robotic seed text with no signal of root cause.
    if (raw.length === 0) {
      const r = response as unknown as {
        status?: string;
        usage?: { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number };
        incomplete_details?: { reason?: string };
        output?: Array<{ type?: string }>;
      };
      console.warn(JSON.stringify({
        event: "commentary.provider.empty_response_diagnostic",
        providerId: "openai-commentary",
        model: this.model,
        status: r.status,
        incompleteReason: r.incomplete_details?.reason,
        usage: r.usage,
        outputItemTypes: (r.output ?? []).map((o) => o.type)
      }));
    }
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
        logFallback("openai-commentary: credential filter detected secret-shaped tokens in LLM output");
        return fallbackDialogue(input.fallbackText, leadHostId);
      }
      // Clarity gate. The first-pass output passed the JSON parser
      // and credential filter — but does it actually sound like a
      // person talking? User feedback ("I can't understand what
      // they're talking about" — "Through three? Shai's usage rate
      // spikes at home") landed because the model produces dry/short
      // turns that omit the period qualifier or use analyst
      // shorthand. The clarity-judge prompt rule alone wasn't enough
      // for gpt-5-mini to consistently honor.
      //
      // Single deterministic retry: if heuristic flags issues, ship
      // a focused correction directive ("your last output had these
      // problems — rewrite the SAME content but fix each one"). If
      // the retry still flags issues, ship the retry anyway (better
      // than the original, and a second retry is diminishing
      // returns + 10s of added latency for an interview-prep show).
      const issues = detectClarityIssues(parsed);
      if (issues.length > 0) {
        console.warn(JSON.stringify({
          event: "commentary.provider.clarity_retry",
          providerId: "openai-commentary",
          model: this.model,
          issueCount: issues.length,
          issues
        }));
        const retried = await this.retryForClarity({
          originalText: joined,
          issues,
          system,
          payload,
          reasoning,
          maxOutputTokens: kind === "opener" ? 4000 : 3000,
          leadHostId,
          fallbackText: input.fallbackText,
          listenerName: input.group.listener.name
        });
        if (retried) return retried;
      }
      return parsed;
    }
    // Unparseable response: try to recover the raw text as a single line
    // so the listener still hears something rather than silence.
    if (raw) {
      logFallback(`openai-commentary: unparseable JSON, salvaging raw text (len=${raw.length})`);
      return fallbackDialogue(sanitizeCommentary(raw.replace(/\s+/g, " "), input.fallbackText), leadHostId);
    }
    logFallback("openai-commentary: empty response from LLM");
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

  /**
   * Streaming variant of draft(). Yields each complete turn as soon
   * as its JSON object closes in the streamed buffer — engine pipes
   * directly into per-line TTS. Saves ~5-10s on opener latency.
   *
   * Does NOT run the clarity retry (the retry needs the full output
   * + a second LLM round-trip, which would defeat the streaming
   * speedup). The streaming path is for opener/first-impression
   * latency; the clarity retry path is for the synchronous .draft()
   * call where a second pass is acceptable. Tick commentary uses
   * .draft() so it still benefits from the retry.
   *
   * Yields nothing and returns when:
   *   - No API client configured.
   *   - Stream fails mid-way (logs a fallback event so the engine
   *     can decide whether to retry full-draft).
   *   - JSON streamer can't extract a single valid turn from the
   *     finished buffer (model returned something we can't parse).
   */
  async *draftStream(
    input: CommentaryDraftInput,
    options?: { signal?: AbortSignal }
  ): AsyncIterable<DialogueLine> {
    if (!this.client) {
      logFallback("openai-commentary: no API client configured (set OPENAI_API_KEY)");
      return;
    }
    const leadHostId: HostId = input.hostId ?? "theo";
    const persona = resolveHostPersona(leadHostId);
    const kind: CommentaryKind = input.kind ?? "play";
    const { system, payload } = selectCommentaryPrompt(input, persona, kind);
    const effort: "minimal" | "low" | "medium" | "high" =
      this.reasoningEffort === "none" ? "minimal" : this.reasoningEffort;
    const reasoning = this.model.startsWith("gpt-5") ? { effort } : undefined;
    let stream;
    try {
      // The OpenAI SDK accepts AbortSignal via the second-arg
      // request options. Threading it from the engine's `stopped`
      // flag means a listener disconnect server-aborts the stream
      // instead of letting it run to completion on our bill.
      stream = await this.client.responses.create(
        {
          model: this.model,
          max_output_tokens: kind === "opener" ? 4000 : 3000,
          reasoning,
          instructions: system,
          input: JSON.stringify(payload),
          stream: true
        },
        options?.signal ? { signal: options.signal } : undefined
      );
    } catch (error) {
      logFallback(`openai-commentary: stream open failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let buffer = "";
    let cursor = 0;
    let extracted = 0;
    // Some Responses API events emit a final `output_text.done` with
    // the canonical text. If the delta-only path missed any tokens
    // (or model didn't emit deltas at all — happens with very short
    // responses), we fall back to this text post-stream.
    let doneText: string | undefined;
    try {
      for await (const event of stream as AsyncIterable<{
        type: string;
        delta?: string;
        text?: string;
      }>) {
        if (options?.signal?.aborted) break;
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          buffer += event.delta;
          const result = extractCompleteTurns(buffer, cursor);
          cursor = result.nextCursor;
          for (const turn of result.turns) {
            extracted += 1;
            const line = coerceStreamedTurn(turn, leadHostId);
            if (line) yield line;
          }
        } else if (event.type === "response.output_text.done" && typeof event.text === "string") {
          doneText = event.text;
        }
      }
    } catch (error) {
      // Abort surfaces as an AbortError here; log and exit cleanly
      // without throwing — engine's draft() fallback handles empty
      // streams. Non-abort errors are logged at the same level so
      // operators see the signal.
      const msg = error instanceof Error ? error.message : String(error);
      const isAbort = options?.signal?.aborted || /aborted|cancel/i.test(msg);
      logFallback(
        `openai-commentary: stream loop ${isAbort ? "aborted" : "threw"}: ${msg}`
      );
      if (isAbort) return;
    }
    // If we extracted nothing from deltas, fall back to the canonical
    // done text (preferred) or the accumulated buffer. parseDialogueResponse
    // handles markdown fences, preamble keys, and other quirks the
    // streaming parser intentionally skips.
    if (extracted === 0) {
      const finalText = doneText && doneText.length > buffer.length ? doneText : buffer;
      if (finalText.trim().length > 0) {
        const parsed = parseDialogueResponse(finalText, leadHostId, input.group.listener.name);
        if (parsed && parsed.length > 0) {
          for (const line of parsed) yield line;
        } else {
          logFallback(
            `openai-commentary: stream finished with unextractable buffer (delta-len=${buffer.length}, done-len=${doneText?.length ?? 0})`
          );
        }
      }
    }
  }

  /**
   * One-shot rewrite pass that feeds the original output + a list
   * of detected clarity issues back to the model. The correction
   * directive is intentionally narrow — same content, same speakers,
   * same length budget, just fix the cited issues. Returns the
   * rewritten dialogue if parsing + sanitization succeed; returns
   * undefined to signal "keep the original" otherwise.
   *
   * Cost: one extra LLM round-trip per turn that fails clarity.
   * Heuristic precision matters — if detectClarityIssues fires on
   * everything we'd double every show's latency. The rules in
   * detectClarityIssues are tuned narrow on purpose.
   */
  private async retryForClarity(args: {
    originalText: string;
    issues: string[];
    system: string;
    payload: object;
    reasoning: { effort: "minimal" | "low" | "medium" | "high" } | undefined;
    maxOutputTokens: number;
    leadHostId: HostId;
    fallbackText: string;
    listenerName: string;
  }): Promise<DialogueLine[] | undefined> {
    if (!this.client) return undefined;
    const correctionInstructions = [
      args.system,
      "",
      "CLARITY REWRITE DIRECTIVE — your previous draft had these issues. Rewrite the SAME content (same speakers, same beats, same length budget) with each issue corrected:",
      ...args.issues.map((issue) => `- ${issue}`),
      "",
      "Your previous draft (for reference; do not copy verbatim — rewrite the affected phrases):",
      args.originalText,
      "",
      "Return the corrected dialogue in the same JSON schema. Do not acknowledge this directive in the output text."
    ].join("\n");
    try {
      const response = await this.client.responses.create({
        model: this.model,
        max_output_tokens: args.maxOutputTokens,
        reasoning: args.reasoning,
        instructions: correctionInstructions,
        input: JSON.stringify(args.payload)
      });
      const raw = response.output_text.trim();
      if (raw.length === 0) return undefined;
      const parsed = parseDialogueResponse(raw, args.leadHostId, args.listenerName);
      if (!parsed || parsed.length === 0) return undefined;
      const joined = joinDialogueLines(parsed);
      const safe = sanitizeCommentary(joined, args.fallbackText);
      if (safe === args.fallbackText) return undefined;
      return parsed;
    } catch (error) {
      console.warn(JSON.stringify({
        event: "commentary.provider.clarity_retry.failed",
        providerId: "openai-commentary",
        message: error instanceof Error ? error.message : String(error)
      }));
      return undefined;
    }
  }
}
