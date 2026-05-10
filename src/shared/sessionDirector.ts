import type { ActiveProviderSummary, FantasyLeagueState, GroupSettings, SportsGameState, StreamValidation } from "./contracts";
import type { ProductReadinessSummary } from "./productReadiness";

export type SessionDirectorMode = "live-ready" | "data-only" | "demo-rehearsal" | "blocked";
export type SessionDirectorStepState = "done" | "active" | "warn" | "blocked";

export type SessionDirectorStep = {
  id: string;
  label: string;
  state: SessionDirectorStepState;
  detail: string;
};

export type SessionDirectorPlan = {
  score: number;
  mode: SessionDirectorMode;
  headline: string;
  steps: SessionDirectorStep[];
  cues: string[];
  fallbackPlan: string[];
};

export type SessionDirectorInput = {
  readiness: ProductReadinessSummary;
  providers: ActiveProviderSummary;
  fantasy?: FantasyLeagueState;
  game?: SportsGameState;
  group: GroupSettings;
  streamValidation?: StreamValidation;
  isLive: boolean;
  commentaryCount: number;
  playCount: number;
  averageLatency?: {
    model?: number;
    tts?: number;
    endToEnd?: number;
  };
};

export function buildSessionDirector(input: SessionDirectorInput): SessionDirectorPlan {
  const score = calculateScore(input.readiness);
  const mode = sessionMode(input);
  const steps = buildSteps(input);
  const cues = buildCues(input, mode);
  const fallbackPlan = buildFallbackPlan(input, mode);

  return {
    score,
    mode,
    headline: headlineForMode(mode, input.isLive),
    steps,
    cues,
    fallbackPlan
  };
}

function calculateScore(readiness: ProductReadinessSummary) {
  if (readiness.items.length === 0) return 0;
  const points = readiness.items.reduce((total, item) => {
    if (item.level === "ready") return total + 100;
    if (item.level === "needs-attention") return total + 55;
    return total;
  }, 0);
  return Math.round(points / readiness.items.length);
}

function sessionMode(input: SessionDirectorInput): SessionDirectorMode {
  if (input.readiness.level === "blocked") return "blocked";
  const demoProvider = Object.values(input.providers).some((provider) => provider.toLowerCase().includes("demo") || provider.toLowerCase().includes("mock"));
  const dataOnlyVideo =
    !input.streamValidation ||
    input.streamValidation.status === "unavailable" ||
    input.streamValidation.status === "uncertain" ||
    input.streamValidation.status === "not-sports";
  if (demoProvider) return "demo-rehearsal";
  if (dataOnlyVideo) return "data-only";
  return "live-ready";
}

function buildSteps(input: SessionDirectorInput): SessionDirectorStep[] {
  const itemById = new Map(input.readiness.items.map((item) => [item.id, item]));
  const fantasy = itemById.get("fantasy");
  const group = itemById.get("group");
  const sports = itemById.get("sports");
  const video = itemById.get("video");
  const models = itemById.get("models");
  const tts = itemById.get("tts");

  return [
    {
      id: "league",
      label: "League loaded",
      state: stateFromReadiness(fantasy?.level),
      detail: fantasy?.detail ?? "No league status yet."
    },
    {
      id: "people",
      label: "Friends mapped",
      state: stateFromReadiness(group?.level),
      detail: group?.detail ?? "No group status yet."
    },
    {
      id: "feeds",
      label: "Game data active",
      state: stateFromReadiness(sports?.level),
      detail: sports?.detail ?? "No sports data status yet."
    },
    {
      id: "video",
      label: "Video verified",
      state: stateFromReadiness(video?.level),
      detail: video?.detail ?? "No video status yet."
    },
    {
      id: "ai",
      label: "AI and voice ready",
      state: mergeStepStates(stateFromReadiness(models?.level), stateFromReadiness(tts?.level)),
      detail: `${models?.detail ?? "Model status unknown."} ${tts?.detail ?? "Voice status unknown."}`
    },
    {
      id: "live",
      label: input.isLive ? "Livecast running" : "Ready to start",
      state: input.isLive ? "active" : input.readiness.level === "blocked" ? "blocked" : "warn",
      detail: input.isLive ? `${input.commentaryCount} call(s), ${input.playCount} play event(s) in this session.` : "Start livecast when the setup items are acceptable."
    },
    {
      id: "recap",
      label: "Recap available",
      state: input.commentaryCount > 0 ? "done" : "warn",
      detail: input.commentaryCount > 0 ? "Transcript can be exported for the group." : "Generate commentary before exporting a recap."
    }
  ];
}

function stateFromReadiness(level?: "ready" | "needs-attention" | "blocked"): SessionDirectorStepState {
  if (level === "ready") return "done";
  if (level === "blocked") return "blocked";
  return "warn";
}

function mergeStepStates(left: SessionDirectorStepState, right: SessionDirectorStepState): SessionDirectorStepState {
  if (left === "blocked" || right === "blocked") return "blocked";
  if (left === "warn" || right === "warn") return "warn";
  if (left === "active" || right === "active") return "active";
  return "done";
}

function buildCues(input: SessionDirectorInput, mode: SessionDirectorMode) {
  const cues: string[] = [];
  const gameLabel = input.game ? `${input.game.awayTeam} at ${input.game.homeTeam}` : "No game loaded";
  const mappedFriends = input.group.friends.filter((friend) => friend.rosterId).map((friend) => friend.name);

  if (mode === "blocked") {
    cues.push(input.readiness.nextActions[0] ?? "Resolve blocked setup items before going live.");
  } else if (!input.isLive) {
    cues.push(`Pre-show is set for ${gameLabel}.`);
  } else {
    cues.push(`Keep calls anchored to ${gameLabel} and the latest play feed.`);
  }

  if (mappedFriends.length) cues.push(`Personalize swings for ${mappedFriends.slice(0, 3).join(", ")}.`);
  if (input.averageLatency?.endToEnd && input.averageLatency.endToEnd > 2500) cues.push("Latency is drifting; shorten commentary and reduce cadence if needed.");
  if (input.streamValidation?.status === "sports-event") cues.push(`Visual context is cleared for ${input.streamValidation.sport ?? "sports"} at ${Math.round(input.streamValidation.confidence * 100)}% confidence.`);
  if (input.streamValidation?.status === "unavailable") cues.push("Use data-only commentary until screen share or a frame-readable source is available.");
  if (input.commentaryCount === 0) cues.push("First generated call should explain the stakes in one tight sentence.");

  return dedupe(cues).slice(0, 5);
}

function buildFallbackPlan(input: SessionDirectorInput, mode: SessionDirectorMode) {
  if (mode === "blocked") {
    return input.readiness.nextActions.length ? input.readiness.nextActions.slice(0, 3) : ["Load demo data and rerun setup validation."];
  }
  const fallback = [
    "Use official play-by-play as the source of truth.",
    "Drop visual claims when video validation is unavailable.",
    "Keep fantasy impact and friend rivalry notes in every major swing."
  ];
  if (!input.providers.tts.toLowerCase().includes("elevenlabs")) fallback.push("Use browser voice or text-only transcript until realtime TTS is restored.");
  if (input.providers.sportsData.toLowerCase().includes("demo")) fallback.push("Treat the session as a rehearsal, not a real game broadcast.");
  return fallback.slice(0, 4);
}

function headlineForMode(mode: SessionDirectorMode, isLive: boolean) {
  if (mode === "blocked") return "Hold the livecast until the blocked items are fixed.";
  if (mode === "demo-rehearsal") return isLive ? "Demo rehearsal is running." : "Demo rehearsal is ready.";
  if (mode === "data-only") return isLive ? "Data-only livecast is running." : "Data-only livecast is ready.";
  return isLive ? "Full livecast is running." : "Full livecast is ready.";
}

function dedupe(values: string[]) {
  return [...new Set(values)];
}
