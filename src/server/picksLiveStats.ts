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
