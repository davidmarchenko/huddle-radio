/**
 * ShowArcPlanner — shapes the show's dramatic structure.
 *
 * Sits ABOVE the producer. The producer decides what to talk about
 * THIS tick; the arc planner decides what kind of moment THIS tick
 * IS in the larger show.
 *
 * Without an arc layer the show is "60 disconnected reactions to
 * plays" — interesting in isolation but exhausting end-to-end. With
 * one, the producer + host LLM can make turns that feel like they
 * belong to the same show:
 *
 *   - Cold open: energetic, sets the table, names the matchup.
 *   - Build: establish the narrative threads of THIS game.
 *   - Climax: the major moment — let it breathe, don't bury it.
 *   - Act break: reflect, callback, breathe between halves.
 *   - Pivot: when the game is bad, counter-program (next week, the
 *     room, host friction) instead of grinding through bad news.
 *   - Close: wrap, foreshadow next listen.
 *
 * Output is a single `ArcDirective` per tick — no listener-facing
 * state. Producer reads it as context; doesn't have to obey it
 * verbatim, but uses it to shape beat selection and pacing.
 */

export type ArcPosition =
  | "cold-open"
  | "build"
  | "mid-show"
  | "climax"
  | "act-break"
  | "pivot"
  | "close";

export type PacingDirective =
  | "slow-down" // let a moment breathe — fewer beats, more reflection
  | "build" // escalate — set up the next moment
  | "steady" // default — match the energy of the play
  | "speed-up"; // get through filler quickly — short beats, less elaboration

export type ArcDirective = {
  /** Which act of the show we're in. */
  position: ArcPosition;
  /** How to pace the next tick relative to the play's energy. */
  pacing: PacingDirective;
  /** One-sentence editorial cue for the producer — "this is the
   *  cold open; name the matchup, name the listener once, foreshadow
   *  the first storyline." Producer reads this as the highest-level
   *  framing for its beat selection. */
  dramaticCue: string;
  /** True when the game is no longer the right anchor — e.g. blowout
   *  beyond 20 in Q4, garbage time. The producer should counter-
   *  program (next week, friend rivalries, host friction). */
  pivotRecommended: boolean;
  /** Running editorial state for the next tick — counts of major
   *  moments seen, callbacks delivered, pivots taken. Helps the
   *  planner make decisions like "we've been on climax for 3 ticks,
   *  start the cool-down." */
  state: ArcState;
};

export type ArcState = {
  /** Elapsed seconds since show start. */
  elapsedSeconds: number;
  /** How many ticks have been delivered (excluding the opener). */
  ticksDelivered: number;
  /** Number of major / interrupt moments seen so far. */
  climacticMomentsSeen: number;
  /** Number of consecutive ticks the planner has spent in `climax`.
   *  Used to bound how long we keep meltdown energy before moving on. */
  consecutiveClimaxTicks: number;
  /** Whether we've already played the cold-open beat. */
  coldOpenDelivered: boolean;
  /** Whether the show has entered pivot mode at least once. */
  hasPivoted: boolean;
};

export const INITIAL_ARC_STATE: ArcState = {
  elapsedSeconds: 0,
  ticksDelivered: 0,
  climacticMomentsSeen: 0,
  consecutiveClimaxTicks: 0,
  coldOpenDelivered: false,
  hasPivoted: false
};
