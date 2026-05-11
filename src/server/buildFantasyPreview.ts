import type { FantasyImportPreview, FantasyLeagueState } from "../shared/contracts";

/**
 * Pure summary of a loaded fantasy league: counts + readiness checks
 * the producer panel uses to render the "league import" badge. Lives
 * in its own module so the Next.js /api/fantasy/preview route can
 * import it without dragging Fastify into the bundle.
 */
export function buildFantasyPreview(
  league: FantasyLeagueState,
  providerMode: "demo" | "sleeper" | "espn",
  requestedWeek?: number
): FantasyImportPreview {
  const rosters = league.matchups.flatMap((matchup) => matchup.rosters);
  const players = new Map<string, { proTeam: string }>();
  let starterCount = 0;
  let benchCount = 0;
  let missingRosterNames = 0;
  let missingPlayerTeams = 0;

  for (const roster of rosters) {
    if (!roster.ownerName || roster.ownerName.startsWith("Roster ")) missingRosterNames += 1;
    starterCount += roster.starters.length;
    benchCount += roster.bench.length;
    for (const player of [...roster.starters, ...roster.bench]) {
      players.set(player.id, { proTeam: player.proTeam });
      if (!player.proTeam || player.proTeam === "FA") missingPlayerTeams += 1;
    }
  }

  const summary = {
    leagueName: league.leagueName,
    season: league.season,
    week: requestedWeek ?? league.matchups[0]?.week ?? 1,
    rosterCount: rosters.length,
    matchupCount: league.matchups.length,
    playerCount: players.size,
    starterCount,
    benchCount,
    missingRosterNames,
    missingPlayerTeams
  };

  const readiness = [
    {
      id: "league-load",
      label: "League loaded",
      ok: true,
      detail: `${league.leagueName} loaded from ${providerMode}.`
    },
    {
      id: "matchups",
      label: "Matchups found",
      ok: summary.matchupCount > 0 && summary.rosterCount > 0,
      detail: `${summary.matchupCount} matchup(s), ${summary.rosterCount} roster(s).`
    },
    {
      id: "players",
      label: "Players normalized",
      ok: summary.playerCount > 0,
      detail: `${summary.playerCount} unique player(s), ${summary.starterCount} starters.`
    },
    {
      id: "teams",
      label: "NFL teams available",
      ok: summary.missingPlayerTeams === 0,
      detail: summary.missingPlayerTeams ? `${summary.missingPlayerTeams} player(s) missing NFL teams.` : "All normalized players have teams."
    }
  ];

  return {
    ok: readiness.every((item) => item.ok),
    providerMode,
    league,
    summary,
    readiness,
    message: readiness.every((item) => item.ok) ? "League is ready for livecast." : "League loaded, but some fields need attention."
  };
}
