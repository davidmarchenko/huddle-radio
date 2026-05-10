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

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { message?: string };
};

/**
 * Gemini generateContent as the tertiary vision-validation path. Sends
 * the captured frame as inline base64 with the same task payload as the
 * other providers, so the resilience chain can fall through transparently.
 */
export class GeminiVisionModelProvider implements MultimodalModelProvider {
  id = "gemini-vision-model";

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model = "gemini-1.5-pro",
    private readonly fetcher: Fetcher = fetch
  ) {}

  async observe(input: { video: VideoSourceConfig; play: SportsPlay; frame?: VideoFrameSnapshot }): Promise<VideoObservation> {
    const start = performance.now();
    const unavailable = unavailableObservation(input.video, input.frame, start);
    if (!this.apiKey || !input.frame || input.frame.blockedReason) return unavailable;

    try {
      const { mediaType, data } = dataUrlToBase64(input.frame.dataUrl);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
      const response = await this.fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: VISION_INSTRUCTIONS }] },
          contents: [
            {
              role: "user",
              parts: [
                { inline_data: { mime_type: mediaType, data } },
                { text: buildVisionTaskPayload(input.play) }
              ]
            }
          ],
          generationConfig: { maxOutputTokens: 320, temperature: 0.2 }
        })
      });

      if (!response.ok) {
        const message = await safeReadError(response);
        throw new Error(`Gemini vision request failed: ${response.status} ${message}`);
      }

      const json = (await response.json()) as GeminiResponse;
      if (json.error?.message) throw new Error(`Gemini error: ${json.error.message}`);
      const text = (json.candidates ?? [])
        .flatMap((candidate) => candidate.content?.parts ?? [])
        .map((part) => part.text ?? "")
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
      label: "Gemini Vision Model",
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey ? `Configured for frame validation with ${this.model}.` : "Set GOOGLE_API_KEY to enable Gemini vision fallback."
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
