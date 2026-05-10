import OpenAI from "openai";
import type { CommentaryKind, ProviderHealth } from "../shared/contracts";
import {
  buildCommentaryPayload,
  buildOpenerSystemPrompt,
  buildPlaySystemPrompt,
  resolveHostPersona,
  sanitizeCommentary,
  type CommentaryDraftInput
} from "./commentaryPrompts";

export type { CommentaryDraftInput } from "./commentaryPrompts";

export interface CommentaryProvider {
  id: string;
  draft(input: CommentaryDraftInput): Promise<string>;
  health(): Promise<ProviderHealth>;
}

export class LocalCommentaryProvider implements CommentaryProvider {
  id = "local-commentary";

  async draft(input: CommentaryDraftInput): Promise<string> {
    return input.fallbackText;
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

  async draft(input: CommentaryDraftInput): Promise<string> {
    if (!this.client) {
      return input.fallbackText;
    }

    const persona = resolveHostPersona(input.hostId);
    const kind: CommentaryKind = input.kind ?? "play";

    const response = await this.client.responses.create({
      model: this.model,
      max_output_tokens: kind === "opener" ? 220 : 130,
      reasoning: this.model.startsWith("gpt-5") ? { effort: this.reasoningEffort } : undefined,
      instructions: kind === "opener" ? buildOpenerSystemPrompt(persona) : buildPlaySystemPrompt(persona),
      input: JSON.stringify(buildCommentaryPayload(input, persona))
    });

    const text = response.output_text.trim().replace(/\s+/g, " ");
    return sanitizeCommentary(text || input.fallbackText, input.fallbackText);
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
