import type { ModelStackProfile } from "../shared/modelStack";
import { config } from "./config";

/**
 * Snapshot of which models the deploy is configured to use per role.
 * Pure config introspection — no I/O. Surfaces in the producer panel
 * so the listener can see at a glance which provider is active and
 * which keys are missing.
 */
export function buildModelStack(): ModelStackProfile {
  const commentaryProvider = config.RESOLVED_COMMENTARY_PROVIDER;
  const ttsProvider = config.RESOLVED_TTS_PROVIDER;
  return {
    preset: config.MODEL_PRESET,
    commentary: {
      provider: commentaryProvider,
      model: commentaryProvider === "openai" ? config.RESOLVED_OPENAI_MODEL : "local-template",
      reasoningEffort: config.OPENAI_REASONING_EFFORT,
      status: commentaryProvider === "openai" ? (config.OPENAI_API_KEY ? "ready" : "needs-key") : "local",
      role: "Drafts short personalized livecast scripts from play, fantasy, news, and group context."
    },
    realtime: {
      provider: config.MODEL_PRESET === "local" ? "mock" : "openai-realtime",
      model: config.MODEL_PRESET === "local" ? "mock-realtime" : config.RESOLVED_REALTIME_MODEL,
      status: config.MODEL_PRESET === "local" ? "mock" : "planned",
      role: "Target for future browser audio/video realtime loop and barge-in voice interaction."
    },
    multimodal: {
      provider: config.RESOLVED_MODEL_PROVIDER,
      model:
        config.RESOLVED_MODEL_PROVIDER === "openai-vision"
          ? config.RESOLVED_OPENAI_MODEL
          : config.RESOLVED_MODEL_PROVIDER === "nemotron"
            ? config.NEMOTRON_MODEL
            : config.RESOLVED_MODEL_PROVIDER === "openai-realtime"
              ? config.RESOLVED_REALTIME_MODEL
              : "mock-multimodal-observer",
      status:
        config.RESOLVED_MODEL_PROVIDER === "mock"
          ? "mock"
          : config.RESOLVED_MODEL_PROVIDER === "openai-vision" && config.OPENAI_API_KEY
            ? "ready"
            : config.RESOLVED_MODEL_PROVIDER === "nemotron" && config.NEMOTRON_ENDPOINT
              ? "ready"
              : "planned",
      role: "Observes permitted video/screen input and produces non-authoritative context for commentary."
    },
    tts: {
      provider: ttsProvider,
      model:
        ttsProvider === "elevenlabs"
          ? config.RESOLVED_ELEVENLABS_MODEL_ID
          : ttsProvider === "fish"
            ? config.FISH_MODEL
            : "browser-speechSynthesis",
      status:
        ttsProvider === "elevenlabs"
          ? (config.ELEVENLABS_API_KEY ? "ready" : "needs-key")
          : ttsProvider === "fish"
            ? (config.FISH_API_KEY ? "ready" : "needs-key")
            : "local",
      role: "Streams low-latency spoken commentary audio."
    }
  };
}
