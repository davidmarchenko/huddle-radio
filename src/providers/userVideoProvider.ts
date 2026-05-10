import type { ProviderHealth, VideoSourceConfig, VideoSourceProvider, VideoObservation } from "../shared/contracts";
import { isYouTubeUrl } from "../shared/videoLinks";

export class UserVideoProvider implements VideoSourceProvider {
  id = "user-video";

  async observe(input: VideoSourceConfig): Promise<VideoObservation> {
    const start = performance.now();
    return {
      id: crypto.randomUUID(),
      source: input.mode,
      summary: summarizeVideoSource(input),
      confidence: input.url || input.mode === "screen-share" ? 0.9 : 0.4,
      observedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - start)
    };
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "User Video",
      status: "ready",
      detail: "Accepts user-provided stream URLs, YouTube embeds, VOD files, and browser screen share."
    };
  }
}

function summarizeVideoSource(input: VideoSourceConfig) {
  if (input.mode === "screen-share") return "User is sharing a permitted screen capture.";
  if (input.url && isYouTubeUrl(input.url)) return "User video source is a YouTube URL rendered through an embed preview.";
  return `User video source is configured as ${input.mode}.`;
}
