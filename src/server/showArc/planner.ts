/**
 * Deterministic show-arc planner. Per-show state, advances on each
 * tick, emits an `ArcDirective` the producer reads as its highest-
 * level framing.
 *
 * Why deterministic, not LLM:
 *   - Arc decisions are mostly mechanical: are we in the first 60s?
 *     Is the score lopsided? Did we just see a buzzer-beater?
 *   - Predictability beats cleverness here — the producer can rely on
 *     consistent transitions instead of guessing what an LLM would do.
 *   - The producer + host LLM still bring the personality; the arc
 *     planner just sets the dramatic expectations.
 *
 * Future: the planner is a candidate for an LLM upgrade once we have
 * data from the eval harness — specifically, a "would the listener
 * have appreciated more pivot/callback here?" signal. For now,
 * heuristics + a clean directive surface.
 */

import type { MomentCue, SportsGameState } from "../../shared/contracts";
import type { EvalSnapshot } from "../eval/evalStore";
import { INITIAL_ARC_STATE, type ArcDirective, type ArcPosition, type ArcState, type PacingDirective } from "./types";

const COLD_OPEN_SECONDS = 60;
const CLOSE_WINDOW_SECONDS = 60;
/** After this many consecutive climax ticks, force back to mid-show
 *  pacing. Without a cap, a single big run by one team keeps the
 *  show in meltdown mode for minutes — exhausting. */
const CLIMAX_TICK_CAP = 3;
const PIVOT_SCORE_DIFFERENTIAL = 20;

export type ShowArcPlannerOptions = {
  /** Total expected show duration in seconds — drives the close
   *  window. Default 30min for a typical live game tick stream. */
  expectedDurationSeconds?: number;
  /** Time source — pluggable for tests. Default Date.now. */
  now?: () => number;
};

export class ShowArcPlanner {
  private state: ArcState = { ...INITIAL_ARC_STATE };
  private readonly startedAtMs: number;
  private readonly expectedDurationSeconds: number;
  private readonly now: () => number;

  constructor(options: ShowArcPlannerOptions = {}) {
    this.expectedDurationSeconds = options.expectedDurationSeconds ?? 30 * 60;
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
  }

  /** Read the current arc directive WITHOUT advancing state. Useful
   *  for diagnostics endpoints — "where is the show right now?" */
  current(input: { game: SportsGameState; moment?: MomentCue; evalSnapshot?: EvalSnapshot }): ArcDirective {
    return this.buildDirective(input);
  }

  /** Advance the show one tick and return the directive. The
   *  producer should call this once per tick BEFORE picking beats. */
  tick(input: { game: SportsGameState; moment?: MomentCue; evalSnapshot?: EvalSnapshot }): ArcDirective {
    this.state.elapsedSeconds = Math.floor((this.now() - this.startedAtMs) / 1000);
    this.state.ticksDelivered += 1;
    if (input.moment?.priority === "major" || input.moment?.priority === "interrupt") {
      this.state.climacticMomentsSeen += 1;
    }
    const directive = this.buildDirective(input);
    if (directive.position === "climax") {
      this.state.consecutiveClimaxTicks += 1;
    } else {
      this.state.consecutiveClimaxTicks = 0;
    }
    if (directive.position === "cold-open") {
      this.state.coldOpenDelivered = true;
    }
    if (directive.pivotRecommended) {
      this.state.hasPivoted = true;
    }
    // Snapshot the post-update state into the returned directive so
    // the producer + diagnostics see exactly what the planner used.
    return { ...directive, state: { ...this.state } };
  }

  private buildDirective(input: { game: SportsGameState; moment?: MomentCue; evalSnapshot?: EvalSnapshot }): ArcDirective {
    const elapsed = Math.floor((this.now() - this.startedAtMs) / 1000);
    const remaining = Math.max(0, this.expectedDurationSeconds - elapsed);
    const moment = input.moment;
    const game = input.game;
    const scoreAway = game.currentPlay?.score?.away ?? 0;
    const scoreHome = game.currentPlay?.score?.home ?? 0;
    const scoreDiff = Math.abs(scoreAway - scoreHome);
    const inCloseQuarters = isCloseToFinal(game);

    // Position is decided in priority order — earliest match wins.
    let position: ArcPosition = "mid-show";
    let pacing: PacingDirective = "steady";
    let dramaticCue = "";
    let pivotRecommended = false;

    if (!this.state.coldOpenDelivered && elapsed <= COLD_OPEN_SECONDS) {
      position = "cold-open";
      pacing = "build";
      dramaticCue =
        "Cold open: name the matchup, name the listener once, foreshadow the first storyline. Don't over-stuff — the show has 30 minutes to build.";
    } else if ((moment?.priority === "interrupt" || moment?.priority === "major") && this.state.consecutiveClimaxTicks < CLIMAX_TICK_CAP) {
      position = "climax";
      pacing = "slow-down";
      dramaticCue =
        "Climax moment — let it breathe. Lead host frames it big, peers react, NO routine analysis until the moment lands.";
    } else if (this.state.consecutiveClimaxTicks >= CLIMAX_TICK_CAP) {
      // Burn-down after extended climax — force a mid-show pacing
      // beat so we don't sit in meltdown mode forever.
      position = "mid-show";
      pacing = "speed-up";
      dramaticCue =
        "Cool-down after a long climax stretch. Short reactive beats. Look for a callback that gives the listener something to land on.";
    } else if (inCloseQuarters && remaining <= CLOSE_WINDOW_SECONDS) {
      position = "close";
      pacing = "build";
      dramaticCue =
        "Close window: wrap the dominant storyline of this show, foreshadow next listen, leave one open thread for the room.";
    } else if (scoreDiff >= PIVOT_SCORE_DIFFERENTIAL && !this.state.hasPivoted && isLateGame(game)) {
      position = "pivot";
      pacing = "speed-up";
      pivotRecommended = true;
      dramaticCue =
        "Game is out of hand — counter-program. Pivot to the listener's other lineup, friend-room rivalry, or the slate at large. Don't grind through bad news.";
    } else if (isQuarterBoundary(game)) {
      position = "act-break";
      pacing = "slow-down";
      dramaticCue =
        "Act break (period boundary): reflect on what we've seen, callback to a host's earlier prediction or take, set the stage for the next half.";
    } else if (this.state.ticksDelivered <= 4) {
      position = "build";
      pacing = "build";
      dramaticCue =
        "Early build: establish 2-3 narrative threads for the show — who to watch, what's at stake, where the listener's stake lies.";
    } else {
      position = "mid-show";
      pacing = "steady";
      dramaticCue =
        "Mid-show: stay anchored to the play feed; lean on callbacks and friction to keep the room alive.";
    }

    // Eval-loop feedback: when the rolling stayTuned drops below 5
    // for at least 3 turns AND we're in a non-special position
    // (build / mid-show), shift pacing to break the spell. We don't
    // override climax / cold-open / pivot — those have their own
    // pacing logic that's important for arc shape.
    const eval_ = input.evalSnapshot;
    const isOverridable = position === "build" || position === "mid-show";
    if (eval_ && eval_.sampleSize >= 3 && eval_.meanStayTuned < 5 && isOverridable) {
      pacing = "speed-up";
      dramaticCue =
        `Eval feedback: rolling stayTuned ${eval_.meanStayTuned} — break the spell with shorter, punchier turns. Cut filler, find a callback, escalate friction.`;
    }

    return {
      position,
      pacing,
      dramaticCue,
      pivotRecommended,
      state: { ...this.state, elapsedSeconds: elapsed }
    };
  }
}

function isCloseToFinal(game: SportsGameState): boolean {
  if (game.status === "final") return true;
  const clock = (game.currentPlay?.clock ?? "").toLowerCase();
  const quarter = (game.currentPlay?.quarter ?? "").toLowerCase();
  // Accept "Q4 1:30" / "4Q 0:45" / "OT 0:30" etc. Heuristic — the
  // engine doesn't strictly normalise clock strings across leagues,
  // so we look for the recognisable "small minutes left in the
  // last period" pattern.
  if (/^(q4|q5|4q|ot|2ot)/i.test(quarter)) {
    const m = clock.match(/(\d+):(\d+)/);
    if (m) {
      const minutes = Number(m[1]);
      return minutes <= 2;
    }
  }
  return false;
}

function isLateGame(game: SportsGameState): boolean {
  const quarter = (game.currentPlay?.quarter ?? "").toLowerCase();
  return /q3|q4|3q|4q|ot/i.test(quarter);
}

function isQuarterBoundary(game: SportsGameState): boolean {
  const clock = (game.currentPlay?.clock ?? "").trim();
  return clock === "0:00" || clock === "00:00" || clock === "End";
}
