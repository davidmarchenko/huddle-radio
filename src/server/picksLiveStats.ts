import type { SportLeague } from "../shared/contracts";
import type { PickStatType } from "../shared/picksContracts";
import { ESPN_SPORTS } from "../providers/espnSportsDataProvider";

/**
 * Fetch ESPN's per-game summary (box score) and extract one numeric
 * value per (player, statType). Used both during the live show (poll
 * every ~30s) and at game-end for settlement.
 *
 * ESPN's site-API summary endpoint is public, JSON, and returns a
 * "boxscore.players[].statistics[]" tree. The shape varies a little
 * by sport — NFL splits athletes into per-skill groups (passing,
 * rushing), NBA puts them into starters/bench groups with one wide
 * stat row, MLB into batting + pitching. We walk all groups and use
 * a per-sport (statType → groupNamePattern + columnHeader) lookup.
 *
 * Cache: short TTL (10s) since live stats matter more than upstream
 * load; the route layer adds CDN headers on top.
 */

type Fetcher = typeof fetch;

const SUMMARY_TTL_MS = 10_000;
const summaryCache = new Map<string, { value: EspnSummary; expiresAt: number }>();
const summaryInflight = new Map<string, Promise<EspnSummary | undefined>>();

type EspnSummary = {
  boxscore?: EspnBoxscore;
  header?: { competitions?: Array<{ status?: { type?: { state?: string; completed?: boolean } } }> };
  rosters?: Array<EspnRoster>;
};

type EspnRoster = {
  homeAway?: "home" | "away";
  team?: { abbreviation?: string; color?: string; logo?: string };
  roster?: Array<{
    athlete?: {
      id?: string | number;
      displayName?: string;
      shortName?: string;
      headshot?: { href?: string };
      position?: { abbreviation?: string };
    };
  }>;
};

type EspnBoxscore = {
  players?: Array<{
    team?: { abbreviation?: string };
    statistics?: Array<EspnStatGroup>;
  }>;
};

type EspnStatGroup = {
  name?: string;          // e.g. "passing", "starters"
  displayName?: string;   // e.g. "Passing", "starters"
  keys?: string[];        // e.g. ["C/ATT", "YDS", ...]
  labels?: string[];
  athletes?: Array<{
    athlete?: { displayName?: string; shortName?: string };
    stats?: string[];
  }>;
};

type StatLookup = {
  /** Matches statGroup.name / displayName. NBA uses "starters"|"bench" — match both. */
  groupNamePattern: RegExp;
  /** Column header inside `keys` (or `labels`) for the value we want. */
  statKey: RegExp;
  /** Optional transform — e.g. "3-7" (made-attempted) → 3. Default: parseFloat. */
  transform?: (raw: string) => number | undefined;
};

const PARSE_MAKES = (raw: string): number | undefined => {
  // "3-7" → 3, "20/30" → 20.
  const m = /^(\d+)/.exec(raw);
  return m ? Number(m[1]) : undefined;
};

const KEYS_BY_SPORT: Record<SportLeague, Partial<Record<PickStatType, StatLookup>>> = {
  nfl: {
    "passing-yards": { groupNamePattern: /^passing$/i, statKey: /^YDS$/i },
    "passing-tds":   { groupNamePattern: /^passing$/i, statKey: /^TD$/i },
    "rushing-yards": { groupNamePattern: /^rushing$/i, statKey: /^YDS$/i },
    "receiving-yards": { groupNamePattern: /^receiving$/i, statKey: /^YDS$/i },
    "receptions":    { groupNamePattern: /^receiving$/i, statKey: /^REC$/i }
  },
  ncaaf: {
    "passing-yards": { groupNamePattern: /^passing$/i, statKey: /^YDS$/i },
    "passing-tds":   { groupNamePattern: /^passing$/i, statKey: /^TD$/i },
    "rushing-yards": { groupNamePattern: /^rushing$/i, statKey: /^YDS$/i },
    "receiving-yards": { groupNamePattern: /^receiving$/i, statKey: /^YDS$/i },
    "receptions":    { groupNamePattern: /^receiving$/i, statKey: /^REC$/i }
  },
  nba: {
    points:    { groupNamePattern: /starters|bench/i, statKey: /^PTS$/i },
    rebounds:  { groupNamePattern: /starters|bench/i, statKey: /^REB$/i },
    assists:   { groupNamePattern: /starters|bench/i, statKey: /^AST$/i },
    threes:    { groupNamePattern: /starters|bench/i, statKey: /^3PT$/i, transform: PARSE_MAKES }
    // pra is computed by sum from points+rebounds+assists — handled below.
  },
  wnba: {
    points:    { groupNamePattern: /starters|bench/i, statKey: /^PTS$/i },
    assists:   { groupNamePattern: /starters|bench/i, statKey: /^AST$/i },
    rebounds:  { groupNamePattern: /starters|bench/i, statKey: /^REB$/i }
  },
  ncaab: {
    points:    { groupNamePattern: /starters|bench/i, statKey: /^PTS$/i },
    rebounds:  { groupNamePattern: /starters|bench/i, statKey: /^REB$/i },
    assists:   { groupNamePattern: /starters|bench/i, statKey: /^AST$/i }
  },
  mlb: {
    hits:                 { groupNamePattern: /^batting$/i, statKey: /^H$/i },
    "total-bases":        { groupNamePattern: /^batting$/i, statKey: /^TB$/i },
    "home-runs":          { groupNamePattern: /^batting$/i, statKey: /^HR$/i },
    "strikeouts-pitcher": { groupNamePattern: /^pitching$/i, statKey: /^K$/i }
  },
  nhl: {
    "shots-on-goal": { groupNamePattern: /forwards|defense|skaters/i, statKey: /^SOG$|^S$/i },
    goals:           { groupNamePattern: /forwards|defense|skaters/i, statKey: /^G$/i }
  },
  soccer: {},
  other: {}
};

/** Result map: `{playerNameLower}` → `{statType → currentValue}`. */
export type LiveStatsMap = Map<string, Partial<Record<PickStatType, number>>>;

export type FetchLiveStatsInput = {
  gameId: string;
  sport: SportLeague;
  /** Player + statType pairs we want values for. Anything not requested is ignored. */
  wants: Array<{ playerName: string; statType: PickStatType }>;
  fetcher?: Fetcher;
};

export async function fetchLiveStats(input: FetchLiveStatsInput): Promise<{
  stats: LiveStatsMap;
  gameCompleted: boolean;
}> {
  const summary = await fetchSummary(input.gameId, input.sport, input.fetcher);
  const stats: LiveStatsMap = new Map();
  if (!summary?.boxscore?.players?.length) {
    return { stats, gameCompleted: isCompleted(summary) };
  }
  for (const want of input.wants) {
    const value = extractStat(summary.boxscore, input.sport, want.playerName, want.statType);
    if (value === undefined) continue;
    const key = want.playerName.toLowerCase();
    const existing = stats.get(key) ?? {};
    existing[want.statType] = value;
    stats.set(key, existing);
  }
  return { stats, gameCompleted: isCompleted(summary) };
}

function isCompleted(summary: EspnSummary | undefined): boolean {
  if (!summary?.header?.competitions?.length) return false;
  return Boolean(summary.header.competitions[0]?.status?.type?.completed);
}

async function fetchSummary(
  gameId: string,
  sport: SportLeague,
  fetcher: Fetcher = fetch
): Promise<EspnSummary | undefined> {
  const path = ESPN_SPORTS.find((entry) => entry.sport === sport)?.path;
  if (!path) return undefined;
  const cacheKey = `${sport}:${gameId}`;
  const cached = summaryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const inflight = summaryInflight.get(cacheKey);
  if (inflight) return inflight;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${encodeURIComponent(gameId)}`;
  const job = (async () => {
    try {
      const response = await fetcher(url, { headers: { accept: "application/json" } });
      if (!response.ok) return undefined;
      const value = (await response.json()) as EspnSummary;
      summaryCache.set(cacheKey, { value, expiresAt: Date.now() + SUMMARY_TTL_MS });
      return value;
    } catch {
      return undefined;
    } finally {
      summaryInflight.delete(cacheKey);
    }
  })();
  summaryInflight.set(cacheKey, job);
  return job;
}

function extractStat(
  boxscore: EspnBoxscore,
  sport: SportLeague,
  playerName: string,
  statType: PickStatType
): number | undefined {
  // pra is a derived stat — sum of three lookups in the same row.
  if (statType === "pra" && (sport === "nba" || sport === "wnba" || sport === "ncaab")) {
    const pts = extractStat(boxscore, sport, playerName, "points");
    const reb = extractStat(boxscore, sport, playerName, "rebounds");
    const ast = extractStat(boxscore, sport, playerName, "assists");
    if (pts === undefined && reb === undefined && ast === undefined) return undefined;
    return (pts ?? 0) + (reb ?? 0) + (ast ?? 0);
  }
  const lookup = KEYS_BY_SPORT[sport]?.[statType];
  if (!lookup) return undefined;
  const target = playerName.toLowerCase().trim();
  for (const teamGroup of boxscore.players ?? []) {
    for (const statGroup of teamGroup.statistics ?? []) {
      const groupName = statGroup.name ?? statGroup.displayName ?? "";
      if (!lookup.groupNamePattern.test(groupName)) continue;
      const keys = statGroup.keys ?? statGroup.labels ?? [];
      const idx = keys.findIndex((k) => lookup.statKey.test(k));
      if (idx < 0) continue;
      for (const athlete of statGroup.athletes ?? []) {
        const display = athlete.athlete?.displayName?.toLowerCase().trim();
        const short = athlete.athlete?.shortName?.toLowerCase().trim();
        if (display === target || short === target || matchesByLastName(display, short, target)) {
          const raw = athlete.stats?.[idx];
          if (!raw) return undefined;
          if (lookup.transform) return lookup.transform(raw);
          const parsed = Number.parseFloat(raw);
          return Number.isFinite(parsed) ? parsed : undefined;
        }
      }
    }
  }
  return undefined;
}

function matchesByLastName(
  display: string | undefined,
  short: string | undefined,
  target: string
): boolean {
  // Polymarket titles often shorten to "Mahomes" — match against the
  // last word of the ESPN displayName so the sparser title still
  // resolves cleanly. Avoid false positives by requiring the target
  // to be a single word.
  if (target.includes(" ")) return false;
  const candidates = [display, short].filter(Boolean) as string[];
  return candidates.some((name) => {
    const last = name.trim().split(/\s+/).pop();
    return last === target;
  });
}

/** Reset for tests. */
export function resetLiveStatsCache(): void {
  summaryCache.clear();
  summaryInflight.clear();
}

export type PlayerMedia = {
  headshot?: string;
  teamAbbr?: string;
  teamColor?: string;
  teamLogo?: string;
  position?: string;
};

/**
 * Build a player-name → media map for picks UI enrichment. Tries
 * multiple sources because ESPN's summary endpoint is unreliable for
 * upcoming games:
 *
 *   1) Summary's `rosters` block (works for some games)
 *   2) Per-team `/teams/{teamId}/roster` endpoint — much more
 *      reliable, returns full athlete records with headshot URLs.
 *      Team IDs are extracted from the team logo URL pattern
 *      (`a.espncdn.com/i/teamlogos/{sport}/500/{teamId}.png`).
 *
 * Keys are stored under multiple variants (full name, last name,
 * shortName) so a market title like "Mahomes" still resolves the
 * headshot of "Patrick Mahomes".
 */
export async function fetchPlayerMediaMap(
  gameId: string,
  sport: SportLeague,
  options: { homeLogoUrl?: string; awayLogoUrl?: string; fetcher?: Fetcher } = {}
): Promise<Map<string, PlayerMedia>> {
  const fetcher = options.fetcher ?? fetch;
  const map = new Map<string, PlayerMedia>();

  // Source 1 — summary rosters (sometimes empty).
  const summary = await fetchSummary(gameId, sport, fetcher);
  for (const teamRoster of summary?.rosters ?? []) {
    addRosterToMap(map, teamRoster.roster ?? [], {
      teamAbbr: teamRoster.team?.abbreviation,
      teamColor: teamRoster.team?.color,
      teamLogo: teamRoster.team?.logo
    });
  }

  // Source 2 — team roster endpoint (much more reliable). Fan out
  // home + away in parallel; if Source 1 already covered them we
  // skip silently when the same name is re-added.
  const teamIds: Array<{ id: string; logoUrl: string }> = [];
  if (options.homeLogoUrl) {
    const id = extractTeamIdFromLogoUrl(options.homeLogoUrl);
    if (id) teamIds.push({ id, logoUrl: options.homeLogoUrl });
  }
  if (options.awayLogoUrl) {
    const id = extractTeamIdFromLogoUrl(options.awayLogoUrl);
    if (id) teamIds.push({ id, logoUrl: options.awayLogoUrl });
  }
  if (teamIds.length > 0) {
    const sportPath = ESPN_SPORTS.find((entry) => entry.sport === sport)?.path;
    if (sportPath) {
      await Promise.all(
        teamIds.map(async ({ id, logoUrl }) => {
          try {
            const teamRoster = await fetchTeamRoster(sportPath, id, fetcher);
            if (!teamRoster) return;
            addRosterToMap(map, teamRoster.athletes ?? [], {
              teamAbbr: teamRoster.team?.abbreviation,
              teamColor: teamRoster.team?.color,
              teamLogo: logoUrl
            });
          } catch {
            // Best-effort — one team's failure doesn't poison the slate.
          }
        })
      );
    }
  }

  return map;
}

type EspnTeamRoster = {
  team?: { abbreviation?: string; color?: string };
  athletes?: Array<{
    id?: string | number;
    displayName?: string;
    fullName?: string;
    shortName?: string;
    headshot?: { href?: string };
    position?: { abbreviation?: string };
  }>;
};

const TEAM_ROSTER_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const teamRosterCache = new Map<string, { value: EspnTeamRoster; expiresAt: number }>();
const teamRosterInflight = new Map<string, Promise<EspnTeamRoster | undefined>>();

async function fetchTeamRoster(
  sportPath: string,
  teamId: string,
  fetcher: Fetcher
): Promise<EspnTeamRoster | undefined> {
  const cacheKey = `${sportPath}:${teamId}`;
  const cached = teamRosterCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const inflight = teamRosterInflight.get(cacheKey);
  if (inflight) return inflight;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/teams/${encodeURIComponent(teamId)}/roster`;
  const job = (async () => {
    try {
      const response = await fetcher(url, { headers: { accept: "application/json" } });
      if (!response.ok) return undefined;
      const value = (await response.json()) as EspnTeamRoster;
      teamRosterCache.set(cacheKey, { value, expiresAt: Date.now() + TEAM_ROSTER_TTL_MS });
      return value;
    } catch {
      return undefined;
    } finally {
      teamRosterInflight.delete(cacheKey);
    }
  })();
  teamRosterInflight.set(cacheKey, job);
  return job;
}

/**
 * ESPN team logos live at:
 *   https://a.espncdn.com/i/teamlogos/{sport}/500/{teamId}.png
 * The teamId is the basename minus the extension (e.g. "12.png" → 12).
 * We parse it out here so callers can hand us the existing team meta
 * without an extra ID lookup.
 */
function extractTeamIdFromLogoUrl(url: string): string | undefined {
  if (!url) return undefined;
  const match = /\/teamlogos\/[^/]+\/(?:500|scoreboard|primary_logo)\/([^/.]+)\.(?:png|svg|jpg)/i.exec(url);
  return match?.[1];
}

type AthleteEntry = {
  athlete?: {
    displayName?: string;
    fullName?: string;
    shortName?: string;
    headshot?: { href?: string };
    position?: { abbreviation?: string };
  };
  // Some endpoints inline athlete fields directly on the entry.
  displayName?: string;
  fullName?: string;
  shortName?: string;
  headshot?: { href?: string };
  position?: { abbreviation?: string };
};

function addRosterToMap(
  map: Map<string, PlayerMedia>,
  entries: AthleteEntry[],
  team: { teamAbbr?: string; teamColor?: string; teamLogo?: string }
): void {
  for (const entry of entries) {
    const a = entry.athlete ?? entry;
    const display = a.displayName ?? a.fullName;
    if (!display) continue;
    const media: PlayerMedia = {
      headshot: a.headshot?.href,
      teamAbbr: team.teamAbbr,
      teamColor: team.teamColor,
      teamLogo: team.teamLogo,
      position: a.position?.abbreviation
    };
    const lower = display.toLowerCase().trim();
    // Only overwrite if we have a better record (i.e. headshot present
    // and the existing one didn't have it).
    const existing = map.get(lower);
    if (!existing || (!existing.headshot && media.headshot)) {
      map.set(lower, media);
    }
    const last = lower.split(/\s+/).pop();
    if (last && last !== lower && !map.has(last)) map.set(last, media);
    if (a.shortName) {
      const short = a.shortName.toLowerCase().trim();
      if (!map.has(short)) map.set(short, media);
    }
  }
}
