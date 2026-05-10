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

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { message?: string };
};

/**
 * Tertiary commentary path. Same persona prompts and JSON payload as
 * the other providers — falls through transparently from the chain
 * when OpenAI and Anthropic are both unavailable.
 */
export class GeminiCommentaryProvider implements CommentaryProvider {
  id = "gemini-commentary";

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model = "gemini-1.5-pro",
    private readonly fetcher: Fetcher = fetch
  ) {}

  async draft(input: CommentaryDraftInput): Promise<string> {
    if (!this.apiKey) return input.fallbackText;

    const persona = resolveHostPersona(input.hostId);
    const kind: CommentaryKind = input.kind ?? "play";
    const system = kind === "opener" ? buildOpenerSystemPrompt(persona) : buildPlaySystemPrompt(persona);
    const payload = buildCommentaryPayload(input, persona);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
        generationConfig: {
          maxOutputTokens: kind === "opener" ? 320 : 200,
          temperature: 0.8
        }
      })
    });

    if (!response.ok) {
      const message = await safeReadError(response);
      throw new Error(`Gemini commentary request failed: ${response.status} ${message}`);
    }

    const json = (await response.json()) as GeminiResponse;
    if (json.error?.message) throw new Error(`Gemini error: ${json.error.message}`);
    const text = (json.candidates ?? [])
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
    return sanitizeCommentary(text || input.fallbackText, input.fallbackText);
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Gemini Commentary",
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey ? `Configured for ${this.model} via the Gemini generateContent API.` : "Set GOOGLE_API_KEY to enable as a commentary fallback."
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
