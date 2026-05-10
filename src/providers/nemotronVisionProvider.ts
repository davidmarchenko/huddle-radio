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

/**
 * Nemotron Nano Omni vision provider.
 *
 * Talks to Nvidia's hosted OpenAI-compatible endpoint at
 * https://integrate.api.nvidia.com/v1 (configurable via
 * NEMOTRON_ENDPOINT — point at a self-hosted NIM container for
 * on-prem). Model id default is
 * nvidia/nemotron-3-nano-omni-30b-a3b-reasoning per the April 2026
 * release; override via NEMOTRON_MODEL.
 *
 * Why Nano Omni for this app: it's natively multimodal (text +
 * image + audio + video → text) with word-level ASR timestamps, so
 * the same model powers vision (here), broadcast-audio
 * transcription (W17), and listener voice input (W18). One key,
 * one billable account, three modalities — clean Nvidia-shaped
 * story for the M&E pitch.
 *
 * The output payload shape matches openAIVisionModelProvider so the
 * existing visionModelProviderChain can swap providers without any
 * downstream changes.
 */
export class NemotronVisionProvider implements MultimodalModelProvider {
  id = "nemotron-vision";
  private readonly client?: OpenAI;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    private readonly baseUrl = "https://integrate.api.nvidia.com/v1",
    fetcher?: typeof fetch
  ) {
    this.client = apiKey
      ? new OpenAI({
          apiKey,
          baseURL: baseUrl,
          // Optional fetcher injection so tests can mock the network
          // without mocking the SDK module itself. The cast keeps the
          // OpenAI SDK's stricter Fetch type happy.
          fetch: fetcher as unknown as OpenAI["fetch"]
        })
      : undefined;
  }

  async observe(input: { video: VideoSourceConfig; play: SportsPlay; frame?: VideoFrameSnapshot }): Promise<VideoObservation> {
    const start = performance.now();
    const unavailable = unavailableObservation(input.video, input.frame, start);
    if (!this.client || !input.frame || input.frame.blockedReason) return unavailable;

    try {
      // Use chat.completions (universally supported on
      // OpenAI-compatible endpoints) rather than the newer
      // responses.create — Nvidia's catalog adopted chat completions
      // first and it round-trips images via the same image_url
      // schema the OpenAI SDK already encodes.
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 220,
        // Nemotron-3-nano-omni is a reasoning-enabled model; setting
        // a low temperature keeps the JSON output deterministic for
        // the parser, which expects a tight envelope.
        temperature: 0.1,
        messages: [
          { role: "system", content: VISION_INSTRUCTIONS },
          {
            role: "user",
            content: [
              { type: "text", text: buildVisionTaskPayload(input.play) },
              { type: "image_url", image_url: { url: input.frame.dataUrl, detail: "low" } }
            ]
          }
        ]
      });

      const text = response.choices?.[0]?.message?.content ?? "";
      const flat = typeof text === "string" ? text : JSON.stringify(text);
      const payload = parseVisionPayload(flat);
      return buildSuccessfulObservation(payload, { video: input.video, frame: input.frame }, start);
    } catch (error) {
      return buildFailedObservation(unavailable, error, start);
    }
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Nemotron Nano Omni Vision",
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey
        ? `Configured for frame analysis with ${this.model} via ${this.baseUrl}.`
        : "Set NEMOTRON_API_KEY (NVIDIA build.nvidia.com key) to enable Nemotron Nano Omni vision."
    };
  }
}
