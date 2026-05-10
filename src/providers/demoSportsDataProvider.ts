import type { ProviderHealth, SportLeague, SportsDataProvider, SportsGameState, SportsPlay } from "../shared/contracts";
import { demoNbaPlays, demoPlays } from "./demoData";

type DemoGameMeta = {
  gameId: string;
  sport: SportLeague;
  awayTeam: string;
  homeTeam: string;
  plays: SportsPlay[];
};

const DEMO_GAME_META: Record<string, DemoGameMeta> = {
  "demo-kc-det": { gameId: "demo-kc-det", sport: "nfl", awayTeam: "KC", homeTeam: "DET", plays: demoPlays },
  "demo-buf-cin": { gameId: "demo-buf-cin", sport: "nfl", awayTeam: "BUF", homeTeam: "CIN", plays: demoPlays },
  "demo-den-okc": { gameId: "demo-den-okc", sport: "nba", awayTeam: "DEN", homeTeam: "OKC", plays: demoNbaPlays },
  "demo-bos-dal": { gameId: "demo-bos-dal", sport: "nba", awayTeam: "BOS", homeTeam: "DAL", plays: demoNbaPlays },
  "demo-lal-phx": { gameId: "demo-lal-phx", sport: "nba", awayTeam: "LAL", homeTeam: "PHX", plays: demoNbaPlays }
};

const DEFAULT_META = DEMO_GAME_META["demo-kc-det"];

export class DemoSportsDataProvider implements SportsDataProvider {
  id = "demo-sports-data";
  private index = 0;
  private recentPlays: SportsPlay[] = [];
  private readonly meta: DemoGameMeta;

  constructor(gameId?: string) {
    this.meta = (gameId && DEMO_GAME_META[gameId]) || DEFAULT_META;
  }

  async getGameState(): Promise<SportsGameState> {
    return {
      provider: "demo",
      gameId: this.meta.gameId,
      sport: this.meta.sport,
      awayTeam: this.meta.awayTeam,
      homeTeam: this.meta.homeTeam,
      status: "demo",
      currentPlay: this.recentPlays.at(-1),
      recentPlays: this.recentPlays,
      updatedAt: new Date().toISOString()
    };
  }

  async nextPlay(): Promise<SportsPlay> {
    const basePlay = this.meta.plays[this.index % this.meta.plays.length];
    this.index += 1;
    const play = {
      ...basePlay,
      id: `${basePlay.id}-${this.index}`,
      occurredAt: new Date().toISOString()
    };
    this.recentPlays = [...this.recentPlays, play].slice(-8);
    return play;
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Demo Sports Data",
      status: "ready",
      detail: `Streaming scripted ${this.meta.sport.toUpperCase()} play-by-play events.`
    };
  }
}
