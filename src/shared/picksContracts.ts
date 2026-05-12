import type { SportLeague } from "./contracts";

/**
 * Listener-side prediction picks (PrizePicks-style). The user gets
 * served a slate of player-prop over/unders before each game, locks
 * in 2-6 of them, and the entry pays out a fixed multiplier when ALL
 * picks hit. Pick status streams in during the live show so the hosts
 * can react ("Cam — listener's on the Jokić over, he's at 18 with the
 * half coming up").
 *
 * Scope: this is a fun demo currency layer, not real money. Stake is
 * a constant `STAKE_PER_ENTRY` in fake-bucks; payout multipliers
 * mirror the public PrizePicks "flex" table.
 */

/**
 * Stat categories we know how to settle. Adding a new one means:
 *   1) adding the key here
 *   2) adding a parser pattern in picksGenerator.ts
 *   3) adding an extractor in picksLiveStats.ts
 */
export type PickStatType =
  // Football
  | "passing-yards"
  | "passing-tds"
  | "rushing-yards"
  | "receiving-yards"
  | "receptions"
  // Basketball
  | "points"
  | "rebounds"
  | "assists"
  | "threes"
  | "pra"
  // Baseball
  | "hits"
  | "total-bases"
  | "home-runs"
  | "strikeouts-pitcher"
  // Hockey
  | "shots-on-goal"
  | "goals";

export type PickProp = {
  /** Stable id derived from source + identifier so re-fetches of the slate keep selections sticky. */
  id: string;
  gameId: string;
  sport: SportLeague;
  playerName: string;
  /** Pro-team abbreviation (KC, DET) — used for box-score lookup and UI tinting. */
  playerTeam?: string;
  statType: PickStatType;
  /** PrizePicks-style "more or less than" line. .5 lines avoid pushes. */
  line: number;
  /** Where the line came from. "synthetic" lines are derived locally when real markets are sparse. */
  source: "polymarket" | "kalshi" | "synthetic";
  /** Original market title — useful for UI hover and debugging the parse. */
  rawTitle?: string;
  /** ESPN player headshot URL when we resolved the player against the roster. */
  playerHeadshot?: string;
  /** Team logo URL — pulled from the game's awayMeta/homeMeta when teams match. */
  playerTeamLogo?: string;
  /** Hex team color (no leading #). Used to tint the row's accent stripe. */
  playerTeamColor?: string;
  /** Player position — adds beat-writer flavor to the row ("PG", "QB", etc.). */
  playerPosition?: string;
};

export type PickSide = "more" | "less";

export type ListenerPickSelection = {
  propId: string;
  side: PickSide;
};

export type PickEntryStatus = "pending" | "live" | "settled";

export type PickEntry = {
  id: string;
  listenerId: string;
  gameId: string;
  selections: ListenerPickSelection[];
  /** Snapshot of the props at lock time so settlement is deterministic even if the slate changes. */
  lockedProps: PickProp[];
  submittedAt: string;
  /** Set when the game starts — picks lock and can no longer be edited. */
  lockedAt?: string;
  settledAt?: string;
  status: PickEntryStatus;
  stake: number;
  /** Computed at settle time. Undefined while pending/live. */
  payout?: number;
};

export type PickResultStatus =
  /** Game hasn't started yet — pick is just selected, no live data. */
  | "pending"
  /** Live: trending toward "more" with the line in front of it. */
  | "live-on-track"
  /** Live: trending toward "less" with the line above it. */
  | "live-off-track"
  /** Final: hit. */
  | "hit"
  /** Final: missed. */
  | "miss"
  /** Final: line landed exactly. PrizePicks treats these as DNP — we settle as "miss" but show a distinct chip. */
  | "push";

export type PickStatus = {
  propId: string;
  side: PickSide;
  /** Current measured value (live) or final value (settled). Undefined when no live data is available. */
  currentValue?: number;
  line: number;
  status: PickResultStatus;
  /** 0..1 progress against the line. Capped at 1. */
  progress: number;
};

export type EntryStatus = {
  entryId: string;
  status: PickEntryStatus;
  picks: PickStatus[];
  hits: number;
  misses: number;
  pending: number;
  payoutMultiplier: number;
  payout: number;
  stake: number;
  /** Convenience fields for the engine prompt: which pick most needs attention right now. */
  bubblePropId?: string;
  hostHint?: string;
};

export type PickSlate = {
  gameId: string;
  sport: SportLeague;
  generatedAt: string;
  props: PickProp[];
  /** When the slate was sourced primarily from synthetic templates instead of real markets. */
  synthetic: boolean;
};

/** Stake for every entry; PrizePicks uses real money, we use fake-bucks. */
export const STAKE_PER_ENTRY = 10;

/** Min/max picks per entry — same as PrizePicks. */
export const MIN_PICKS = 2;
export const MAX_PICKS = 6;
