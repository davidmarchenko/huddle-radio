import type { GroupSettings } from "../shared/contracts";

/**
 * Anonymous default group used as the seed for fresh sessions before
 * the listener has provided any profile info (name, team, fantasy
 * roster, friends). When this seed reaches the LLM unchanged, the
 * prompt rules treat the cast as ANONYMOUS BROADCAST MODE — no
 * "your starters," no "you're a Chiefs fan," no fabricated
 * fantasy/friend context. The hosts call the game like SportsCenter:
 * players, scores, momentum, no personal address.
 *
 * Real-profile flows overwrite this entirely via /api/live/stream's
 * `group` payload, so onboarded users still get the personalized
 * "Marc, your guy Kelce just took 21 yards" voice.
 */
export const defaultGroup: GroupSettings = {
  listener: { name: "", rosterId: undefined, favoriteTeam: undefined },
  tone: "pg",
  homeTeamBias: "fantasy-first",
  friends: []
};
