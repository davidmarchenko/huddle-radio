import type { ActiveProviderSummary, FantasyLeagueState, GroupSettings, ProviderHealth, StreamValidation } from "./contracts";
import type { ModelStackProfile } from "./modelStack";

export type ProductReadinessLevel = "ready" | "needs-attention" | "blocked";

export type ProductReadinessItem = {
  id: string;
  label: string;
  level: ProductReadinessLevel;
  detail: string;
  action: string;
};

export type ProductReadinessSummary = {
  level: ProductReadinessLevel;
  headline: string;
  items: ProductReadinessItem[];
  nextActions: string[];
};

export type ProductReadinessInput = {
  fantasy?: FantasyLeagueState;
  group: GroupSettings;
  providers: ActiveProviderSummary;
  health: ProviderHealth[];
  modelStack?: ModelStackProfile;
  streamValidation?: StreamValidation;
  ttsEnabled: boolean;
  hasVideoSource: boolean;
  mediaCacheReady: boolean;
};

export function buildProductReadiness(input: ProductReadinessInput): ProductReadinessSummary {
  const items: ProductReadinessItem[] = [
    fantasyReadiness(input.fantasy),
    groupReadiness(input.group),
    sportsReadiness(input.providers, input.health),
    modelReadiness(input.modelStack, input.providers),
    ttsReadiness(input.providers, input.ttsEnabled),
    videoReadiness(input.hasVideoSource, input.streamValidation),
    mediaReadiness(input.mediaCacheReady)
  ];
  const level = items.some((item) => item.level === "blocked") ? "blocked" : items.some((item) => item.level === "needs-attention") ? "needs-attention" : "ready";
  return {
    level,
    headline: headlineForLevel(level),
    items,
    nextActions: items.filter((item) => item.level !== "ready").map((item) => item.action).slice(0, 4)
  };
}

function fantasyReadiness(fantasy?: FantasyLeagueState): ProductReadinessItem {
  const rosters = fantasy?.matchups.flatMap((matchup) => matchup.rosters) ?? [];
  if (!fantasy || rosters.length === 0) {
    return {
      id: "fantasy",
      label: "Fantasy league",
      level: "blocked",
      detail: "No fantasy matchup is loaded.",
      action: "Validate or load a demo, Sleeper, or ESPN fantasy league."
    };
  }
  return {
    id: "fantasy",
    label: "Fantasy league",
    level: "ready",
    detail: `${fantasy.leagueName}: ${rosters.length} roster(s), ${fantasy.matchups.length} matchup(s).`,
    action: "Fantasy league is ready."
  };
}

function groupReadiness(group: GroupSettings): ProductReadinessItem {
  const mapped = group.friends.filter((friend) => friend.rosterId).length;
  if (group.friends.length === 0) {
    return {
      id: "group",
      label: "Group personalization",
      level: "blocked",
      detail: "No friends are configured.",
      action: "Add at least one friend."
    };
  }
  if (mapped === 0) {
    return {
      id: "group",
      label: "Group personalization",
      level: "needs-attention",
      detail: `${group.friends.length} friend(s), but none are mapped to fantasy rosters.`,
      action: "Map friends to rosters for personalized fantasy stakes."
    };
  }
  return {
    id: "group",
    label: "Group personalization",
    level: "ready",
    detail: `${group.friends.length} friend(s), ${mapped} roster mapping(s), ${group.tone} tone.`,
    action: "Group personalization is ready."
  };
}

function sportsReadiness(providers: ActiveProviderSummary, health: ProviderHealth[]): ProductReadinessItem {
  const sportsHealth = health.find((item) => item.id === "demo-sports-data" || item.id === "espn-scoreboard");
  if (sportsHealth?.status === "error") {
    return {
      id: "sports",
      label: "Sports data",
      level: "blocked",
      detail: sportsHealth.detail,
      action: "Switch to demo sports data or fix the live sports provider."
    };
  }
  return {
    id: "sports",
    label: "Sports data",
    level: providers.sportsData.includes("Demo") ? "needs-attention" : "ready",
    detail: providers.sportsData.includes("Demo") ? "Scripted demo plays are active." : `${providers.sportsData} is active.`,
    action: providers.sportsData.includes("Demo") ? "Switch to ESPN scoreboard or a licensed live data provider for real games." : "Sports data is ready."
  };
}

function modelReadiness(modelStack: ModelStackProfile | undefined, providers: ActiveProviderSummary): ProductReadinessItem {
  if (!modelStack) {
    return {
      id: "models",
      label: "AI models",
      level: "needs-attention",
      detail: providers.model,
      action: "Refresh the SOTA model stack."
    };
  }
  const realCommentary = modelStack.commentary.provider === "openai" && modelStack.commentary.status === "ready";
  const realVision = modelStack.multimodal.provider !== "mock" && modelStack.multimodal.status === "ready";
  if (realCommentary && realVision) {
    return {
      id: "models",
      label: "AI models",
      level: "ready",
      detail: `${modelStack.commentary.model} commentary and ${modelStack.multimodal.model} video validation are active.`,
      action: "AI model stack is ready."
    };
  }
  return {
    id: "models",
    label: "AI models",
    level: "needs-attention",
    detail: `Commentary: ${modelStack.commentary.status}; video: ${modelStack.multimodal.status}.`,
    action: "Enable OpenAI/vision credentials or use local mode knowingly."
  };
}

function ttsReadiness(providers: ActiveProviderSummary, ttsEnabled: boolean): ProductReadinessItem {
  if (!ttsEnabled) {
    return {
      id: "tts",
      label: "Voice",
      level: "needs-attention",
      detail: "Speech is disabled.",
      action: "Enable Speak commentary for an audio livecast."
    };
  }
  const realTts = providers.tts.includes("ElevenLabs");
  return {
    id: "tts",
    label: "Voice",
    level: realTts ? "ready" : "needs-attention",
    detail: providers.tts,
    action: realTts ? "Voice is ready." : "Use ElevenLabs for production-quality realtime voice."
  };
}

function videoReadiness(hasVideoSource: boolean, validation?: StreamValidation): ProductReadinessItem {
  if (!hasVideoSource) {
    return {
      id: "video",
      label: "Video stream",
      level: "needs-attention",
      detail: "No stream, VOD, or screen share is active.",
      action: "Add a permitted stream/VOD URL or start screen share."
    };
  }
  if (!validation) {
    return {
      id: "video",
      label: "Video stream",
      level: "needs-attention",
      detail: "Video source exists, but it has not been validated yet.",
      action: "Run Validate current frame."
    };
  }
  if (validation.status === "sports-event") {
    return {
      id: "video",
      label: "Video stream",
      level: "ready",
      detail: `${validation.sport ?? "Sports"} event verified at ${Math.round(validation.confidence * 100)}% confidence.`,
      action: "Video validation is ready."
    };
  }
  return {
    id: "video",
    label: "Video stream",
    level: validation.status === "not-sports" ? "blocked" : "needs-attention",
    detail: validation.reason,
    action: validation.status === "not-sports" ? "Switch to the actual game feed before relying on visual context." : "Use screen share or a CORS-enabled stream for validation."
  };
}

function mediaReadiness(mediaCacheReady: boolean): ProductReadinessItem {
  return {
    id: "media",
    label: "Media assets",
    level: mediaCacheReady ? "ready" : "needs-attention",
    detail: mediaCacheReady ? "Local media cache is available." : "Media cache is missing.",
    action: mediaCacheReady ? "Media assets are ready." : "Run npm run media:cache."
  };
}

function headlineForLevel(level: ProductReadinessLevel) {
  if (level === "ready") return "Ready for a full personalized livecast.";
  if (level === "blocked") return "Fix blocked setup items before trusting the livecast.";
  return "Runnable, with a few product-quality gaps to close.";
}
