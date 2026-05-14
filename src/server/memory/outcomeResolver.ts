/**
 * OutcomeResolver — grades pending claims after a game ends.
 *
 * Without resolution, every claim sits as "pending" forever and the
 * CallbackEnrichmentProvider's outcome-bonus scoring is dead code.
 * The resolver closes that loop: when a game completes, look at
 * every pending claim that mentions a player who played in this
 * game, extract the predicted number from the claim text, compare
 * to the actual box-score, and update the claim's outcome.
 *
 * Conservative by design — only resolves what we can confidently
 * grade. Specifically:
 *
 *   - Claim must have an anchorPlayerName (so we can look up stats)
 *   - Claim text must contain a numeric prediction the regex finds
 *   - Sport must have a clear default stat we can map "X goes for N"
 *     against (basketball/wnba → points, nhl → goals, mlb → hits,
 *     nfl → not yet — too many possible stats per player)
 *
 * Claims that don't fit stay pending. Better to under-resolve than
 * incorrectly mark a prediction wrong.
 */

import type { SportLeague } from "../../shared/contracts";
import { fetchLiveStats } from "../picksLiveStats";
import type { Claim, ClaimsStore } from "./types";
import type { PickStatType } from "../../shared/picksContracts";

const NUMERIC_PREDICTION_RE = /\b(\d{1,3})\b/;

/** Best-guess default stat per sport for "X goes for N" style claims.
 *  Conservative: NFL/soccer/etc. left unmapped — too many possible
 *  stats per player without explicit type extraction in the claim. */
const DEFAULT_STAT_BY_SPORT: Partial<Record<SportLeague, PickStatType>> = {
  nba: "points",
  wnba: "points",
  ncaab: "points",
  nhl: "goals",
  mlb: "hits"
};

export type ResolveInput = {
  listenerId: string;
  gameId: string;
  sport: SportLeague;
};

export class OutcomeResolver {
  constructor(private readonly store: ClaimsStore) {}

  /** Grade every pending claim for the listener that anchors on a
   *  player we can score for this sport. Returns the count of
   *  claims marked right / wrong / left pending. Idempotent: re-
   *  running on the same game is a no-op for already-resolved
   *  claims. Never throws past its public surface — outcome
   *  resolution is best-effort observability, not a load-bearing
   *  show feature. */
  async resolve(input: ResolveInput): Promise<{ right: number; wrong: number; pending: number }> {
    try {
      const defaultStat = DEFAULT_STAT_BY_SPORT[input.sport];
      if (!defaultStat) return { right: 0, wrong: 0, pending: 0 };

      const pending = await this.store.pendingFor(input.listenerId);
      if (pending.length === 0) return { right: 0, wrong: 0, pending: 0 };

      // Collect (name, statType) pairs we need from the box score —
      // batch into a single fetchLiveStats call so we don't burn N
      // network round-trips for N claims.
      const wants = pending
        .filter((c) => c.anchorPlayerName)
        .map((c) => ({ playerName: c.anchorPlayerName!, statType: defaultStat }));
      if (wants.length === 0) return { right: 0, wrong: 0, pending: pending.length };

      const { stats, gameCompleted } = await fetchLiveStats({
        gameId: input.gameId,
        sport: input.sport,
        wants
      });
      // Don't grade a game that's still live — early ticks would
      // mark every claim "wrong" before the player has had a chance
      // to hit the number. Wait for the final box score.
      if (!gameCompleted) return { right: 0, wrong: 0, pending: pending.length };

      let right = 0;
      let wrong = 0;
      let stillPending = 0;
      for (const claim of pending) {
        const outcome = gradeOne(claim, stats, defaultStat);
        if (outcome === "right") right += 1;
        else if (outcome === "wrong") wrong += 1;
        else {
          stillPending += 1;
          continue;
        }
        await this.store.updateOutcome({
          claimId: claim.id,
          listenerId: input.listenerId,
          outcome
        });
      }
      return { right, wrong, pending: stillPending };
    } catch {
      return { right: 0, wrong: 0, pending: 0 };
    }
  }
}

function gradeOne(
  claim: Claim,
  stats: Awaited<ReturnType<typeof fetchLiveStats>>["stats"],
  statType: PickStatType
): "right" | "wrong" | "pending" {
  if (!claim.anchorPlayerName) return "pending";
  const numberMatch = claim.text.match(NUMERIC_PREDICTION_RE);
  if (!numberMatch) return "pending";
  const predicted = Number(numberMatch[1]);
  if (!Number.isFinite(predicted)) return "pending";
  const playerStats = stats.get(claim.anchorPlayerName.toLowerCase());
  if (!playerStats) return "pending";
  const actual = playerStats[statType];
  if (typeof actual !== "number") return "pending";
  // "Goes for N" / "over N" reads as ≥ N. Strict greater-than would
  // grade "Wilson goes for 30" wrong if she landed at exactly 30,
  // which would be unfair to the prediction.
  return actual >= predicted ? "right" : "wrong";
}
