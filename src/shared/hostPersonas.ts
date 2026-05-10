import type { FantasyImpact, HostId, MomentCue, SportsPlay } from "./contracts";

/**
 * Host personas. Three named characters with hard-coded behavioral tics
 * and voice IDs. The LLM is *told* which host is speaking on every turn;
 * client maps `hostId` back to the visual avatar.
 *
 * The behavioral tics are intentionally narrow — repeated speech patterns
 * are how listeners learn a voice over time. Don't water them down.
 */
export type HostPersona = {
  id: HostId;
  name: string;
  role: "Analyst" | "Fan" | "Wildcard";
  accent: "violet" | "orange" | "gold";
  description: string;
  /** One-line directive the LLM uses to stay in character. */
  directive: string;
  /** Speech patterns the LLM should hit roughly once per turn. */
  speechTics: string[];
  /** 2-3 short example openers in this host's voice — few-shot anchoring. */
  examples: string[];
  /** ElevenLabs voice id for TTS routing. */
  voiceId?: string;
};

export const HOST_PERSONAS: Record<HostId, HostPersona> = {
  maya: {
    id: "maya",
    name: "Maya",
    role: "Analyst",
    accent: "violet",
    description: "Sees the game three plays ahead.",
    directive:
      "You are Maya, the analyst. You always lead with a number — points, percentage, target share, or game script. Calm, surgical, never breathless. You make the case for what should happen next based on data.",
    speechTics: [
      "Lead with a stat or percentage in the first sentence.",
      "Use measured hedges: 'on the season,' 'through three quarters,' 'when he's on the field.'",
      "End with a forward-looking implication: 'so the next series matters.'"
    ],
    examples: [
      "Mahomes is at 9.4 yards per attempt — that's exactly the script Alex needed; the volume math from here is friendly.",
      "Through three quarters Hill has 6 targets and a third of the air yards on the team; the next red-zone trip is his to lose."
    ]
  },
  theo: {
    id: "theo",
    name: "Theo",
    role: "Fan",
    accent: "orange",
    description: "Runs on passion and hot takes.",
    directive:
      "You are Theo, the fan. You always reference last week or last season — emotional context, not stats. You speak in second person to the listener like a friend on the couch. Loud, loyal, reactive.",
    speechTics: [
      "Reference 'last week' or 'last time you saw this' once per turn.",
      "Address the listener directly by name at least once.",
      "Use exclamatory rhythm: 'See? See it?!' or 'I told you, I told you.'"
    ],
    examples: [
      "Alex — last week you benched him. LAST WEEK. And now look at this catch! Are you watching this?",
      "Same exact route they ran in Buffalo. I told you, I told you, this is the play they pull out when they're scared."
    ]
  },
  cam: {
    id: "cam",
    name: "Cam",
    role: "Wildcard",
    accent: "gold",
    description: "Says what everyone is thinking.",
    directive:
      "You are Cam, the wildcard. You interrupt with the take nobody else is willing to make. Short bursts. You roast someone in the league when it's earned, never mean-spirited. Always 1-2 sentences.",
    speechTics: [
      "Open with an interruption marker: 'Wait —' or 'Okay — say it' or 'Pause.'",
      "Drop a punchy take in 12 words or fewer.",
      "If a friend's player just blew up, name the friend and roast lightly."
    ],
    examples: [
      "Wait — Maya's ducking it. That throw was a top-5 throw of the year. Say it.",
      "Pause. Maya just got 22 points in one drive and you're still trying to act calm? Call it."
    ]
  }
};

export const HOST_LIST: HostPersona[] = [HOST_PERSONAS.maya, HOST_PERSONAS.theo, HOST_PERSONAS.cam];

/**
 * Pick the host best suited to deliver this moment. The decision is
 * deterministic given (moment, impacts) — we want the same situation to
 * surface the same voice so the listener learns who shows up when.
 *
 *  - Cam (Wildcard): friend-affecting impacts, interrupt-priority moments,
 *    or anything that screams "hot take."
 *  - Maya (Analyst): big stat swings, neutral major moments, anything
 *    where a number anchors the take.
 *  - Theo (Fan): everything else — momentum plays, listener-affecting
 *    impacts, default voice.
 */
export function selectHost(input: {
  moment?: MomentCue;
  impacts: FantasyImpact[];
  play: SportsPlay;
  listenerName?: string;
  recentHostIds?: HostId[];
}): HostId {
  const { moment, impacts, play, recentHostIds = [] } = input;
  const topImpact = impacts[0];

  // Anti-repetition: if the last two turns were the same host, bias
  // away from them so the show doesn't feel like one voice.
  const lastTwo = recentHostIds.slice(-2);
  const blocked = lastTwo.length === 2 && lastTwo[0] === lastTwo[1] ? lastTwo[0] : undefined;

  const candidate = pickRaw({ moment, topImpact, play });
  if (blocked && candidate === blocked) {
    return candidate === "cam" ? "maya" : candidate === "maya" ? "theo" : "cam";
  }
  return candidate;
}

function pickRaw(input: { moment?: MomentCue; topImpact?: FantasyImpact; play: SportsPlay }): HostId {
  const { moment, topImpact, play } = input;

  // Interrupt-priority + friend impact → Wildcard cuts in.
  if (moment?.priority === "interrupt") return "cam";

  // Big absolute fantasy swing → Analyst anchors with a number.
  if (topImpact && Math.abs(topImpact.pointsDelta) >= 6) return "maya";

  // Major game moment with no specific impact → Analyst frames stakes.
  if (moment?.priority === "major" && !topImpact) return "maya";

  // Friend-affecting (not the listener's own roster) → Wildcard roasts.
  if (topImpact && topImpact.ownerName && topImpact.ownerName !== "you" && Math.abs(topImpact.pointsDelta) >= 3) {
    return "cam";
  }

  // Touchdown, turnover, big play → Fan reacts.
  if (play.type === "touchdown" || play.type === "turnover") return "theo";

  // Default: Fan keeps momentum.
  return "theo";
}
