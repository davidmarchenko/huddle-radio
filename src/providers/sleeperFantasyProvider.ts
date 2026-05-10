import type { FantasyLeagueState, FantasyPlayer, FantasyProvider, FantasyRoster, ProviderHealth, SportLeague } from "../shared/contracts";
import { getDefaultPlayerIdResolver, type PlayerIdResolver } from "../server/playerIdResolver";

type Fetcher = typeof fetch;

type SleeperLeague = {
  league_id: string;
  name: string;
  sport: string;
  season: string;
  scoring_settings?: Record<string, number>;
};

type SleeperRoster = {
  roster_id: number;
  owner_id?: string;
  starters?: string[];
  players?: string[];
  settings?: {
    fpts?: number;
    fpts_decimal?: number;
  };
};

type SleeperUser = {
  user_id: string;
  display_name?: string;
  username?: string;
  metadata?: {
    team_name?: string;
  };
};

type SleeperMatchup = {
  roster_id: number;
  matchup_id: number;
  points?: number;
  starters?: string[];
  players?: string[];
};

type SleeperPlayer = {
  full_name?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  team?: string;
};

export class SleeperFantasyProvider implements FantasyProvider {
  id = "sleeper";
  private readonly baseUrl = "https://api.sleeper.app/v1";
  private playerCache?: Record<string, SleeperPlayer>;

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly resolver: PlayerIdResolver = getDefaultPlayerIdResolver()
  ) {}

  async getLeagueState(input: { leagueId?: string; week?: number }): Promise<FantasyLeagueState> {
    if (!input.leagueId) {
      throw new Error("Sleeper league ID is required.");
    }

    const [league, rosters, users, matchups] = await Promise.all([
      this.getJson<SleeperLeague>(`/league/${input.leagueId}`),
      this.getJson<SleeperRoster[]>(`/league/${input.leagueId}/rosters`),
      this.getJson<SleeperUser[]>(`/league/${input.leagueId}/users`),
      this.getJson<SleeperMatchup[]>(`/league/${input.leagueId}/matchups/${input.week ?? 1}`)
    ]);

    const players = await this.getPlayers();
    const usersById = new Map(users.map((user) => [user.user_id, user]));
    const matchupsByRoster = new Map(matchups.map((matchup) => [String(matchup.roster_id), matchup]));

    const sport: SportLeague = league.sport === "nfl" ? "nfl" : "other";
    const fantasyRosters = rosters.map((roster) => {
      const user = roster.owner_id ? usersById.get(roster.owner_id) : undefined;
      const matchup = matchupsByRoster.get(String(roster.roster_id));
      return normalizeSleeperRoster(roster, user, matchup, players, { resolver: this.resolver, sport });
    });

    return {
      provider: "sleeper",
      leagueId: league.league_id,
      leagueName: league.name,
      sport,
      season: league.season,
      scoringSummary: summarizeScoring(league.scoring_settings),
      matchups: groupSleeperMatchups(matchups, fantasyRosters, input.week ?? 1),
      updatedAt: new Date().toISOString()
    };
  }

  async health(): Promise<ProviderHealth> {
    const start = performance.now();
    try {
      await this.getJson("/state/nfl");
      return {
        id: this.id,
        label: "Sleeper Fantasy",
        status: "ready",
        detail: "Sleeper API reachable.",
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (error) {
      return {
        id: this.id,
        label: "Sleeper Fantasy",
        status: "error",
        detail: error instanceof Error ? error.message : "Sleeper API health check failed."
      };
    }
  }

  private async getPlayers(): Promise<Record<string, SleeperPlayer>> {
    if (!this.playerCache) {
      this.playerCache = await this.getJson<Record<string, SleeperPlayer>>("/players/nfl");
    }
    return this.playerCache;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`);
    if (!response.ok) {
      throw new Error(`Sleeper request failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }
}

export function normalizeSleeperRoster(
  roster: SleeperRoster,
  user: SleeperUser | undefined,
  matchup: SleeperMatchup | undefined,
  players: Record<string, SleeperPlayer>,
  options: { resolver?: PlayerIdResolver; sport?: SportLeague } = {}
): FantasyRoster {
  const starterIds = matchup?.starters ?? roster.starters ?? [];
  const playerIds = matchup?.players ?? roster.players ?? starterIds;
  const starterSet = new Set(starterIds);
  const resolver = options.resolver;
  const sport = options.sport ?? "nfl";

  const normalizePlayer = (playerId: string): FantasyPlayer => {
    const player = players[playerId] ?? {};
    const name = player.full_name ?? ([player.first_name, player.last_name].filter(Boolean).join(" ") || playerId);
    // Sleeper IDs ARE canonical for NFL — passthrough on miss keeps the
    // raw Sleeper id so demo rosters and unknown new draftees still match
    // against scoreboard data that comes through the same canonical path.
    const canonicalId = resolver
      ? resolver.resolveOrPassthrough({ provider: "sleeper", externalId: playerId, sport })
      : playerId;
    return {
      id: canonicalId,
      name,
      position: player.position ?? "FLEX",
      proTeam: player.team ?? "FA",
      projectedPoints: 0,
      currentPoints: starterSet.has(playerId) ? matchup?.points ?? roster.settings?.fpts ?? 0 : 0
    };
  };

  return {
    id: String(roster.roster_id),
    ownerName: user?.display_name ?? user?.username ?? `Roster ${roster.roster_id}`,
    teamName: user?.metadata?.team_name ?? user?.display_name ?? `Roster ${roster.roster_id}`,
    starters: starterIds.map(normalizePlayer),
    bench: playerIds.filter((playerId) => !starterSet.has(playerId)).map(normalizePlayer)
  };
}

function groupSleeperMatchups(matchups: SleeperMatchup[], rosters: FantasyRoster[], week: number) {
  const rosterById = new Map(rosters.map((roster) => [roster.id, roster]));
  const grouped = new Map<number, FantasyRoster[]>();

  for (const matchup of matchups) {
    const roster = rosterById.get(String(matchup.roster_id));
    if (!roster) continue;
    const group = grouped.get(matchup.matchup_id) ?? [];
    group.push(roster);
    grouped.set(matchup.matchup_id, group);
  }

  return [...grouped.entries()].map(([matchupId, matchupRosters]) => ({
    id: `sleeper-${matchupId}`,
    week,
    rosters: matchupRosters
  }));
}

function summarizeScoring(scoring?: Record<string, number>): string {
  if (!scoring) return "Sleeper league scoring settings.";
  const ppr = scoring.rec ?? 0;
  const passTd = scoring.pass_td ?? 0;
  return `${ppr} PPR, ${passTd}-point passing touchdowns.`;
}
