import type { ProviderHealth, SportLeague, SportsDataProvider, SportsGameState, SportsPlay } from "../shared/contracts";
import { periodFromNumber } from "../shared/period";
import { getDefaultPlayerIdResolver, type PlayerIdResolver } from "../server/playerIdResolver";

type Fetcher = typeof fetch;

/**
 * Sportradar paid live-data backup (W10).
 *
 * ESPN's unofficial scoreboard is our default, but it's an undocumented
 * endpoint with no SLA. Once production traffic justifies the bill,
 * Sportradar (NFL ~$1k/mo+) gives us a real contract for the same data.
 *
 * This provider is shipped as a scaffold: callers pass a `gameId`
 * (Sportradar's UUID) and an API key. With no key set, every method
 * throws — `createSportsDataProvider` only constructs it when the
 * operator has explicitly opted in via `SPORTRADAR_API_KEY`.
 *
 * Player IDs flow through the W1 resolver so the same listener-roster
 * personalization works whether ESPN or Sportradar is upstream.
 */

const NFL_BASE = "https://api.sportradar.com/nfl/official";

type SportradarPlay = {
  id?: string;
  type?: string;
  description?: string;
  clock?: string;
  quarter?: number;
  scoring_play?: { type?: string };
  statistics?: Array<{
    player?: { id?: string; name?: string };
    pass?: unknown;
    rush?: unknown;
    receive?: unknown;
  }>;
};

type SportradarGameSummary = {
  id?: string;
  status?: string;
  quarter?: number;
  clock?: string;
  summary?: {
    home?: { id?: string; alias?: string; points?: number };
    away?: { id?: string; alias?: string; points?: number };
  };
  last_event?: SportradarPlay;
};

export type SportradarOptions = {
  apiKey: string;
  /** trial | production. Sportradar segregates by access tier. */
  accessLevel?: "trial" | "production";
  /** API version (default `v7`). Sportradar bumps periodically. */
  version?: string;
  /** Sportradar game UUID for the current event. */
  gameId: string;
  /** Sport — currently NFL only; expand when paid traffic warrants. */
  sport?: SportLeague;
  fetcher?: Fetcher;
  resolver?: PlayerIdResolver;
};

export class SportradarSportsDataProvider implements SportsDataProvider {
  id = "sportradar";
  private recentPlays: SportsPlay[] = [];
  private readonly fetcher: Fetcher;
  private readonly resolver: PlayerIdResolver;
  private readonly accessLevel: "trial" | "production";
  private readonly version: string;
  private readonly sport: SportLeague;

  constructor(private readonly options: SportradarOptions) {
    if (!options.apiKey) throw new Error("SportradarSportsDataProvider requires an apiKey.");
    if (!options.gameId) throw new Error("SportradarSportsDataProvider requires a gameId.");
    this.fetcher = options.fetcher ?? fetch;
    this.resolver = options.resolver ?? getDefaultPlayerIdResolver();
    this.accessLevel = options.accessLevel ?? "trial";
    this.version = options.version ?? "v7";
    this.sport = options.sport ?? "nfl";
  }

  async getGameState(): Promise<SportsGameState> {
    const summary = await this.getSummary();
    const lastPlay = summary.last_event ? this.normalizePlay(summary, summary.last_event) : this.recentPlays.at(-1);
    return {
      provider: "sportradar",
      gameId: summary.id ?? this.options.gameId,
      sport: this.sport,
      awayTeam: summary.summary?.away?.alias ?? "AWAY",
      homeTeam: summary.summary?.home?.alias ?? "HOME",
      status: statusFromSportradar(summary.status),
      currentPlay: lastPlay,
      recentPlays: this.recentPlays,
      updatedAt: new Date().toISOString()
    };
  }

  async nextPlay(): Promise<SportsPlay> {
    const summary = await this.getSummary();
    if (!summary.last_event) {
      // No play yet — synthesize a status update so the engine doesn't
      // get stuck waiting for the first snap.
      return {
        id: `sportradar-${summary.id}-status-${Date.now()}`,
        type: "other",
        excitement: 1,
        clock: summary.clock ?? "0:00",
        period: periodFromNumber(Number(summary.quarter) || 0, this.sport, { shortDetail: summary.quarter ? undefined : "Pregame" }),
        possession: summary.summary?.home?.alias ?? "HOME",
        headline: "Sportradar status update",
        description: "Pregame status — awaiting first snap.",
        playerIds: [],
        team: summary.summary?.home?.alias ?? "HOME",
        score: {
          away: summary.summary?.away?.points ?? 0,
          home: summary.summary?.home?.points ?? 0
        },
        occurredAt: new Date().toISOString()
      };
    }
    const play = this.normalizePlay(summary, summary.last_event);
    this.recentPlays = [...this.recentPlays.filter((p) => p.id !== play.id), play].slice(-8);
    return play;
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Sportradar Sports Data",
      status: "ready",
      detail: `Configured for NFL ${this.accessLevel} tier (${this.version}). Game id: ${this.options.gameId}.`
    };
  }

  private async getSummary(): Promise<SportradarGameSummary> {
    const url = `${NFL_BASE}/${this.accessLevel}/${this.version}/en/games/${this.options.gameId}/summary.json?api_key=${encodeURIComponent(this.options.apiKey)}`;
    const response = await this.fetcher(url);
    if (!response.ok) throw new Error(`Sportradar summary request failed: ${response.status} ${response.statusText}`);
    return (await response.json()) as SportradarGameSummary;
  }

  private normalizePlay(summary: SportradarGameSummary, event: SportradarPlay): SportsPlay {
    const description = event.description ?? "Sportradar event.";
    const players: string[] = [];
    for (const stat of event.statistics ?? []) {
      const id = stat.player?.id;
      if (!id) continue;
      players.push(this.resolver.resolve({ provider: "espn", externalId: id, sport: this.sport }));
    }
    return {
      id: event.id ? `sportradar-${event.id}` : `sportradar-${summary.id}-${Date.now()}`,
      type: playTypeFromSportradar(event.type, description),
      excitement: event.scoring_play ? 4 : 2,
      clock: event.clock ?? summary.clock ?? "0:00",
      period: periodFromNumber(
        Number(event.quarter ?? summary.quarter) || 0,
        this.sport
      ),
      possession: summary.summary?.home?.alias ?? "HOME",
      headline: event.type ? toTitleCase(event.type) : "Sportradar event",
      description,
      playerIds: players,
      team: summary.summary?.home?.alias ?? "HOME",
      score: {
        away: summary.summary?.away?.points ?? 0,
        home: summary.summary?.home?.points ?? 0
      },
      occurredAt: new Date().toISOString()
    };
  }
}

export function statusFromSportradar(status?: string): SportsGameState["status"] {
  const lower = (status ?? "").toLowerCase();
  if (lower === "inprogress" || lower === "halftime") return "live";
  if (lower === "closed" || lower === "complete") return "final";
  if (lower === "postponed" || lower === "canceled" || lower === "suspended") return "postponed";
  return "scheduled";
}

export function playTypeFromSportradar(type: string | undefined, description: string): SportsPlay["type"] {
  // Normalize underscores to spaces so Sportradar enum values like
  // `field_goal` / `pass_completion` match the same word checks the
  // description text does.
  const blob = `${type ?? ""} ${description}`.replace(/_/g, " ").toLowerCase();
  if (blob.includes("touchdown")) return "touchdown";
  if (blob.includes("intercept") || blob.includes("fumble") || blob.includes("turnover")) return "turnover";
  if (blob.includes("field goal")) return "field-goal";
  if (blob.includes("first down")) return "first-down";
  if (blob.includes("rush") || blob.includes("run")) return "rush";
  if (blob.includes("pass") || blob.includes("sack")) return "pass";
  return "other";
}

function toTitleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}
