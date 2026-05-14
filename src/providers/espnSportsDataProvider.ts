import type { ProviderHealth, SportLeague, SportsDataProvider, SportsGameOption, SportsGameState, SportsPlay } from "../shared/contracts";
import { getDefaultPlayerIdResolver, type PlayerIdResolver } from "../server/playerIdResolver";

type Fetcher = typeof fetch;

export type EspnSportPath = {
  sport: SportLeague;
  label: string;
  path: string;
};

export const ESPN_SPORTS: EspnSportPath[] = [
  { sport: "nfl", label: "NFL", path: "football/nfl" },
  { sport: "ncaaf", label: "NCAAF", path: "football/college-football" },
  { sport: "nba", label: "NBA", path: "basketball/nba" },
  { sport: "wnba", label: "WNBA", path: "basketball/wnba" },
  { sport: "ncaab", label: "NCAAM", path: "basketball/mens-college-basketball" },
  { sport: "mlb", label: "MLB", path: "baseball/mlb" },
  { sport: "nhl", label: "NHL", path: "hockey/nhl" }
];

type EspnScoreboard = {
  events?: EspnEvent[];
};

type EspnEvent = {
  id: string;
  name?: string;
  shortName?: string;
  date?: string;
  status?: EspnStatus;
  competitions?: EspnCompetition[];
};

type EspnStatus = {
  displayClock?: string;
  period?: number;
  type?: {
    state?: "pre" | "in" | "post";
    name?: string;
    description?: string;
    detail?: string;
    shortDetail?: string;
    completed?: boolean;
  };
};

type EspnSummary = {
  plays?: EspnSummaryPlay[];
  drives?: { previous?: Array<{ plays?: EspnSummaryPlay[] }> };
};

type EspnSummaryPlay = {
  id?: string;
  text?: string;
  type?: { text?: string };
  scoringPlay?: boolean;
  period?: { number?: number };
  clock?: { displayValue?: string };
  team?: { abbreviation?: string; id?: string };
  start?: { team?: { abbreviation?: string } };
  awayScore?: number;
  homeScore?: number;
  wallclock?: string;
  athletesInvolved?: Array<{ id?: string | number; displayName?: string }>;
};

type EspnCompetition = {
  id?: string;
  status?: EspnStatus;
  situation?: {
    possession?: string;
    downDistanceText?: string;
    lastPlay?: {
      id?: string;
      text?: string;
      type?: {
        text?: string;
      };
      probability?: {
        homeWinPercentage?: number;
      };
      athletesInvolved?: Array<{
        id?: string | number;
        displayName?: string;
        position?: { abbreviation?: string };
      }>;
    };
  };
  broadcasts?: Array<{
    market?: "national" | "home" | "away" | string;
    names?: string[];
  }>;
  competitors?: Array<{
    homeAway?: "home" | "away";
    score?: string;
    team?: {
      id?: string;
      abbreviation?: string;
      displayName?: string;
      shortDisplayName?: string;
      logo?: string;
      color?: string;
      alternateColor?: string;
    };
  }>;
};

export class EspnSportsDataProvider implements SportsDataProvider {
  id = "espn-scoreboard";
  private readonly baseUrl: string;
  private readonly sport: SportLeague;
  private recentPlays: SportsPlay[] = [];

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly preferredGameId?: string,
    sportPath: EspnSportPath = ESPN_SPORTS[0],
    private readonly resolver: PlayerIdResolver = getDefaultPlayerIdResolver()
  ) {
    this.sport = sportPath.sport;
    this.baseUrl = `https://site.api.espn.com/apis/site/v2/sports/${sportPath.path}/scoreboard`;
  }

  async getGameState(): Promise<SportsGameState> {
    const event = await this.getPrimaryEvent();
    // Seed `recentPlays` from ESPN's per-event summary endpoint so a
    // listener entering a game in progress sees actual history
    // (e.g. last 8 baskets, last 8 plays of a drive) instead of an
    // empty feed waiting on the next cadence tick. We do this once
    // per provider instance — `nextPlay` keeps the array fresh from
    // there. Best-effort: failure (404, network blip, unknown shape)
    // just leaves the array empty and we degrade to "wait for next
    // tick" as before.
    if (this.recentPlays.length === 0) {
      const seed = await this.fetchHistoryPlays(event);
      if (seed.length > 0) this.recentPlays = seed;
    }
    return this.normalizeGameState(event);
  }

  async nextPlay(): Promise<SportsPlay> {
    const event = await this.getPrimaryEvent();
    const play = this.normalizePlay(event);
    this.recentPlays = [play, ...this.recentPlays.filter((item) => item.id !== play.id)].slice(0, 8).reverse();
    return play;
  }

  /**
   * Hit ESPN's `summary?event=<id>` endpoint to pull the game's
   * actual play log, then map the last few entries to our
   * `SportsPlay` shape. ESPN returns `plays` (basketball, soccer,
   * hockey) or nests them under `drives.previous[].plays` (football)
   * — we handle the flat case here and fall back to empty for
   * football for now (drives parsing would need its own pass).
   */
  private async fetchHistoryPlays(event: EspnEvent): Promise<SportsPlay[]> {
    try {
      const summaryUrl = `${this.baseUrl.replace(/\/scoreboard$/, "/summary")}?event=${encodeURIComponent(event.id)}`;
      const response = await this.fetcher(summaryUrl);
      if (!response.ok) return [];
      const summary = (await response.json()) as EspnSummary;
      const flat = Array.isArray(summary.plays) ? summary.plays : [];
      const fromDrives = Array.isArray(summary.drives?.previous)
        ? summary.drives.previous.flatMap((drive) => Array.isArray(drive?.plays) ? drive.plays : [])
        : [];
      const rawPlays = flat.length > 0 ? flat : fromDrives;
      if (rawPlays.length === 0) return [];
      const competition = event.competitions?.[0];
      const away = competition?.competitors?.find((c) => c.homeAway === "away");
      const home = competition?.competitors?.find((c) => c.homeAway === "home");
      // ESPN orders plays oldest-first; take the last 8 (most recent)
      // and KEEP them in chronological order so the client (which
      // expects newest-first via .reverse() on the bootstrap path)
      // gets a consistent shape.
      const recent = rawPlays.slice(-8);
      return recent.map((play, index) => this.normalizeSummaryPlay(play, event, away, home, index));
    } catch {
      return [];
    }
  }

  private normalizeSummaryPlay(
    play: EspnSummaryPlay,
    event: EspnEvent,
    away: NonNullable<EspnCompetition["competitors"]>[number] | undefined,
    home: NonNullable<EspnCompetition["competitors"]>[number] | undefined,
    fallbackIndex: number
  ): SportsPlay {
    const description = play.text ?? "Live update.";
    const period = play.period?.number ?? 0;
    const clock = play.clock?.displayValue ?? "0:00";
    const teamAbbr = play.team?.abbreviation ?? play.start?.team?.abbreviation ?? "";
    const playerIds = (play.athletesInvolved ?? [])
      .map((athlete) => athlete?.id)
      .filter((id): id is string | number => id !== undefined && id !== null && id !== "")
      .map((id) => this.resolver.resolve({ provider: "espn", externalId: id, sport: this.sport }));
    return {
      id: play.id ? `espn-${event.id}-history-${play.id}` : `espn-${event.id}-history-${fallbackIndex}`,
      type: playType(play.type?.text ?? description),
      excitement: play.scoringPlay ? 4 : 2,
      clock,
      quarter: period > 0 ? `Q${period}` : "",
      possession: teamAbbr || away?.team?.abbreviation || "",
      headline: play.type?.text ?? "Play",
      description,
      playerIds,
      team: teamAbbr || away?.team?.abbreviation || "",
      score: {
        away: Number(play.awayScore ?? away?.score ?? 0),
        home: Number(play.homeScore ?? home?.score ?? 0)
      },
      occurredAt: play.wallclock ?? new Date().toISOString()
    };
  }

  async health(): Promise<ProviderHealth> {
    const start = performance.now();
    try {
      const response = await this.fetcher(`${this.baseUrl}?limit=1`);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return {
        id: this.id,
        label: "ESPN Scoreboard",
        status: "ready",
        detail: "Public ESPN NFL scoreboard reachable. Live play detail depends on game state.",
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (error) {
      return {
        id: this.id,
        label: "ESPN Scoreboard",
        status: "error",
        detail: error instanceof Error ? error.message : "ESPN scoreboard health check failed."
      };
    }
  }

  async listGames(): Promise<SportsGameOption[]> {
    // 7-day window × peak-season MLB (~15 games/day) easily exceeds 25
    // events. Bumped so we don't silently drop the back half of the
    // week's slate.
    const scoreboard = await this.fetchScoreboard(120);
    return (scoreboard.events ?? []).map((event) => normalizeGameOption(event, this.sport));
  }

  private async getPrimaryEvent(): Promise<EspnEvent> {
    const scoreboard = await this.fetchScoreboard(120);
    const preferred = this.preferredGameId ? scoreboard.events?.find((event) => event.id === this.preferredGameId) : undefined;
    const liveEvent = scoreboard.events?.find((event) => event.status?.type?.state === "in");
    const nextEvent = scoreboard.events?.find((event) => event.status?.type?.state === "pre");
    const event = preferred ?? liveEvent ?? nextEvent ?? scoreboard.events?.[0];
    if (!event) throw new Error("ESPN scoreboard returned no NFL events.");
    return event;
  }

  private async fetchScoreboard(limit: number): Promise<EspnScoreboard> {
    // ESPN's scoreboard defaults to today's slate. For sports that don't
    // play every day (NFL: Sun/Mon/Thu, NHL/NBA: variable, etc.) that
    // means an empty Upcoming section everywhere except wherever the
    // sport's offseason scoreboard happens to surface a far-future
    // event (notably college football). Querying a 7-day window so all
    // sports contribute genuine "next 7 days" upcoming games.
    const dates = scoreboardDateRange(new Date(), 7);
    const response = await this.fetcher(`${this.baseUrl}?limit=${limit}&dates=${dates}`);
    // 404 from the scoreboard date-range endpoint means the sport has
    // no events scheduled in this window — typically because it's the
    // offseason (e.g. NCAAM in May). Treat it as an empty slate rather
    // than a hard failure, otherwise the discover page surfaces a
    // misleading "temporarily unavailable" notice for sports that are
    // simply not in season.
    if (response.status === 404) return { events: [] };
    if (!response.ok) throw new Error(`ESPN scoreboard request failed: ${response.status} ${response.statusText}`);
    return (await response.json()) as EspnScoreboard;
  }

  private normalizeGameState(event: EspnEvent): SportsGameState {
    const competition = event.competitions?.[0];
    const away = competition?.competitors?.find((competitor) => competitor.homeAway === "away");
    const home = competition?.competitors?.find((competitor) => competitor.homeAway === "home");
    const play = this.recentPlays.at(-1) ?? this.normalizePlay(event);

    const awayAbbr = away?.team?.abbreviation ?? "AWAY";
    const homeAbbr = home?.team?.abbreviation ?? "HOME";
    return {
      provider: "espn-scoreboard",
      gameId: event.id,
      sport: this.sport,
      awayTeam: awayAbbr,
      homeTeam: homeAbbr,
      awayMeta: teamMeta(away?.team, awayAbbr),
      homeMeta: teamMeta(home?.team, homeAbbr),
      status: statusName(event.status),
      currentPlay: play,
      recentPlays: this.recentPlays,
      updatedAt: new Date().toISOString()
    };
  }

  private normalizePlay(event: EspnEvent): SportsPlay {
    const competition = event.competitions?.[0];
    const away = competition?.competitors?.find((competitor) => competitor.homeAway === "away");
    const home = competition?.competitors?.find((competitor) => competitor.homeAway === "home");
    const status = competition?.status ?? event.status;
    const lastPlay = competition?.situation?.lastPlay;
    const possession = possessionTeam(competition) ?? away?.team?.abbreviation ?? "NFL";
    const description = lastPlay?.text ?? status?.type?.detail ?? event.name ?? "ESPN scoreboard update.";
    const state = status?.type?.state;

    // ESPN's lastPlay carries `athletesInvolved` whenever the scoreboard
    // resolves the play to specific players. Bridge those ESPN player
    // IDs to canonical (Sleeper-namespace) ids so they line up against
    // fantasy roster `starters[].id` for personalization.
    const playerIds = (lastPlay?.athletesInvolved ?? [])
      .map((athlete) => athlete?.id)
      .filter((id): id is string | number => id !== undefined && id !== null && id !== "")
      .map((id) => this.resolver.resolve({ provider: "espn", externalId: id, sport: this.sport }));

    return {
      id: lastPlay?.id ? `espn-${event.id}-${lastPlay.id}` : `espn-${event.id}-${state ?? "status"}-${status?.period ?? 0}-${status?.displayClock ?? "clock"}`,
      type: playType(lastPlay?.type?.text ?? description),
      excitement: state === "in" ? 3 : 2,
      clock: status?.displayClock ?? "0:00",
      quarter: status?.period ? `Q${status.period}` : status?.type?.shortDetail ?? "NFL",
      possession,
      headline: lastPlay?.type?.text ?? event.shortName ?? event.name ?? "ESPN scoreboard update",
      description,
      playerIds,
      team: possession,
      score: {
        away: Number(away?.score ?? 0),
        home: Number(home?.score ?? 0)
      },
      occurredAt: new Date().toISOString()
    };
  }
}

function normalizeGameOption(event: EspnEvent, sport: SportLeague): SportsGameOption {
  const competition = event.competitions?.[0];
  const away = competition?.competitors?.find((competitor) => competitor.homeAway === "away");
  const home = competition?.competitors?.find((competitor) => competitor.homeAway === "home");
  const awayTeam = away?.team?.abbreviation ?? "AWAY";
  const homeTeam = home?.team?.abbreviation ?? "HOME";
  return {
    id: `${sport}-${event.id}`,
    label: event.shortName ?? event.name ?? `${awayTeam} at ${homeTeam}`,
    shortName: event.shortName ?? `${awayTeam} @ ${homeTeam}`,
    sport,
    awayTeam,
    homeTeam,
    awayMeta: teamMeta(away?.team, awayTeam),
    homeMeta: teamMeta(home?.team, homeTeam),
    score: {
      away: Number(away?.score ?? 0),
      home: Number(home?.score ?? 0)
    },
    status: statusName(event.status),
    startsAt: event.date,
    detail: event.status?.type?.shortDetail ?? event.status?.type?.detail ?? event.status?.type?.description ?? statusName(event.status),
    broadcast: pickBroadcast(competition?.broadcasts)
  };
}

function pickBroadcast(broadcasts?: NonNullable<EspnCompetition["broadcasts"]>): string | undefined {
  const national = broadcasts?.find((entry) => entry.market === "national");
  const names = (national?.names ?? []).filter((name) => name && name.trim().length > 0);
  if (names.length === 0) return undefined;
  return names.join(" · ");
}

function teamMeta(team: NonNullable<EspnCompetition["competitors"]>[number]["team"], abbreviation: string) {
  return {
    abbreviation,
    displayName: team?.displayName,
    shortName: team?.shortDisplayName,
    logo: team?.logo,
    color: team?.color,
    alternateColor: team?.alternateColor
  };
}

function statusName(status?: EspnStatus): SportsGameState["status"] {
  const state = status?.type?.state;
  // ESPN keeps `state` as "pre" for postponed/canceled/suspended/delayed
  // games — the granular flag lives on `type.name` (e.g.
  // STATUS_POSTPONED). Without this, postponed games silently land in
  // the Upcoming bucket alongside genuine future games.
  const name = status?.type?.name?.toUpperCase();
  if (name === "STATUS_POSTPONED" || name === "STATUS_CANCELED" || name === "STATUS_SUSPENDED" || name === "STATUS_FORFEIT") {
    return "postponed";
  }
  if (state === "in") return "live";
  if (state === "post") return "final";
  return "scheduled";
}

/**
 * Build the `dates=YYYYMMDD-YYYYMMDD` window ESPN's scoreboard expects.
 * Anchored to ET-ish day boundaries — passing the local-day strings
 * works for the discover surface in practice. Exported for test access.
 */
export function scoreboardDateRange(reference: Date, daysAhead: number): string {
  const start = formatYyyyMmDd(reference);
  const endDate = new Date(reference);
  endDate.setDate(endDate.getDate() + daysAhead);
  const end = formatYyyyMmDd(endDate);
  return `${start}-${end}`;
}

function formatYyyyMmDd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function possessionTeam(competition?: EspnCompetition): string | undefined {
  const possessionId = competition?.situation?.possession;
  return competition?.competitors?.find((competitor) => competitor.team?.id === possessionId)?.team?.abbreviation;
}

function playType(text: string): SportsPlay["type"] {
  const normalized = text.toLowerCase();
  if (normalized.includes("touchdown")) return "touchdown";
  if (normalized.includes("interception") || normalized.includes("fumble") || normalized.includes("turnover")) return "turnover";
  if (normalized.includes("field goal")) return "field-goal";
  if (normalized.includes("rush") || normalized.includes("run")) return "rush";
  if (normalized.includes("pass") || normalized.includes("sack")) return "pass";
  if (normalized.includes("first down")) return "first-down";
  return "other";
}
