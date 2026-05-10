import type { FantasyImpact, FantasyLeagueState, SportsPlay } from "../shared/contracts";

export function rankFantasyImpacts(league: FantasyLeagueState, play: SportsPlay): FantasyImpact[] {
  const impacts: FantasyImpact[] = [];

  for (const matchup of league.matchups) {
    for (const roster of matchup.rosters) {
      const rosterPlayers = [...roster.starters, ...roster.bench];
      for (const player of rosterPlayers) {
        if (!play.playerIds.includes(player.id)) continue;
        const isStarter = roster.starters.some((starter) => starter.id === player.id);
        const starterMultiplier = isStarter ? 1 : 0.15;
        const baseDelta = estimatePointsDelta(play, player.position);
        const pointsDelta = Number((baseDelta * starterMultiplier).toFixed(1));
        impacts.push({
          rosterId: roster.id,
          ownerName: roster.ownerName,
          teamName: roster.teamName,
          playerName: player.name,
          isStarter,
          pointsDelta,
          reason: `${play.headline} affected ${player.name}${isStarter ? "'s starting" : "'s bench"} ${player.position} slot.`
        });
      }
    }
  }

  return impacts.sort((a, b) => Math.abs(b.pointsDelta) - Math.abs(a.pointsDelta)).slice(0, 5);
}

function estimatePointsDelta(play: SportsPlay, position: string): number {
  const lower = play.description.toLowerCase();
  if (play.type === "turnover" || lower.includes("intercepted") || lower.includes("fumble")) {
    return position === "QB" ? -2 : -1.5;
  }
  const touchdown = play.type === "touchdown" || lower.includes("touchdown");
  const receptionBonus = ["WR", "TE", "RB"].includes(position) && (lower.includes("catch") || lower.includes("catches") || lower.includes("hauls in")) ? 0.5 : 0;
  if (touchdown) return (position === "QB" ? 4 : 6) + receptionBonus;
  const yards = lower.match(/(\d+)\s*yards?/);
  if (!yards) return 1 + receptionBonus;
  const yardValue = Number(yards[1]) / 10;
  return position === "QB" ? Number((yardValue / 2.5).toFixed(1)) : Number((yardValue + receptionBonus).toFixed(1));
}
