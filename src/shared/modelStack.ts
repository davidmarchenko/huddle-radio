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
  ttsLowLatencyModel: "eleven_flash_v2_5",
  ttsExpressiveModel: "eleven_v3",
  multimodalLocalModel: "nvidia/nemotron-3-nano-omni"
};
