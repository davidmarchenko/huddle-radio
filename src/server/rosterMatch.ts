import type { FantasyLeagueState, FantasyRoster } from "../shared/contracts";

/**
 * Find the listener's roster in the league. Returns undefined when no
 * rosterId is set OR when the rosterId doesn't match any roster in the
 * league.
 *
 * History: this used to fall back to `allRosters[0]` "so the LLM still
 * has *some* lineup to reference." That fallback was a footgun — an
 * anonymous listener (no profile) ended up narrated as if they owned
 * the first team in the demo league ("Fourth & Snack — Mahomes, St.
 * Brown, McCaffrey, ceiling night for the trio"), and a real listener
 * with a stale/wrong rosterId got a stranger's team. The fix: refuse
 * to invent ownership. The host-side prompt rules already handle the
 * empty-starters branch ("pivot to the matchup itself; do NOT invent
 * players") and the anonymous-broadcast mode skips fantasy chatter
 * entirely.
 *
 * Pair with `rosterMatchKind` for diagnostics: the live-show path logs
 * a warn when `match: false` so the operator can spot misconfigured
 * profiles.
 */
export function rosterForListener(league: FantasyLeagueState, rosterId?: string): FantasyRoster | undefined {
  if (!rosterId) return undefined;
  const allRosters = league.matchups.flatMap((matchup) => matchup.rosters);
  return allRosters.find((roster) => roster.id === rosterId);
}

export type RosterMatchKind = "exact" | "fallback-first" | "no-rosters" | "no-roster-id";

/**
 * Classify the listener-to-roster match for telemetry / logging.
 * Distinguishes "claimed rosterId actually matched" (good) from
 * "claimed rosterId but no league row matched" (bad — listener will
 * hear about a stranger's team unless the caller bails out).
 */
export function rosterMatchKind(league: FantasyLeagueState, rosterId?: string): RosterMatchKind {
  const allRosters = league.matchups.flatMap((matchup) => matchup.rosters);
  if (!allRosters.length) return "no-rosters";
  if (!rosterId) return "no-roster-id";
  return allRosters.some((roster) => roster.id === rosterId) ? "exact" : "fallback-first";
}
