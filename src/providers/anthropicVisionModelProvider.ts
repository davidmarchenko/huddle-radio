import type { MultimodalModelProvider, ProviderHealth, SportsPlay, VideoFrameSnapshot, VideoObservation, VideoSourceConfig } from "../shared/contracts";
import {
  buildFailedObservation,
  buildSuccessfulObservation,
  buildVisionTaskPayload,
  dataUrlToBase64,
  parseVisionPayload,
  unavailableObservation,
  VISION_INSTRUCTIONS
} from "./visionShared";

type Fetcher = typeof fetch;

type AnthropicResponse = {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
};

/**
 * Anthropic Messages API as a vision-validation backup. Same task
 * payload as the OpenAI provider so the chain can fall through
 * transparently. Image is sent as base64 inline `image/source` content.
 */
export class AnthropicVisionModelProvider implements MultimodalModelProvider {
  id = "anthropic-vision-model";
  private readonly endpoint = "https://api.anthropic.com/v1/messages";

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model = "claude-sonnet-4-6",
    private readonly fetcher: Fetcher = fetch
  ) {}

  async observe(input: { video: VideoSourceConfig; play: SportsPlay; frame?: VideoFrameSnapshot }): Promise<VideoObservation> {
    const start = performance.now();
    const unavailable = unavailableObservation(input.video, input.frame, start);
    if (!this.apiKey || !input.frame || input.frame.blockedReason) return unavailable;

    try {
      const { mediaType, data } = dataUrlToBase64(input.frame.dataUrl);
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 320,
          system: VISION_INSTRUCTIONS,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data } },
                { type: "text", text: buildVisionTaskPayload(input.play) }
              ]
            }
          ]
        })
      });

      if (!response.ok) {
        const message = await safeReadError(response);
        throw new Error(`Anthropic vision request failed: ${response.status} ${message}`);
      }

      const json = (await response.json()) as AnthropicResponse;
      if (json.error?.message) throw new Error(`Anthropic error: ${json.error.message}`);
      const text = (json.content ?? [])
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text!)
        .join(" ");
      const payload = parseVisionPayload(text);
      return buildSuccessfulObservation(payload, { video: input.video, frame: input.frame }, start);
    } catch (error) {
      return buildFailedObservation(unavailable, error, start);
    }
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Anthropic Vision Model",
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey ? `Configured for frame validation with ${this.model}.` : "Set ANTHROPIC_API_KEY to enable Anthropic vision fallback."
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
