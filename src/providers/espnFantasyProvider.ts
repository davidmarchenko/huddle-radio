import type { FantasyLeagueState, FantasyPlayer, FantasyProvider, FantasyRoster, ProviderHealth } from "../shared/contracts";
import { getDefaultPlayerIdResolver, type PlayerIdResolver } from "../server/playerIdResolver";

type Fetcher = typeof fetch;

type EspnLeague = {
  id?: number;
  gameId?: number;
  seasonId?: number;
  settings?: {
    name?: string;
    scoringSettings?: {
      scoringItems?: Array<{ statId?: number; points?: number }>;
    };
  };
  members?: Array<{
    id?: string;
    displayName?: string;
    firstName?: string;
    lastName?: string;
  }>;
  teams?: EspnTeam[];
  schedule?: EspnScheduleItem[];
};

type EspnMember = NonNullable<EspnLeague["members"]>[number];

type EspnTeam = {
  id: number;
  abbrev?: string;
  location?: string;
  nickname?: string;
  owners?: string[];
  roster?: {
    entries?: EspnRosterEntry[];
  };
};

type EspnRosterEntry = {
  lineupSlotId?: number;
  playerId?: number;
  playerPoolEntry?: {
    appliedStatTotal?: number;
    player?: {
      id?: number;
      fullName?: string;
      firstName?: string;
      lastName?: string;
      defaultPositionId?: number;
      proTeamId?: number;
      stats?: Array<{
        appliedTotal?: number;
        scoringPeriodId?: number;
      }>;
    };
  };
};

type EspnScheduleItem = {
  matchupPeriodId?: number;
  home?: {
    teamId?: number;
    totalPoints?: number;
  };
  away?: {
    teamId?: number;
    totalPoints?: number;
  };
};

export class EspnFantasyProvider implements FantasyProvider {
  id = "espn";
  private readonly baseUrl = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

  constructor(
    private readonly options: { swid?: string; espnS2?: string } = {},
    private readonly fetcher: Fetcher = fetch,
    private readonly resolver: PlayerIdResolver = getDefaultPlayerIdResolver()
  ) {}

  async getLeagueState(input: { leagueId?: string; week?: number; season?: number }): Promise<FantasyLeagueState> {
    if (!input.leagueId) {
      throw new Error("ESPN league ID is required.");
    }

    const season = input.season ?? new Date().getFullYear();
    const week = input.week ?? 1;
    const params = new URLSearchParams({
      scoringPeriodId: String(week)
    });
    for (const view of ["mTeam", "mRoster", "mMatchup", "mMatchupScore", "mSettings"]) {
      params.append("view", view);
    }

    const league = await this.getJson<EspnLeague>(`/seasons/${season}/segments/0/leagues/${input.leagueId}?${params.toString()}`);
    return normalizeEspnLeague(league, String(input.leagueId), season, week, { resolver: this.resolver });
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "ESPN Fantasy",
      status: "ready",
      detail: this.options.swid && this.options.espnS2 ? "Configured for ESPN public/private league reads." : "Configured for public ESPN league reads. Private leagues need ESPN_SWID and ESPN_S2."
    };
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: this.cookieHeader()
    });
    if (!response.ok) {
      throw new Error(`ESPN request failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  private cookieHeader() {
    if (!this.options.swid || !this.options.espnS2) return undefined;
    return {
      Cookie: `SWID=${this.options.swid}; espn_s2=${this.options.espnS2}`
    };
  }
}

export function normalizeEspnLeague(
  league: EspnLeague,
  leagueId: string,
  season: number,
  week: number,
  options: { resolver?: PlayerIdResolver } = {}
): FantasyLeagueState {
  const membersById = new Map((league.members ?? []).map((member) => [member.id, member]));
  const rosters = (league.teams ?? []).map((team) => normalizeEspnRoster(team, membersById, week, options));
  const rosterById = new Map(rosters.map((roster) => [roster.id, roster]));

  return {
    provider: "espn",
    leagueId: String(league.id ?? leagueId),
    leagueName: league.settings?.name ?? `ESPN League ${leagueId}`,
    sport: "nfl",
    season: String(league.seasonId ?? season),
    scoringSummary: summarizeEspnScoring(league),
    matchups: normalizeEspnMatchups(league.schedule ?? [], rosterById, week),
    updatedAt: new Date().toISOString()
  };
}

function normalizeEspnRoster(
  team: EspnTeam,
  membersById: Map<string | undefined, EspnMember>,
  week: number,
  options: { resolver?: PlayerIdResolver } = {}
): FantasyRoster {
  const owner = team.owners?.map((ownerId) => membersById.get(ownerId)?.displayName ?? membersById.get(ownerId)?.firstName).find(Boolean);
  const entries = team.roster?.entries ?? [];
  const starters = entries.filter((entry) => !isBenchSlot(entry.lineupSlotId)).map((entry) => normalizeEspnPlayer(entry, week, options));
  const bench = entries.filter((entry) => isBenchSlot(entry.lineupSlotId)).map((entry) => normalizeEspnPlayer(entry, week, options));
  const teamName = [team.location, team.nickname].filter(Boolean).join(" ") || team.abbrev || `Team ${team.id}`;

  return {
    id: String(team.id),
    ownerName: owner ?? teamName,
    teamName,
    starters,
    bench
  };
}

function normalizeEspnPlayer(
  entry: EspnRosterEntry,
  week: number,
  options: { resolver?: PlayerIdResolver } = {}
): FantasyPlayer {
  const player = entry.playerPoolEntry?.player;
  const weeklyStat = player?.stats?.find((stat) => stat.scoringPeriodId === week);
  const espnId = String(player?.id ?? entry.playerId ?? "unknown");
  // ESPN player IDs live in their own namespace. Resolve to Sleeper-
  // canonical so the same player on a Sleeper roster and an ESPN roster
  // surfaces under the same id.
  const canonicalId = options.resolver
    ? options.resolver.resolve({ provider: "espn", externalId: espnId, sport: "nfl" })
    : espnId;
  return {
    id: canonicalId,
    name: player?.fullName ?? ([player?.firstName, player?.lastName].filter(Boolean).join(" ") || `Player ${entry.playerId ?? "unknown"}`),
    position: positionName(player?.defaultPositionId),
    proTeam: proTeamName(player?.proTeamId),
    projectedPoints: 0,
    currentPoints: Number((entry.playerPoolEntry?.appliedStatTotal ?? weeklyStat?.appliedTotal ?? 0).toFixed(1))
  };
}

function normalizeEspnMatchups(schedule: EspnScheduleItem[], rosterById: Map<string, FantasyRoster>, week: number) {
  const periodSchedule = schedule.filter((item) => item.matchupPeriodId === week);
  const matchups = periodSchedule
    .map((item, index) => {
      const rosters = [item.home?.teamId, item.away?.teamId].map((teamId) => (teamId ? rosterById.get(String(teamId)) : undefined)).filter((roster): roster is FantasyRoster => Boolean(roster));
      return {
        id: `espn-${week}-${index + 1}`,
        week,
        rosters
      };
    })
    .filter((matchup) => matchup.rosters.length > 0);

  if (matchups.length) return matchups;
  return [
    {
      id: `espn-${week}-all`,
      week,
      rosters: [...rosterById.values()]
    }
  ];
}

function summarizeEspnScoring(league: EspnLeague) {
  const itemCount = league.settings?.scoringSettings?.scoringItems?.length ?? 0;
  return itemCount ? `ESPN scoring with ${itemCount} scoring items.` : "ESPN league scoring settings.";
}

function isBenchSlot(slotId?: number) {
  return slotId === 20 || slotId === 21;
}

function positionName(positionId?: number) {
  const positions: Record<number, string> = {
    1: "QB",
    2: "RB",
    3: "WR",
    4: "TE",
    5: "K",
    16: "D/ST"
  };
  return positionId ? positions[positionId] ?? "FLEX" : "FLEX";
}

function proTeamName(teamId?: number) {
  const teams: Record<number, string> = {
    1: "ATL",
    2: "BUF",
    3: "CHI",
    4: "CIN",
    5: "CLE",
    6: "DAL",
    7: "DEN",
    8: "DET",
    9: "GB",
    10: "TEN",
    11: "IND",
    12: "KC",
    13: "LV",
    14: "LAR",
    15: "MIA",
    16: "MIN",
    17: "NE",
    18: "NO",
    19: "NYG",
    20: "NYJ",
    21: "PHI",
    22: "ARI",
    23: "PIT",
    24: "LAC",
    25: "SF",
    26: "SEA",
    27: "TB",
    28: "WSH",
    29: "CAR",
    30: "JAX",
    33: "BAL",
    34: "HOU"
  };
  return teamId ? teams[teamId] ?? `NFL-${teamId}` : "FA";
}
