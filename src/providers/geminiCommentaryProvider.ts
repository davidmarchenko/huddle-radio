import type { CommentaryKind, DialogueLine, ProviderHealth } from "../shared/contracts";
import {
  joinDialogueLines,
  parseDialogueResponse,
  resolveHostPersona,
  sanitizeCommentary,
  selectCommentaryPrompt,
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

  async draft(input: CommentaryDraftInput): Promise<DialogueLine[]> {
    const leadHostId = input.hostId ?? "theo";
    if (!this.apiKey) return [{ hostId: leadHostId, text: input.fallbackText }];

    const persona = resolveHostPersona(leadHostId);
    const kind: CommentaryKind = input.kind ?? "play";
    const { system, payload } = selectCommentaryPrompt(input, persona, kind);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
        generationConfig: {
          // Bigger budget than the legacy single-line path: each turn
          // is now 3-7 short lines of JSON.
          maxOutputTokens: kind === "opener" ? 800 : 600,
          temperature: 0.8,
          // Force JSON output so we can parse the dialogue reliably.
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      const message = await safeReadError(response);
      throw new Error(`Gemini commentary request failed: ${response.status} ${message}`);
    }

    const json = (await response.json()) as GeminiResponse;
    if (json.error?.message) throw new Error(`Gemini error: ${json.error.message}`);
    const raw = (json.candidates ?? [])
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join(" ")
      .trim();
    const parsed = parseDialogueResponse(raw, leadHostId, input.group.listener.name);
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
