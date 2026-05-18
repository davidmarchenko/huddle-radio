import type { ProviderHealth, SportLeague, SportsDataProvider, SportsGameState, SportsPlay } from "../shared/contracts";
import { periodFromNumber } from "../shared/period";
import { getDefaultPlayerIdResolver, type PlayerIdResolver } from "../server/playerIdResolver";

type Fetcher = typeof fetch;

/**
 * SportsDataIO sports-data backup (W10).
 *
 * Alternative to Sportradar with cheaper entry tiers. Same shape on
 * our end; different shape on the wire. Disabled when
 * `SPORTSDATAIO_API_KEY` is unset.
 *
 * Identifies plays by `PlayID`, players by `PlayerID`. We resolve to
 * canonical Sleeper-namespace IDs via the W1 resolver so personalization
 * still works no matter which feed is upstream.
 */

const NFL_BASE = "https://api.sportsdata.io/v3/nfl";

type SportsDataIoLastPlay = {
  PlayID?: number;
  Type?: string;
  Description?: string;
  TimeRemainingDisplay?: string;
  QuarterName?: string;
  PlayerIDs?: number[];
  Team?: string;
  HomeTeam?: string;
  AwayTeam?: string;
  HomeScore?: number;
  AwayScore?: number;
  Status?: string;
};

export type SportsDataIoOptions = {
  apiKey: string;
  /** SportsDataIO ScoreID for the current event. */
  scoreId: string | number;
  sport?: SportLeague;
  fetcher?: Fetcher;
  resolver?: PlayerIdResolver;
};

export class SportsDataIoProvider implements SportsDataProvider {
  id = "sportsdataio";
  private recentPlays: SportsPlay[] = [];
  private readonly fetcher: Fetcher;
  private readonly resolver: PlayerIdResolver;
  private readonly sport: SportLeague;

  constructor(private readonly options: SportsDataIoOptions) {
    if (!options.apiKey) throw new Error("SportsDataIoProvider requires an apiKey.");
    if (options.scoreId === undefined || options.scoreId === null) throw new Error("SportsDataIoProvider requires a scoreId.");
    this.fetcher = options.fetcher ?? fetch;
    this.resolver = options.resolver ?? getDefaultPlayerIdResolver();
    this.sport = options.sport ?? "nfl";
  }

  async getGameState(): Promise<SportsGameState> {
    const last = await this.getLastPlay();
    const play = this.normalizePlay(last);
    this.recentPlays = [...this.recentPlays.filter((p) => p.id !== play.id), play].slice(-8);
    return {
      provider: "sportsdataio",
      gameId: String(this.options.scoreId),
      sport: this.sport,
      awayTeam: last.AwayTeam ?? "AWAY",
      homeTeam: last.HomeTeam ?? "HOME",
      status: statusFromSportsDataIo(last.Status),
      currentPlay: play,
      recentPlays: this.recentPlays,
      updatedAt: new Date().toISOString()
    };
  }

  async nextPlay(): Promise<SportsPlay> {
    const last = await this.getLastPlay();
    const play = this.normalizePlay(last);
    this.recentPlays = [...this.recentPlays.filter((p) => p.id !== play.id), play].slice(-8);
    return play;
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "SportsDataIO",
      status: "ready",
      detail: `Configured for NFL. ScoreID: ${this.options.scoreId}.`
    };
  }

  private async getLastPlay(): Promise<SportsDataIoLastPlay> {
    const url = `${NFL_BASE}/pbp/json/PlayByPlayDelta/${encodeURIComponent(String(this.options.scoreId))}/all?key=${encodeURIComponent(this.options.apiKey)}`;
    const response = await this.fetcher(url);
    if (!response.ok) throw new Error(`SportsDataIO request failed: ${response.status} ${response.statusText}`);
    const json = (await response.json()) as { Plays?: SportsDataIoLastPlay[]; Score?: SportsDataIoLastPlay };
    const plays = json.Plays ?? [];
    return plays[plays.length - 1] ?? json.Score ?? {};
  }

  private normalizePlay(last: SportsDataIoLastPlay): SportsPlay {
    const description = last.Description ?? "SportsDataIO event.";
    const playerIds = (last.PlayerIDs ?? []).map((id) =>
      this.resolver.resolve({ provider: "espn", externalId: String(id), sport: this.sport })
    );
    return {
      id: last.PlayID ? `sportsdataio-${last.PlayID}` : `sportsdataio-${this.options.scoreId}-${Date.now()}`,
      type: playTypeFromText(`${last.Type ?? ""} ${description}`),
      excitement: 2,
      clock: last.TimeRemainingDisplay ?? "0:00",
      period: periodFromNumber(
        Number((last.QuarterName ?? "").replace(/\D+/g, "")) || 0,
        this.sport,
        { shortDetail: last.QuarterName ?? undefined }
      ),
      possession: last.Team ?? last.HomeTeam ?? "HOME",
      headline: last.Type ?? "SportsDataIO event",
      description,
      playerIds,
      team: last.Team ?? last.HomeTeam ?? "HOME",
      score: {
        away: last.AwayScore ?? 0,
        home: last.HomeScore ?? 0
      },
      occurredAt: new Date().toISOString()
    };
  }
}

export function statusFromSportsDataIo(status?: string): SportsGameState["status"] {
  const lower = (status ?? "").toLowerCase();
  if (lower === "inprogress" || lower === "halftime") return "live";
  if (lower === "final") return "final";
  if (lower === "postponed" || lower === "canceled" || lower === "suspended") return "postponed";
  return "scheduled";
}

export function playTypeFromText(blob: string): SportsPlay["type"] {
  const lower = blob.toLowerCase();
  if (lower.includes("touchdown")) return "touchdown";
  if (lower.includes("intercept") || lower.includes("fumble") || lower.includes("turnover")) return "turnover";
  if (lower.includes("field goal")) return "field-goal";
  if (lower.includes("first down")) return "first-down";
  if (lower.includes("rush") || lower.includes("run")) return "rush";
  if (lower.includes("pass") || lower.includes("sack")) return "pass";
  return "other";
}
