import type { SportLeague } from "./contracts";

/**
 * Live picks — in-show snap predictions distinct from the pregame
 * parlay (see picksContracts.ts). These are single-leg micro-bets
 * tied to a short window of the game:
 *
 *   "Will the Lakers score in the next 90 seconds?"
 *   "Tatum makes a 3 before the next timeout — More or Less?"
 *
 * Generated heuristically from the live game state (or by AI when the
 * key is present), surfaced in the live rail with a countdown, locked
 * by a single tap, resolved automatically once the window expires.
 *
 * Why a separate model from `PickEntry`:
 *   - Pregame parlays lock at game-start and pay multiplicatively for
 *     a clean 2-6 leg combo. Live picks fire one-at-a-time with their
 *     own short window, so the entry shape is different.
 *   - Resolution is window-based here (did event X happen before
 *     `expiresAt`?), not box-score based.
 *   - Stake/payout are smaller and per-pick — like a free spin, not a
 *     parlay slip.
 */

/**
 * Categories of live-pick predictions the generator + resolver know
 * how to handle. Adding a new one means:
 *   1) Adding the kind here
 *   2) Adding a template in livePicksGenerator.ts
 *   3) Adding a resolver branch in livePicksStore.ts
 */
export type LivePickKind =
  /** A team scores any points within the window. Resolves on next
   *  play that increases the team's score. */
  | "team-scores-window"
  /** The current team-with-possession scores before turning the ball
   *  over or before the clock hits a time. NFL/NCAAF/NBA all use this
   *  for "drive ends in points" snaps. */
  | "drive-scores"
  /** A specific player records the next event of the given stat —
   *  e.g. "Curry hits the next 3-pointer". */
  | "player-next-stat"
  /** Total combined score crosses a threshold by an expiry time. */
  | "combined-total-by";

export type LivePickSide = "more" | "less";

export type LivePickProp = {
  /** Stable id — same prop served to two listeners gets the same id. */
  id: string;
  gameId: string;
  sport: SportLeague;
  kind: LivePickKind;
  /** Short headline for the row, e.g. "Lakers score in next 90s?". */
  title: string;
  /** Optional secondary line — game-clock anchor, player team, etc. */
  subtitle?: string;
  /** Team abbreviation involved (when the prop is team-specific). */
  team?: string;
  /** Player name involved (when the prop is player-specific). */
  playerName?: string;
  /** Numeric threshold the prop is hinging on. For "next-stat" props
   *  this is usually 1 (next made event). For "combined-total-by" it's
   *  the combined-points threshold. */
  line: number;
  /** Where the prop came from — provenance string surfaced in the UI
   *  badge. `"heuristic"` is the deterministic template path; `"ai"`
   *  is the LLM-generated path (future). */
  source: "heuristic" | "ai";
  /** Issued timestamp (ISO). */
  createdAt: string;
  /** Hard deadline for resolution. After this the prop is resolved
   *  against whatever happened in the window. */
  expiresAt: string;
  /** Suggested side bias for the prompt prefill — display-only hint
   *  for the UI ("hot pick" badge). Resolver doesn't use this. */
  hotSide?: LivePickSide;
};

export type LivePickResultStatus =
  /** Inside the window, not yet resolved. */
  | "open"
  /** Window expired; the side bet on was correct. */
  | "hit"
  /** Window expired; the side bet on was incorrect. */
  | "miss"
  /** Window expired; the prop was inconclusive (no data). Treated as
   *  a refund — no payout, no charge. */
  | "void";

export type LivePickEntry = {
  id: string;
  listenerId: string;
  gameId: string;
  propId: string;
  /** Snapshot of the prop at lock-time so the resolver is
   *  deterministic even if the active-props list rotates. */
  prop: LivePickProp;
  side: LivePickSide;
  lockedAt: string;
  status: LivePickResultStatus;
  resolvedAt?: string;
  /** Resolution detail — the play (or game-state moment) that decided
   *  the outcome. Surfaced in the recap row so the listener can see
   *  why their pick hit or missed. */
  resolutionNote?: string;
  stake: number;
  payout?: number;
};

/** Per-pick stake. Smaller than the pregame parlay stake so listeners
 *  can fire several without feeling expensive. */
export const LIVE_PICK_STAKE = 2;

/** Flat payout multiplier on a hit. Single-leg snap picks pay 2x —
 *  designed to be a fun feedback loop, not a real sportsbook. */
export const LIVE_PICK_PAYOUT_MULTIPLIER = 2;

/** Default window length per kind, in seconds. Generator can override
 *  but most snaps use these. */
export const LIVE_PICK_DEFAULT_WINDOW_S: Record<LivePickKind, number> = {
  "team-scores-window": 90,
  "drive-scores": 180,
  "player-next-stat": 240,
  "combined-total-by": 300
};
