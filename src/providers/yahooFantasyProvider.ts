import type { FantasyLeagueState, FantasyMatchup, FantasyPlayer, FantasyProvider, FantasyRoster, ProviderHealth } from "../shared/contracts";

type Fetcher = typeof fetch;

/**
 * Yahoo Fantasy Sports provider.
 *
 * Roughly a third of the U.S. fantasy market and entirely missing
 * before W5. Yahoo's REST API is XML-first but accepts `?format=json`,
 * which is far easier to parse than the alternative. The JSON shape
 * still mirrors the XML structure (deeply nested arrays of objects),
 * so the normalizers below pull through that shape rather than a more
 * idiomatic JSON tree.
 *
 * Token plumbing lives in `yahooTokenStore.ts`; this class just takes
 * an `accessTokenProvider` that the route layer wires up per-listener.
 */

export type AccessTokenProvider = () => Promise<string | undefined>;

const BASE_URL = "https://fantasysports.yahooapis.com/fantasy/v2";

type YahooLeagueResponse = {
  fantasy_content?: {
    league?: Array<{
      league_id?: string;
      league_key?: string;
      name?: string;
      season?: string;
      current_week?: string | number;
      scoring_type?: string;
      teams?: { count?: number; [index: string]: unknown };
    }>;
  };
};

type YahooTeamRosterResponse = {
  fantasy_content?: {
    team?: Array<unknown>;
  };
};

export class YahooFantasyProvider implements FantasyProvider {
  id = "yahoo";

  constructor(
    private readonly accessTokenProvider: AccessTokenProvider,
    private readonly fetcher: Fetcher = fetch
  ) {}

  async getLeagueState(input: { leagueId?: string; week?: number }): Promise<FantasyLeagueState> {
    if (!input.leagueId) {
      throw new Error("Yahoo league key is required (format: <game>.l.<id>, e.g. nfl.l.123456).");
    }
    const accessToken = await this.accessTokenProvider();
    if (!accessToken) {
      throw new Error("Yahoo access token missing. Run the OAuth flow first.");
    }

    const headers = { Authorization: `Bearer ${accessToken}` };

    const leagueRes = await this.fetcher(`${BASE_URL}/league/${encodeURIComponent(input.leagueId)};out=settings,scoreboard,standings?format=json`, { headers });
    if (!leagueRes.ok) {
      throw new Error(`Yahoo league request failed: ${leagueRes.status} ${leagueRes.statusText}`);
    }
    const leagueJson = (await leagueRes.json()) as YahooLeagueResponse;

    return normalizeYahooLeague(leagueJson, { leagueKey: input.leagueId, week: input.week });
  }

  async health(): Promise<ProviderHealth> {
    const accessToken = await this.accessTokenProvider();
    return {
      id: this.id,
      label: "Yahoo Fantasy",
      status: accessToken ? "ready" : "disabled",
      detail: accessToken ? "OAuth token present. Yahoo Fantasy reads enabled." : "No OAuth token. Run /api/fantasy/yahoo/auth-url to connect."
    };
  }
}

/**
 * Pull the parts of the deeply-nested Yahoo JSON shape we actually
 * need into the shared `FantasyLeagueState` contract. Exported for
 * direct unit testing — the network request is mocked at the provider
 * level above.
 */
export function normalizeYahooLeague(
  payload: YahooLeagueResponse,
  hints: { leagueKey: string; week?: number }
): FantasyLeagueState {
  const leagueArray = payload.fantasy_content?.league ?? [];
  const leagueMeta = (leagueArray.find((entry) => typeof entry === "object" && entry && "league_id" in entry) ?? {}) as Record<string, unknown>;
  const leagueId = String(leagueMeta.league_id ?? hints.leagueKey);
  const leagueName = String(leagueMeta.name ?? `Yahoo League ${leagueId}`);
  const season = String(leagueMeta.season ?? new Date().getFullYear());
  const currentWeek = Number(leagueMeta.current_week ?? hints.week ?? 1) || 1;

  // Yahoo's JSON response interleaves objects and a `teams` collection
  // keyed numerically. Find that block and extract.
  const teamsBlock = leagueArray.find((entry) => entry && typeof entry === "object" && "teams" in entry) as Record<string, unknown> | undefined;
  const teamsCollection = (teamsBlock?.teams ?? {}) as Record<string, unknown>;
  const teamCount = Number((teamsCollection as { count?: number }).count ?? 0);

  const rosters: FantasyRoster[] = [];
  for (let i = 0; i < teamCount; i++) {
    const slot = (teamsCollection as Record<string, unknown>)[String(i)];
    const team = (slot as { team?: unknown[] })?.team;
    if (!Array.isArray(team)) continue;
    rosters.push(normalizeYahooTeam(team));
  }

  const matchups: FantasyMatchup[] = rosters.length
    ? [{ id: `yahoo-${currentWeek}-all`, week: currentWeek, rosters }]
    : [];

  return {
    provider: "yahoo",
    leagueId,
    leagueName,
    sport: "nfl", // Yahoo supports multiple sports; the league_key prefix encodes which. Default NFL until the caller passes hints.
    season,
    scoringSummary: leagueMeta.scoring_type ? `Yahoo ${String(leagueMeta.scoring_type)}` : "Yahoo league scoring.",
    matchups,
    updatedAt: new Date().toISOString()
  };
}

function normalizeYahooTeam(team: unknown[]): FantasyRoster {
  // Yahoo team responses are an array where the first element is an
  // array of metadata key/value pairs and the rest are objects keyed
  // by the relevant view (`roster`, `team_points`, etc.).
  const meta = Array.isArray(team[0]) ? (team[0] as Array<Record<string, unknown>>) : [];
  let teamKey = "unknown";
  let teamId = "unknown";
  let teamName = "Yahoo Team";
  let managerName = "Yahoo Manager";
  for (const entry of meta) {
    if (typeof entry !== "object" || !entry) continue;
    if (typeof entry.team_key === "string") teamKey = entry.team_key;
    if (typeof entry.team_id === "string" || typeof entry.team_id === "number") teamId = String(entry.team_id);
    if (typeof entry.name === "string") teamName = entry.name;
    if (Array.isArray(entry.managers)) {
      const manager = (entry.managers as Array<Record<string, unknown>>).find((m) => m && typeof (m as { manager?: { nickname?: string } }).manager?.nickname === "string");
      if (manager) managerName = String(((manager as { manager: { nickname?: string } }).manager.nickname ?? managerName));
    }
  }

  // Roster + bench split is post-hoc: Yahoo returns `selected_position`
  // for each player. We treat anything not in BN as a starter.
  const rosterBlock = team.find((entry) => entry && typeof entry === "object" && "roster" in (entry as object)) as { roster?: { "0"?: { players?: Record<string, unknown> } } } | undefined;
  const playersCollection = (rosterBlock?.roster?.["0"]?.players ?? {}) as Record<string, unknown>;
  const playerCount = Number((playersCollection as { count?: number }).count ?? 0);

  const starters: FantasyPlayer[] = [];
  const bench: FantasyPlayer[] = [];
  for (let i = 0; i < playerCount; i++) {
    const slot = (playersCollection as Record<string, unknown>)[String(i)];
    const player = (slot as { player?: unknown[] })?.player;
    if (!Array.isArray(player)) continue;
    const normalized = normalizeYahooPlayer(player);
    if (normalized.bench) bench.push(normalized.player);
    else starters.push(normalized.player);
  }

  return {
    id: teamId !== "unknown" ? teamId : teamKey,
    ownerName: managerName,
    teamName,
    starters,
    bench
  };
}

function normalizeYahooPlayer(player: unknown[]): { player: FantasyPlayer; bench: boolean } {
  const metaEntries = Array.isArray(player[0]) ? (player[0] as Array<Record<string, unknown>>) : [];
  let playerId = "unknown";
  let name = "Player";
  let position = "FLEX";
  let team = "FA";
  let bench = false;
  for (const entry of metaEntries) {
    if (typeof entry !== "object" || !entry) continue;
    if (typeof entry.player_id === "string" || typeof entry.player_id === "number") playerId = String(entry.player_id);
    if (typeof entry.player_key === "string" && playerId === "unknown") playerId = entry.player_key;
    if (typeof entry.name === "object" && entry.name && typeof (entry.name as { full?: string }).full === "string") name = (entry.name as { full: string }).full;
    if (typeof entry.display_position === "string") position = entry.display_position;
    if (typeof entry.editorial_team_abbr === "string") team = entry.editorial_team_abbr;
  }
  const positionBlock = player.find((entry) => entry && typeof entry === "object" && "selected_position" in (entry as object)) as { selected_position?: Array<Record<string, unknown>> } | undefined;
  const selected = positionBlock?.selected_position ?? [];
  for (const entry of selected) {
    if (entry && typeof (entry as { position?: unknown }).position === "string") {
      const slot = (entry as { position: string }).position;
      if (slot === "BN" || slot === "IR") bench = true;
    }
  }

  return {
    player: {
      id: playerId,
      name,
      position,
      proTeam: team,
      projectedPoints: 0,
      currentPoints: 0
    },
    bench
  };
}

/**
 * Build the Yahoo OAuth consent URL. Pure helper so the route layer
 * can return it without instantiating the provider.
 */
export function buildYahooAuthUrl(input: { clientId: string; redirectUri: string; state?: string; language?: string }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    language: input.language ?? "en-us"
  });
  if (input.state) params.set("state", input.state);
  return `https://api.login.yahoo.com/oauth2/request_auth?${params.toString()}`;
}

export type YahooTokenExchangeResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  xoauth_yahoo_guid?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

/**
 * Exchange an authorization code for a token pair. Pure HTTP function
 * so the route layer can call it without owning fetch internals.
 */
export async function exchangeYahooAuthCode(
  input: { code: string; clientId: string; clientSecret: string; redirectUri: string },
  fetcher: Fetcher = fetch
): Promise<YahooTokenExchangeResponse> {
  const response = await fetcher("https://api.login.yahoo.com/oauth2/get_token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${base64(`${input.clientId}:${input.clientSecret}`)}`
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri
    }).toString()
  });
  return (await response.json()) as YahooTokenExchangeResponse;
}

/**
 * Refresh an access token. Same surface as `exchangeYahooAuthCode`.
 */
export async function refreshYahooAccessToken(
  input: { refreshToken: string; clientId: string; clientSecret: string; redirectUri: string },
  fetcher: Fetcher = fetch
): Promise<YahooTokenExchangeResponse> {
  const response = await fetcher("https://api.login.yahoo.com/oauth2/get_token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${base64(`${input.clientId}:${input.clientSecret}`)}`
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      redirect_uri: input.redirectUri
    }).toString()
  });
  return (await response.json()) as YahooTokenExchangeResponse;
}

function base64(input: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(input, "utf8").toString("base64");
  return btoa(input);
}
