import type { CommentaryKind, DialogueLine, ProviderHealth } from "../shared/contracts";
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

  async draft(input: CommentaryDraftInput): Promise<DialogueLine[]> {
    const leadHostId = input.hostId ?? "theo";
    if (!this.apiKey) return [{ hostId: leadHostId, text: input.fallbackText }];

    const persona = resolveHostPersona(leadHostId);
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
        // Same dialogue-shape budget as OpenAI: bigger than the legacy
        // single-line path because each turn is now 3-7 lines of JSON.
        max_tokens: kind === "opener" ? 800 : 600,
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
    const raw = (json.content ?? [])
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!)
      .join(" ")
      .trim();
    const parsed = parseDialogueResponse(raw, leadHostId);
    if (parsed && parsed.length > 0) {
      const joined = joinDialogueLines(parsed);
      const safe = sanitizeCommentary(joined, input.fallbackText);
      if (safe === input.fallbackText) {
        return [{ hostId: leadHostId, text: input.fallbackText }];
      }
      return parsed;
    }
    if (raw) {
      return [{ hostId: leadHostId, text: sanitizeCommentary(raw.replace(/\s+/g, " "), input.fallbackText) }];
    }
    return [{ hostId: leadHostId, text: input.fallbackText }];
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
