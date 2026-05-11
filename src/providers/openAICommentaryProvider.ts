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
    return fallbackDialogue(input.fallbackText, input.hostId ?? "theo");
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Local Commentary",
      status: "ready",
      detail: "Using deterministic local commentary templates."
    };
  }
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
