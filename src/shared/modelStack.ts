export type ModelPreset = "sota" | "fast" | "local";

export type ModelStackProfile = {
  preset: ModelPreset;
  commentary: {
    provider: "openai" | "local";
    model: string;
    reasoningEffort: "none" | "low" | "medium" | "high";
    status: "ready" | "needs-key" | "local";
    role: string;
  };
  realtime: {
    provider: "openai-realtime" | "mock";
    model: string;
    status: "planned" | "mock";
    role: string;
  };
  multimodal: {
    provider: "mock" | "openai-vision" | "nemotron" | "openai-realtime";
    model: string;
    status: "mock" | "planned" | "ready";
    role: string;
  };
  tts: {
    provider: "elevenlabs" | "mock";
    model: string;
    status: "ready" | "needs-key" | "local";
    role: string;
  };
};

export const recommendedModelDefaults = {
  commentaryModel: "gpt-5.2",
  commentaryFastModel: "gpt-5-mini",
  realtimeModel: "gpt-realtime",
  realtimeFastModel: "gpt-realtime-mini",
  // Both presets resolve to flash_v2_5: it supports the WebSocket
  // streaming endpoint (~300ms first byte) while eleven_v3 is HTTP-only
  // (1-3s synth blocks the conversation pacing the engine is aiming
  // for). flash_v2_5 trades a small bit of expressive range for the
  // tight back-and-forth a podcast-style show needs. If a single-take
  // narration job ever needs v3's quality, set ELEVENLABS_EXPRESSIVE_MODEL_ID
  // explicitly per-deploy.
  ttsLowLatencyModel: "eleven_flash_v2_5",
  ttsExpressiveModel: "eleven_flash_v2_5",
  multimodalLocalModel: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
};
