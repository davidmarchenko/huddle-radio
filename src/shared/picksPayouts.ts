import type { PickStatus } from "./picksContracts";
import { STAKE_PER_ENTRY } from "./picksContracts";

/**
 * PrizePicks-style "Power Play" multipliers — must hit ALL picks. The
 * 2-leg / 3-leg / etc. tiers are public ($3 → $30 = 10x for 4 picks
 * etc.). We mirror them so the payouts feel familiar to anyone who's
 * played the real product.
 *
 * "Flex" (you can miss one and still win less) is intentionally out
 * of scope for v1 — the all-or-nothing version reads cleaner in a
 * 90-second show window.
 */
const POWER_MULTIPLIERS: Record<number, number> = {
  2: 3,
  3: 5,
  4: 10,
  5: 20,
  6: 37.5
};

export function payoutMultiplierFor(pickCount: number): number {
  return POWER_MULTIPLIERS[pickCount] ?? 0;
}

/**
 * All-or-nothing settle: every pick must be `hit`. A `push` (line
 * landed exactly) breaks the parlay — same as the real product.
 * Pending counts as "not yet settled" so caller should only invoke
 * this once the game is final.
 */
export function settlePayout(picks: PickStatus[], stake = STAKE_PER_ENTRY): number {
  if (picks.length < 2) return 0;
  const allHit = picks.every((pick) => pick.status === "hit");
  if (!allHit) return 0;
  return stake * payoutMultiplierFor(picks.length);
}

/**
 * Live "if it ended now" payout — used by the UI to show a teasing
 * "you're tracking $30" headline mid-game. Treats live-on-track as a
 * provisional hit and live-off-track / pending / miss / push as
 * provisional non-hits.
 */
export function projectedPayout(picks: PickStatus[], stake = STAKE_PER_ENTRY): number {
  if (picks.length < 2) return 0;
  const provisional = picks.every(
    (pick) => pick.status === "hit" || pick.status === "live-on-track"
  );
  if (!provisional) return 0;
  return stake * payoutMultiplierFor(picks.length);
}
