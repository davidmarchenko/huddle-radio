import type { CommentaryKind, ProviderHealth } from "../shared/contracts";
import {
  buildCommentaryPayload,
  buildOpenerSystemPrompt,
  buildPlaySystemPrompt,
  resolveHostPersona,
  sanitizeCommentary,
  type CommentaryDraftInput
} from "./commentaryPrompts";
import type { CommentaryProvider } from "./openAICommentaryProvider";

type Fetcher = typeof fetch;

type AnthropicResponse = {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
};

/**
 * Backup commentary path when OpenAI is degraded or rate-limited.
 * Same persona prompts and JSON payload as the OpenAI provider — only
 * the vendor differs — so the chain can fall through transparently.
 */
export class AnthropicCommentaryProvider implements CommentaryProvider {
  id = "anthropic-commentary";
  private readonly endpoint = "https://api.anthropic.com/v1/messages";

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model = "claude-sonnet-4-6",
    private readonly fetcher: Fetcher = fetch
  ) {}

  async draft(input: CommentaryDraftInput): Promise<string> {
    if (!this.apiKey) return input.fallbackText;

    const persona = resolveHostPersona(input.hostId);
    const kind: CommentaryKind = input.kind ?? "play";
    const system = kind === "opener" ? buildOpenerSystemPrompt(persona) : buildPlaySystemPrompt(persona);
    const payload = buildCommentaryPayload(input, persona);

    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: kind === "opener" ? 320 : 200,
        system,
        messages: [{ role: "user", content: JSON.stringify(payload) }]
      })
    });

    if (!response.ok) {
      const message = await safeReadError(response);
      throw new Error(`Anthropic commentary request failed: ${response.status} ${message}`);
    }

    const json = (await response.json()) as AnthropicResponse;
    if (json.error?.message) throw new Error(`Anthropic error: ${json.error.message}`);
    const text = (json.content ?? [])
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!)
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
    return sanitizeCommentary(text || input.fallbackText, input.fallbackText);
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Anthropic Commentary",
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey ? `Configured for ${this.model} via the Anthropic Messages API.` : "Set ANTHROPIC_API_KEY to enable as a commentary fallback."
    };
  }
}

async function safeReadError(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.slice(0, 240);
  } catch {
    return response.statusText;
  }
}
