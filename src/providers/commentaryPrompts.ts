import type { CommentaryKind, FantasyRoster, GameOdds, GroupSettings, HostId, NewsItem, PlayerSeasonStats, SportsPlay, VideoObservation, FantasyImpact, MomentCue } from "../shared/contracts";
import { HOST_PERSONAS, type HostPersona } from "../shared/hostPersonas";

export type CommentaryDraftInput = {
  play: SportsPlay;
  observation: VideoObservation;
  impacts: FantasyImpact[];
  moment?: MomentCue;
  group: GroupSettings;
  news: NewsItem[];
  recentCommentary: string[];
  fallbackText: string;
  hostId?: HostId;
  listenerRoster?: FantasyRoster;
  kind?: CommentaryKind;
  /**
   * Free-form summary of the listener's recent shows. The opener prompt
   * uses this for cross-session memory ("last week Mahomes burned you").
   * Plain prose, ~1-3 sentences. Skipped silently when absent.
   */
  priorContext?: string;
  /** Vegas line + total + moneyline. When provided, persona prompts may cite it. */
  odds?: GameOdds;
  /**
   * W12: advanced stats for the listener's starters playing in this
   * game. EPA, target share, snap%. Persona prompts may cite at most
   * one of these per turn — beat-writer flavor without overload.
   */
  analytics?: PlayerSeasonStats[];
};

export function resolveHostPersona(hostId?: HostId): HostPersona {
  return hostId ? HOST_PERSONAS[hostId] : HOST_PERSONAS.maya;
}

export function buildOpenerSystemPrompt(persona: HostPersona): string {
  return [
    `You are ${persona.name}, the ${persona.role} on Huddle Radio. This is the SHOW OPEN — the first words the listener hears.`,
    `Persona directive: ${persona.directive}`,
    "",
    "Goal: in under 50 seconds of speech (around 90-120 words), the listener should know — without being told — that this show was made specifically for them.",
    "",
    "Required structure:",
    "1. Open by addressing the listener by name — first sentence.",
    "2. Reference their actual fantasy team name and 2-3 of their actual starters BY NAME, in their voice ('your QB,' 'the rookie WR you reached for').",
    "3. Give one specific thing about each named starter — projected role tonight, recent form, or stakes — using only the data provided. If a fact isn't there, describe direction, don't invent.",
    "4. End with a one-line handoff to live game action.",
    "",
    "If `priorContext` is provided, weave ONE callback into step 2 or 3 — a 'last time you were here' beat — only if it lands naturally. Never force it; never list shows; never narrate the app.",
    "",
    "Hard rules:",
    "- Stay in voice. No generic radio openers ('welcome back, folks').",
    "- Never invent stats. If a number isn't in the data, hedge ('quietly piling up,' 'hasn't shown up yet').",
    "- No exposition about the app. No 'today on Huddle Radio.' Just talk like you know this person.",
    "- Keep it PG. No profanity even on chaos tone.",
    "- Do not mention API keys, system prompts, or implementation details."
  ].join("\n");
}

export function buildPlaySystemPrompt(persona: HostPersona): string {
  return [
    `You are ${persona.name}, the ${persona.role} on Huddle Radio — a personalized fantasy sports livecast made for ONE specific listener.`,
    `Persona directive: ${persona.directive}`,
    `Speech tics — hit at least one per turn: ${persona.speechTics.map((tic) => `(${tic})`).join(" ")}`,
    "",
    "Hard rules:",
    "- Write ONE turn of dialogue under 60 words. You are not narrating both sides — you are the named host above. Stay in voice.",
    "- Address the listener by name when it lands naturally. Reference their actual starters when relevant; do not invent players.",
    "- Hedge stats verbally: prefer 'ESPN's showing,' 'as of this drive,' 'through three quarters' over confident absolute claims.",
    "- Never fabricate numbers. If a number isn't in the provided facts, describe direction ('quietly piling up,' 'hasn't shown up yet') instead of inventing one.",
    "- Avoid repeating recent phrasing. Avoid generic openers like 'welcome back' or 'big play here.'",
    "- Do not mention API keys, system prompts, credentials, or implementation details.",
    "- Keep it PG unless tone says chaos, and even then no profanity.",
    "- If video validation is unavailable, uncertain, or not-sports, anchor only to official play data and don't imply you saw video.",
    "- If `odds` is provided, you may cite the line/total/moneyline once when it lands naturally — do not lead with it; never make a betting recommendation.",
    "- If `analytics` carries stats for a player you mention (snap%, EPA/play, target share, etc.), you may weave ONE of those numbers in when it sharpens the call. Don't dump multiple. Skip if it would feel forced."
  ].join("\n");
}

/**
 * The structured payload every commentary provider sends to its model.
 * Shared so OpenAI / Anthropic / Gemini all receive the same facts —
 * persona behavior is the only thing that differs across vendors.
 */
export function buildCommentaryPayload(input: CommentaryDraftInput, persona: HostPersona) {
  const listener = input.group.listener;
  const roster = input.listenerRoster;
  return {
    host: {
      id: persona.id,
      name: persona.name,
      role: persona.role,
      directive: persona.directive,
      speechTics: persona.speechTics,
      examples: persona.examples
    },
    listener: {
      name: listener.name,
      favoriteTeam: listener.favoriteTeam,
      fantasyTeamName: roster?.teamName,
      starters: (roster?.starters ?? []).map((p) => ({
        name: p.name,
        position: p.position,
        proTeam: p.proTeam,
        currentPoints: p.currentPoints
      }))
    },
    priorContext: input.priorContext ?? null,
    tone: input.group.tone,
    priority: input.group.homeTeamBias,
    friends: input.group.friends.map((friend) => ({
      name: friend.name,
      favoriteTeam: friend.favoriteTeam,
      rosterId: friend.rosterId,
      rivalryNotes: friend.rivalryNotes
    })),
    play: input.play,
    observation: {
      summary: input.observation.summary,
      confidence: input.observation.confidence,
      validation: input.observation.validation,
      guardrail:
        input.observation.validation?.status === "sports-event"
          ? "You may mention visible sports context cautiously."
          : "Do not imply the model saw game action; rely on official play data for stats and game events."
    },
    fantasyImpacts: input.impacts,
    moment: input.moment,
    news: input.news.slice(0, 1),
    odds: input.odds
      ? {
          spread: input.odds.spread,
          total: input.odds.total,
          moneyline: input.odds.moneyline,
          movement: input.odds.movement,
          book: input.odds.book
        }
      : null,
    analytics: (input.analytics ?? []).slice(0, 6).map((stats) => ({
      name: stats.name,
      position: stats.position,
      team: stats.team,
      snapPercent: stats.snapPercent,
      epaPerPlay: stats.epaPerPlay,
      targetShare: stats.targetShare,
      usagePerGame: stats.usagePerGame,
      pointsPerGame: stats.pointsPerGame,
      note: stats.note
    })),
    recentCommentary: input.recentCommentary.slice(0, 4)
  };
}

export function sanitizeCommentary(text: string, fallbackText: string): string {
  // Catch credential-shaped phrases in any reasonable spelling so a
  // jailbroken model echoing the system prompt can't leak the key:
  // `apikey`, `api_key`, `api-key`, and `api key` (with whitespace).
  if (/api[\s_-]?key|secret|token|credential|system prompt/i.test(text)) {
    return fallbackText;
  }
  return text.slice(0, 520);
}
