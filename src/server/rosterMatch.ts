import type { FantasyLeagueState, FantasyRoster } from "../shared/contracts";

/**
 * Find the listener's roster in the league. Falls back to the first
 * roster if no rosterId is set so the LLM still has *some* lineup to
 * reference. Without this the show falls back to generic third person.
 *
 * Pair with `rosterMatchKind` for diagnostics: the live-show path logs
 * a warn when `match: false` so the operator can spot misconfigured
 * profiles instead of seeing a stranger's roster narrated to the
 * listener.
 */
export function rosterForListener(league: FantasyLeagueState, rosterId?: string): FantasyRoster | undefined {
  const allRosters = league.matchups.flatMap((matchup) => matchup.rosters);
  if (!allRosters.length) return undefined;
  const matched = rosterId ? allRosters.find((roster) => roster.id === rosterId) : undefined;
  return matched ?? allRosters[0];
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
