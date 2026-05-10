import type { FantasyLeagueState, GroupSettings, SportLeague } from "../shared/contracts";

/**
 * Profile, claim, and history primitives + the pure helpers that
 * compute listener identity and cross-show memory. Lives outside
 * `main.tsx` so it can be unit-tested without touching React.
 */

export type LeagueClaim = {
  sport: SportLeague;
  provider: "sleeper" | "espn" | "demo";
  leagueId: string;
  leagueName?: string;
  rosterId: string;
  teamName?: string;
};

export type UserProfile = {
  name: string;
  favoriteTeam?: string;
  /** Legacy single-league claim. New per-sport claims live in `leagues`. */
  rosterId?: string;
  /** Per-sport identities so the right roster is used for the current game. */
  leagues?: LeagueClaim[];
};

/** One archived show, persisted across sessions. */
export type ShowHistoryEntry = {
  id: string;
  startedAt: string;
  endedAt: string;
  sport: SportLeague;
  gameId: string;
  gameLabel: string;
  listenerName: string;
  listenerTeamName?: string;
  finalScore?: { away: number; home: number };
  topMoment?: { playerName: string; pointsDelta: number; hostText: string };
  marginShift?: number;
  totalCommentary: number;
};

/**
 * Resolve listener identity for the given group/profile/leagues/sport.
 *
 * Resolution order:
 * 1. Per-sport `LeagueClaim` from `profile.leagues` (preferred).
 * 2. Legacy single `profile.rosterId` (back-compat).
 * 3. Auto-match by `ownerName` against the active league.
 *
 * The active league is the one whose `sport` matches `currentSport`.
 * When no league exists for that sport we leave `rosterId` undefined —
 * downstream view-models surface the no-roster copy instead of silently
 * using a different sport's roster.
 */
export function applyProfileToGroup(
  group: GroupSettings,
  profile: UserProfile | undefined,
  leagues: FantasyLeagueState[],
  currentSport?: SportLeague
): GroupSettings {
  if (!profile) return group;
  const claim = currentSport && profile.leagues
    ? profile.leagues.find((entry) => entry.sport === currentSport)
    : undefined;
  let rosterId = claim?.rosterId ?? profile.rosterId;
  const activeLeague = currentSport
    ? leagues.find((league) => league.sport === currentSport)
    : leagues[0];
  if (!rosterId && activeLeague) {
    const allRosters = activeLeague.matchups.flatMap((matchup) => matchup.rosters);
    const matched = allRosters.find((roster) => roster.ownerName.toLowerCase() === profile.name.toLowerCase());
    if (matched) rosterId = matched.id;
  }
  return {
    ...group,
    listener: {
      name: profile.name,
      rosterId,
      favoriteTeam: profile.favoriteTeam ?? group.listener?.favoriteTeam
    }
  };
}

/**
 * Brief callback the LLM weaves into the next show's opener if it
 * lands naturally. We pick same-sport-same-listener first, then any
 * same-listener entry, then the most recent overall.
 */
export function buildPriorContext(
  history: ShowHistoryEntry[],
  sport?: SportLeague,
  listenerName?: string
): string | undefined {
  if (history.length === 0) return undefined;
  const matchSport = sport
    ? history.find((entry) => entry.sport === sport && entry.listenerName === listenerName)
    : undefined;
  const matchListener = listenerName
    ? history.find((entry) => entry.listenerName === listenerName)
    : undefined;
  const chosen = matchSport ?? matchListener ?? history[0];
  if (!chosen) return undefined;
  const when = formatRelativeTime(chosen.endedAt);
  const moment = chosen.topMoment
    ? `${chosen.topMoment.playerName} went ${chosen.topMoment.pointsDelta > 0 ? "+" : ""}${chosen.topMoment.pointsDelta.toFixed(1)} for them`
    : "the show was quiet on their roster";
  return `Last show ${when} (${chosen.gameLabel}, ${sportNounForContext(chosen.sport)}): ${moment}.`;
}

export function sportNounForContext(sport: SportLeague): string {
  switch (sport) {
    case "nfl": return "NFL";
    case "nba": return "NBA";
    case "wnba": return "WNBA";
    case "mlb": return "MLB";
    case "nhl": return "NHL";
    case "ncaaf": return "college football";
    case "ncaab": return "college basketball";
    case "soccer": return "soccer";
    default: return "fantasy";
  }
}

export function formatRelativeTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    const diff = Date.now() - date.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    if (diff < 604_800_000) return `${Math.round(diff / 86_400_000)}d ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
