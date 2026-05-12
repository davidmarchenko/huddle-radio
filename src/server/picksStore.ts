import type {
  EntryStatus,
  ListenerPickSelection,
  PickEntry,
  PickProp,
  PickResultStatus,
  PickStatus
} from "../shared/picksContracts";
import { MAX_PICKS, MIN_PICKS, STAKE_PER_ENTRY } from "../shared/picksContracts";
import { payoutMultiplierFor, projectedPayout, settlePayout } from "../shared/picksPayouts";
import type { LiveStatsMap } from "./picksLiveStats";

/**
 * In-memory store of listener pick entries keyed by (listenerId,
 * gameId). One entry per listener per game — re-submitting overwrites.
 *
 * In-process state is fine for the single-instance demo. Multi-region
 * production would back this with Upstash Redis (a Map → KV swap is a
 * ~10-line change). All-time stats (per listener) can be derived from
 * the same store by fetching settled entries; we keep the index small
 * by capping retained entries per listener.
 */

const RETAIN_PER_LISTENER = 50;

type StoreKey = string; // `${listenerId}:${gameId}`

const entries = new Map<StoreKey, PickEntry>();
const byListener = new Map<string, PickEntry[]>(); // chronological, newest first

function key(listenerId: string, gameId: string): StoreKey {
  return `${listenerId}:${gameId}`;
}

export type SubmitInput = {
  listenerId: string;
  gameId: string;
  selections: ListenerPickSelection[];
  /** Slate snapshot at the time of submit — locked into the entry so settlement is deterministic. */
  availableProps: PickProp[];
  /** Optional override — defaults to the contract STAKE_PER_ENTRY. */
  stake?: number;
};

export type SubmitResult = { entry: PickEntry } | { error: string };

export function submitEntry(input: SubmitInput): SubmitResult {
  if (input.selections.length < MIN_PICKS) return { error: `Need at least ${MIN_PICKS} picks.` };
  if (input.selections.length > MAX_PICKS) return { error: `At most ${MAX_PICKS} picks.` };
  // Resolve each selection to a prop snapshot. Reject unknown propIds.
  const propsById = new Map(input.availableProps.map((prop) => [prop.id, prop]));
  const lockedProps: PickProp[] = [];
  for (const selection of input.selections) {
    const prop = propsById.get(selection.propId);
    if (!prop) return { error: `Unknown propId: ${selection.propId}` };
    lockedProps.push(prop);
  }
  // Reject duplicate picks on the same prop.
  const seen = new Set<string>();
  for (const sel of input.selections) {
    if (seen.has(sel.propId)) return { error: "Duplicate pick on the same prop." };
    seen.add(sel.propId);
  }
  const now = new Date().toISOString();
  const entry: PickEntry = {
    id: `entry-${input.listenerId}-${input.gameId}-${Date.now()}`,
    listenerId: input.listenerId,
    gameId: input.gameId,
    selections: [...input.selections],
    lockedProps,
    submittedAt: now,
    status: "pending",
    stake: input.stake ?? STAKE_PER_ENTRY
  };
  entries.set(key(input.listenerId, input.gameId), entry);
  indexForListener(input.listenerId, entry);
  return { entry };
}

function indexForListener(listenerId: string, entry: PickEntry): void {
  const list = byListener.get(listenerId) ?? [];
  // De-dupe by gameId — newest wins.
  const filtered = list.filter((existing) => existing.gameId !== entry.gameId);
  filtered.unshift(entry);
  byListener.set(listenerId, filtered.slice(0, RETAIN_PER_LISTENER));
}

export function getEntry(listenerId: string, gameId: string): PickEntry | undefined {
  return entries.get(key(listenerId, gameId));
}

export function listEntriesForListener(listenerId: string): PickEntry[] {
  return [...(byListener.get(listenerId) ?? [])];
}

/**
 * Mark an entry's lockedAt — picks can't be edited after this. Called
 * once when the game transitions to `live`. Idempotent.
 */
export function lockEntry(listenerId: string, gameId: string): PickEntry | undefined {
  const entry = entries.get(key(listenerId, gameId));
  if (!entry) return undefined;
  if (entry.lockedAt) return entry;
  const updated: PickEntry = { ...entry, lockedAt: new Date().toISOString(), status: "live" };
  entries.set(key(listenerId, gameId), updated);
  indexForListener(listenerId, updated);
  return updated;
}

/**
 * Compute per-pick status against a fresh LiveStatsMap. Called both
 * during the live show (settle=false) and at game-end (settle=true).
 * When `settle=true`, the entry is updated in place: status →
 * "settled", payout calculated, settledAt set.
 */
export function computeEntryStatus(input: {
  entry: PickEntry;
  stats: LiveStatsMap;
  settle: boolean;
}): EntryStatus {
  const picks: PickStatus[] = input.entry.selections.map((selection) => {
    const prop = input.entry.lockedProps.find((p) => p.id === selection.propId)!;
    const playerStats = input.stats.get(prop.playerName.toLowerCase());
    const value = playerStats?.[prop.statType];
    return computePickStatus({ prop, side: selection.side, value, settled: input.settle });
  });

  const hits = picks.filter((p) => p.status === "hit").length;
  const misses = picks.filter((p) => p.status === "miss" || p.status === "push").length;
  const pending = picks.length - hits - misses;
  const payoutMultiplier = payoutMultiplierFor(picks.length);
  const payout = input.settle
    ? settlePayout(picks, input.entry.stake)
    : projectedPayout(picks, input.entry.stake);

  if (input.settle && input.entry.status !== "settled") {
    const settled: PickEntry = {
      ...input.entry,
      status: "settled",
      settledAt: new Date().toISOString(),
      payout
    };
    entries.set(key(input.entry.listenerId, input.entry.gameId), settled);
    indexForListener(input.entry.listenerId, settled);
  }

  // Bubble pick: the live pick that's closest to its line in the
  // wrong direction, i.e. the one most likely to flip the parlay.
  // Used by the commentary engine to bias the next turn's lead.
  const bubble = pickBubble(picks);

  return {
    entryId: input.entry.id,
    status: input.settle ? "settled" : input.entry.status === "pending" ? "pending" : "live",
    picks,
    hits,
    misses,
    pending,
    payoutMultiplier,
    payout,
    stake: input.entry.stake,
    bubblePropId: bubble?.propId,
    hostHint: buildHostHint({ entry: input.entry, picks, bubble })
  };
}

function computePickStatus(input: {
  prop: PickProp;
  side: ListenerPickSelection["side"];
  value: number | undefined;
  settled: boolean;
}): PickStatus {
  const { prop, side, value, settled } = input;
  if (value === undefined) {
    return {
      propId: prop.id,
      side,
      currentValue: undefined,
      line: prop.line,
      status: "pending",
      progress: 0
    };
  }
  let resultStatus: PickResultStatus;
  if (settled) {
    if (value === prop.line) resultStatus = "push";
    else if (side === "more") resultStatus = value > prop.line ? "hit" : "miss";
    else resultStatus = value < prop.line ? "hit" : "miss";
  } else {
    if (side === "more") resultStatus = value > prop.line ? "live-on-track" : "live-off-track";
    else resultStatus = value < prop.line ? "live-on-track" : "live-off-track";
  }
  // Progress is fraction of the line achieved (capped at 1.5 for
  // visualization headroom — UI clamps to 1).
  const progress = Math.max(0, Math.min(1.5, value / Math.max(prop.line, 0.5)));
  return {
    propId: prop.id,
    side,
    currentValue: value,
    line: prop.line,
    status: resultStatus,
    progress
  };
}

function pickBubble(picks: PickStatus[]): PickStatus | undefined {
  // The pick closest to the line in the wrong direction — the next
  // play could flip it. Skip pending (no live value) and finalized.
  let best: { pick: PickStatus; gap: number } | undefined;
  for (const pick of picks) {
    if (pick.currentValue === undefined) continue;
    if (pick.status === "hit" || pick.status === "miss" || pick.status === "push") continue;
    const offBy = pick.side === "more" ? pick.line - pick.currentValue : pick.currentValue - pick.line;
    // offBy > 0 means we're behind the line on the "more" side, or
    // ahead of the line on the "less" side — i.e. losing.
    if (offBy <= 0) continue;
    if (!best || offBy < best.gap) best = { pick, gap: offBy };
  }
  return best?.pick;
}

function buildHostHint(input: { entry: PickEntry; picks: PickStatus[]; bubble?: PickStatus }): string | undefined {
  const { entry, picks, bubble } = input;
  if (entry.status === "pending") return undefined;
  const hits = picks.filter((p) => p.status === "hit" || p.status === "live-on-track").length;
  const total = picks.length;
  const summary = `Listener parlay: ${hits}/${total} hitting`;
  if (!bubble) return summary;
  const prop = entry.lockedProps.find((p) => p.id === bubble.propId);
  if (!prop) return summary;
  const offBy = bubble.side === "more"
    ? bubble.line - (bubble.currentValue ?? 0)
    : (bubble.currentValue ?? 0) - bubble.line;
  return `${summary}. Bubble: ${prop.playerName} needs ${offBy.toFixed(1)} more ${humanStat(prop.statType)} to ${bubble.side === "more" ? "clear" : "stay under"} ${prop.line}.`;
}

function humanStat(stat: PickProp["statType"]): string {
  const map: Record<PickProp["statType"], string> = {
    "passing-yards": "passing yards",
    "passing-tds": "passing TDs",
    "rushing-yards": "rushing yards",
    "receiving-yards": "receiving yards",
    "receptions": "receptions",
    "points": "points",
    "rebounds": "rebounds",
    "assists": "assists",
    "threes": "threes",
    "pra": "PRA",
    "hits": "hits",
    "total-bases": "total bases",
    "home-runs": "home runs",
    "strikeouts-pitcher": "strikeouts",
    "shots-on-goal": "shots on goal",
    "goals": "goals"
  };
  return map[stat];
}

/** Reset for tests. */
export function resetPicksStore(): void {
  entries.clear();
  byListener.clear();
}
