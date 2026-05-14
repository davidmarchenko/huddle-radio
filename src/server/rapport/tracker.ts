/**
 * RapportTracker — owns and updates RapportState across a show.
 *
 * Lifecycle:
 *   1. Engine constructs one tracker at show start.
 *   2. After each turn ships, engine calls `update()` with the
 *      turn's dialogue, lead host, optional extracted claims, and
 *      what the other hosts engaged with from open threads.
 *   3. Producer + host LLM read the snapshot via `state()`.
 *
 * Heuristic-only — no LLM cost. The trade-off is that some signals
 * (deep "running bit" detection, nuanced engagement classification)
 * are weaker than an LLM could do, but the real-time, every-tick
 * cadence makes that the right call. An LLM-graded post-show pass
 * could produce a better history record without changing this
 * online tracker.
 */

import type { DialogueLine, HostId } from "../../shared/contracts";
import { INITIAL_RAPPORT_STATE, type HostStanding, type OpenThread, type RapportState, type RunningBit } from "./types";

const HOST_IDS: HostId[] = ["maya", "theo", "cam"];
const MAX_OPEN_THREADS = 4;
const MAX_RUNNING_BITS = 3;
/** Internal candidate-pool size — keeps singleton candidates around
 *  long enough that a phrase's second occurrence can find its first.
 *  state() filters this down to ≥2-occurrence survivors. */
const MAX_BIT_CANDIDATES = 80;
const MAX_RECENT_LEADS = 5;
const MAX_RUNNING_BIT_AGE_TICKS = 8;
const RECENT_TURNS_FOR_TONAL = 4;

const LAUGH_TAG_RE = /\[(laughs|laughs softly|chuckles|chuckles softly|giggles|snorts)\]/i;
const ENERGY_MARKER_RE = /(\[(laughs|chuckles|sigh|gasps|jumping in|exclaims)\]|—|!)/g;

export type UpdateInput = {
  /** Turn that just shipped. */
  turnId: string;
  /** Lead host for the turn (first speaker). */
  leadHostId: HostId;
  /** All speakers in the dialogue, in order. */
  dialogue: DialogueLine[];
  /** ISO timestamp the turn shipped. */
  shippedAt: string;
  /** Optional new threads to introduce — typically claim summaries
   *  the extractor flagged for THIS turn. The tracker dedupes so
   *  the same claim doesn't enter twice. */
  newThreads?: Array<{ id: string; text: string; hostId: HostId }>;
  /** Outcomes the resolver settled this tick — keyed by host. Lets
   *  us update hostStanding.lastResolvedOutcome inline so the next
   *  tick's hosts can callback "you were right." */
  resolvedOutcomes?: Array<{ hostId: HostId; outcome: "right" | "wrong" }>;
};

export class RapportTracker {
  private current: RapportState = cloneState(INITIAL_RAPPORT_STATE);
  /** Cap on the rolling window we look at for tonal temperature. */
  private recentTurnTexts: string[] = [];
  /** Internal candidate pool for running bits. Held separately from
   *  current.runningBits so singleton candidates can survive long
   *  enough to be promoted on their second occurrence. state() does
   *  the ≥2-occurrence filter when exposing. */
  private bitCandidates: RunningBit[] = [];

  state(): RapportState {
    const survivors = this.bitCandidates
      .filter((b) => b.occurrences >= 2)
      .slice(0, MAX_RUNNING_BITS);
    return cloneState({ ...this.current, runningBits: survivors });
  }

  update(input: UpdateInput): void {
    this.current.ticksDelivered += 1;

    // Per-host standing updates: the lead host adds to recentLeads,
    // resets their ticksSinceLastSpoke. Hosts who spoke in this turn
    // (any line) reset their ticksSinceLastSpoke. Other hosts get
    // incremented.
    const speakersThisTurn = new Set(input.dialogue.map((l) => l.hostId));
    for (const hostId of HOST_IDS) {
      const standing = this.current.hostStanding[hostId];
      if (speakersThisTurn.has(hostId)) {
        standing.ticksSinceLastSpoke = 0;
      } else {
        standing.ticksSinceLastSpoke += 1;
      }
    }
    const leadStanding = this.current.hostStanding[input.leadHostId];
    leadStanding.recentLeads = [input.turnId, ...leadStanding.recentLeads].slice(0, MAX_RECENT_LEADS);

    // Outcome resolution updates standing for the relevant host(s).
    for (const r of input.resolvedOutcomes ?? []) {
      this.current.hostStanding[r.hostId].lastResolvedOutcome = r.outcome;
    }

    // Acknowledgment detection: if any line in this turn references
    // an open thread by host name OR by a substring of the thread
    // text, mark the thread acknowledged.
    const joinedText = input.dialogue.map((l) => l.text).join(" ").toLowerCase();
    for (const thread of this.current.openThreads) {
      if (thread.acknowledged) continue;
      // Direct host-name reference is a strong acknowledgment signal
      // when the speaker is NOT the thread's owner.
      const otherHosts = HOST_IDS.filter((h) => h !== thread.hostId);
      const speakerHosts = new Set(input.dialogue.map((l) => l.hostId));
      const otherSpoke = otherHosts.some((h) => speakerHosts.has(h));
      const ownerNameMentioned = joinedText.includes(thread.hostId);
      if (otherSpoke && ownerNameMentioned) {
        thread.acknowledged = true;
        continue;
      }
      // Or: a substantial fragment of the thread text appeared.
      const fragment = firstMeaningfulFragment(thread.text);
      if (fragment.length >= 4 && joinedText.includes(fragment)) {
        thread.acknowledged = true;
      }
    }

    // New threads from claims extracted this tick.
    for (const t of input.newThreads ?? []) {
      if (this.current.openThreads.some((existing) => existing.id === t.id)) continue;
      this.current.openThreads.push({
        id: t.id,
        text: t.text,
        hostId: t.hostId,
        introducedTurnId: input.turnId,
        introducedAt: input.shippedAt,
        acknowledged: false
      });
      if (this.current.openThreads.length > MAX_OPEN_THREADS) {
        this.current.openThreads.shift();
      }
    }

    // Running-bit detection — track 2-3 word phrases that recur
    // across turns. Conservative: only count topical phrases (skip
    // function-word bigrams) and the ≥2-occurrence filter happens
    // at exposure (state()), not here, so a phrase's first
    // occurrence survives long enough to be paired with its second.
    updateRunningBits(this.bitCandidates, input.turnId, input.dialogue);
    // Age out candidates we haven't seen in a while.
    this.bitCandidates = this.bitCandidates.filter(
      (b) => this.current.ticksDelivered - turnIdToTickGuess(b.lastSeenTurnId) <= MAX_RUNNING_BIT_AGE_TICKS
    );
    // FIFO-evict to the candidate cap, dropping oldest-by-lastSeen.
    if (this.bitCandidates.length > MAX_BIT_CANDIDATES) {
      this.bitCandidates.sort((a, b) => turnIdToTickGuess(b.lastSeenTurnId) - turnIdToTickGuess(a.lastSeenTurnId));
      this.bitCandidates.length = MAX_BIT_CANDIDATES;
    }

    // Tonal temperature — rolling marker density across last N turns.
    this.recentTurnTexts.unshift(joinedText);
    this.recentTurnTexts = this.recentTurnTexts.slice(0, RECENT_TURNS_FOR_TONAL);
    this.current.tonal.energy = computeEnergy(this.recentTurnTexts);
    if (LAUGH_TAG_RE.test(joinedText)) {
      this.current.tonal.lastLaughTurnId = input.turnId;
    }
  }
}

function cloneState(state: RapportState): RapportState {
  return {
    openThreads: state.openThreads.map((t) => ({ ...t })),
    runningBits: state.runningBits.map((b) => ({ ...b })),
    hostStanding: {
      maya: { ...state.hostStanding.maya, recentLeads: [...state.hostStanding.maya.recentLeads] },
      theo: { ...state.hostStanding.theo, recentLeads: [...state.hostStanding.theo.recentLeads] },
      cam: { ...state.hostStanding.cam, recentLeads: [...state.hostStanding.cam.recentLeads] }
    },
    tonal: { ...state.tonal },
    ticksDelivered: state.ticksDelivered
  };
}

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "and", "or", "but", "is", "in", "on", "at", "for",
  "with", "by", "from", "this", "that", "it", "its", "as", "i", "you", "he", "she",
  "we", "they", "be", "are", "was", "were", "has", "have", "had", "do", "does", "did",
  "yeah", "no", "right", "mmhmm", "sure", "wait", "hold", "actually", "like", "just"
]);

function updateRunningBits(bits: RunningBit[], turnId: string, dialogue: DialogueLine[]): void {
  const text = dialogue.map((l) => l.text).join(" ").toLowerCase();
  const tokens = text
    .replace(/\[[^\]]+\]/g, " ") // drop audio tags
    .replace(/[^a-z\s']/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  // Build 2-grams and 3-grams; only the topical ones (no stopwords)
  // are kept by the token filter above.
  const newPhrases = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i += 1) {
    newPhrases.add(`${tokens[i]} ${tokens[i + 1]}`);
    if (i < tokens.length - 2) {
      newPhrases.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
    }
  }
  for (const phrase of newPhrases) {
    const existing = bits.find((b) => b.phrase === phrase);
    if (existing) {
      existing.occurrences += 1;
      existing.lastSeenTurnId = turnId;
    } else {
      bits.push({ phrase, occurrences: 1, lastSeenTurnId: turnId });
    }
  }
  // Keep sorted by occurrences desc so state() can take the top N
  // off the front. Cap + ≥2-occurrence filter happen in state().
  bits.sort((a, b) => b.occurrences - a.occurrences);
}

/** Crude tick-id parser — turns the trailing digits of a turn id
 *  into a "turn number" approximation. We use it only for relative
 *  age comparisons, so an approximation is fine. Returns -Infinity
 *  if no digits present (which makes the bit age out immediately). */
function turnIdToTickGuess(turnId: string): number {
  const match = turnId.match(/(\d+)/);
  return match ? Number(match[1]) : -Infinity;
}

function firstMeaningfulFragment(text: string): string {
  // Take 4-12 chars from the start, lowered, alpha-only — gives us
  // a decent substring to match against without being so short it
  // false-positives ("the").
  const cleaned = text.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 3 && !STOPWORDS.has(t));
  if (tokens.length === 0) return "";
  return tokens[0];
}

function computeEnergy(recentTurns: string[]): number {
  if (recentTurns.length === 0) return 5;
  let totalMarkers = 0;
  let totalWords = 0;
  for (const turn of recentTurns) {
    const markers = (turn.match(ENERGY_MARKER_RE) ?? []).length;
    const words = turn.split(/\s+/).filter(Boolean).length;
    totalMarkers += markers;
    totalWords += words;
  }
  if (totalWords === 0) return 5;
  // ~5 markers per 100 words ≈ medium energy. Scale.
  const density = (totalMarkers / totalWords) * 100;
  const scaled = Math.round(density * 1.5); // calibrate to 0-10
  return Math.max(0, Math.min(10, scaled));
}
