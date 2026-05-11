import type { GroupSettings } from "../shared/contracts";

/**
 * Demo group used as the seed for new sessions before the listener
 * customizes their friends list. Mirrors what `src/client/main.tsx`
 * uses on first load — keeping a server-side copy means the bootstrap
 * route can return the same shape without the client having to fall
 * back to its constant.
 */
export const defaultGroup: GroupSettings = {
  listener: { name: "Alex", rosterId: "roster-alex", favoriteTeam: "KC" },
  tone: "pg",
  homeTeamBias: "fantasy-first",
  friends: [
    { id: "alex", name: "Alex", favoriteTeam: "KC", rosterId: "roster-alex", rivalryNotes: "you are one Kelce catch away from unbearable confidence" },
    { id: "maya", name: "Maya", favoriteTeam: "DET", rosterId: "roster-maya", rivalryNotes: "do not pretend you were calm during that drive" }
  ]
};
