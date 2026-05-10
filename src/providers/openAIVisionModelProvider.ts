import OpenAI from "openai";
import type { MultimodalModelProvider, ProviderHealth, SportsPlay, VideoFrameSnapshot, VideoObservation, VideoSourceConfig } from "../shared/contracts";
import {
  buildFailedObservation,
  buildSuccessfulObservation,
  buildVisionTaskPayload,
  parseVisionPayload,
  unavailableObservation,
  VISION_INSTRUCTIONS
} from "./visionShared";

export { parseVisionPayload } from "./visionShared";

export class OpenAIVisionModelProvider implements MultimodalModelProvider {
  id = "openai-vision-model";
  private readonly client?: OpenAI;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model = "gpt-5.2"
  ) {
    this.client = apiKey ? new OpenAI({ apiKey }) : undefined;
  }

  async observe(input: { video: VideoSourceConfig; play: SportsPlay; frame?: VideoFrameSnapshot }): Promise<VideoObservation> {
    const start = performance.now();
    const unavailable = unavailableObservation(input.video, input.frame, start);
    if (!this.client || !input.frame || input.frame.blockedReason) return unavailable;

    try {
      const response = await this.client.responses.create({
        model: this.model,
        max_output_tokens: 220,
        instructions: VISION_INSTRUCTIONS,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: buildVisionTaskPayload(input.play) },
              { type: "input_image", image_url: input.frame.dataUrl, detail: "low" }
            ]
          }
        ]
      });

      const payload = parseVisionPayload(response.output_text);
      return buildSuccessfulObservation(payload, { video: input.video, frame: input.frame }, start);
    } catch (error) {
      return buildFailedObservation(unavailable, error, start);
    }
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "OpenAI Vision Model",
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey ? `Configured for frame validation with ${this.model}.` : "Set OPENAI_API_KEY and MODEL_PROVIDER=openai-vision to enable real frame validation."
    };
  }
}
