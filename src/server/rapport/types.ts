/**
 * RapportState — the persistent "conversation context" that survives
 * across ticks within a show.
 *
 * Recent commentary (passed via the existing field) tells the LLM
 * WHAT was said. RapportState tells it WHAT'S STILL OPEN — which
 * predictions haven't resolved, which jokes keep coming up, which
 * host has been quiet, what energy level the room is in. Without
 * it, every tick starts fresh; with it, the show feels like an
 * ongoing conversation between three people who know each other.
 *
 * The tracker is per-show (lives on the engine instance) and
 * updates AFTER each turn ships, so the next tick's producer +
 * host LLM see the post-turn state.
 *
 * Bounded for prompt-budget reasons:
 *   - openThreads: max 4 (oldest evicted)
 *   - runningBits: max 3 (lowest-frequency evicted)
 *   - hostStanding: 3 entries (one per host)
 *   - tonal: 2 numeric fields
 *
 * Total snapshot payload stays under ~500 bytes JSON.
 */

import type { HostId } from "../../shared/contracts";

/** A take, prediction, or strong claim a host put down that hasn't
 *  been resolved or acknowledged by the room yet. The producer
 *  uses these to inject callback beats; the host LLM uses them to
 *  callback explicitly. */
export type OpenThread = {
  /** Stable id — usually mirrors a Claim id when the thread came
   *  from the claims extractor, otherwise turn-id-based. */
  id: string;
  /** The substance of the take in one short paraphrase. */
  text: string;
  /** Which host owns the thread. */
  hostId: HostId;
  /** Turn id where this entered the room. */
  introducedTurnId: string;
  /** ISO timestamp of introduction. */
  introducedAt: string;
  /** Has another host engaged with it (push back, build, callback)?
   *  Acknowledged threads are less urgent to bring back; unack'd
   *  threads sitting for many ticks signal the room missed
   *  something worth revisiting. */
  acknowledged: boolean;
};

/** A short phrase / topic that has recurred across multiple turns
 *  in this show. Lets the producer notice "we keep coming back to
 *  Wilson's three-point shooting" and the host LLM lean into it as
 *  a running bit instead of pretending it's fresh each time. */
export type RunningBit = {
  phrase: string;
  occurrences: number;
  lastSeenTurnId: string;
};

/** Per-host conversation standing — who's been carrying the show,
 *  who's been quiet, who was wrong recently. */
export type HostStanding = {
  /** Last 5 turn ids this host LED. Older entries drop off. */
  recentLeads: string[];
  /** How many consecutive ticks this host hasn't spoken at all.
   *  Producer can force them in when this gets high. */
  ticksSinceLastSpoke: number;
  /** Did this host's most recent prediction age right or wrong?
   *  Lets the OTHER hosts callback with "you were right" / "you
   *  were wrong" without re-deriving from the claims store. */
  lastResolvedOutcome?: "right" | "wrong";
};

/** Rolling read on the room's energy. Drives:
 *   - Don't stack laughs (if recent turns had heavy audio tags,
 *     dial back the next one)
 *   - Force a contrast beat if energy has been flat too long */
export type TonalTemperature = {
  /** 0–10. Computed as a rolling count of energetic markers
   *  (audio tags, hyphen cutoffs, exclamation-driven cadence) per
   *  100 words across the last 4 turns. Higher = louder room. */
  energy: number;
  /** Turn id where the room last had a "[laughs]" / "[snorts]" /
   *  "[chuckles]" tag — used to avoid stacking laugh moments. */
  lastLaughTurnId?: string;
};

export type RapportState = {
  openThreads: OpenThread[];
  runningBits: RunningBit[];
  hostStanding: Record<HostId, HostStanding>;
  tonal: TonalTemperature;
  /** Show-wide tick count — useful for relative timing decisions
   *  ("we haven't heard from Cam in 4 turns"). */
  ticksDelivered: number;
};

export const INITIAL_RAPPORT_STATE: RapportState = {
  openThreads: [],
  runningBits: [],
  hostStanding: {
    maya: { recentLeads: [], ticksSinceLastSpoke: 0 },
    theo: { recentLeads: [], ticksSinceLastSpoke: 0 },
    cam: { recentLeads: [], ticksSinceLastSpoke: 0 }
  },
  tonal: { energy: 5 },
  ticksDelivered: 0
};
