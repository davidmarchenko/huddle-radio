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
    // No id at all (landing page / "sample" CTA) → bundled default.
    // A known demo id → its scripted plays. A non-demo id is a routing
    // bug: the factory hands a real ESPN id to the demo provider only
    // when something upstream is confused, and silently substituting
    // KC@DET there is exactly how the wrong commentary used to leak
    // into live shows. Fail loudly so the bug surfaces.
    if (!gameId) {
      this.meta = DEFAULT_META;
      return;
    }
    const meta = DEMO_GAME_META[gameId];
    if (!meta) {
      throw new Error(
        `DemoSportsDataProvider received non-demo gameId "${gameId}". Real game ids must be routed through the ESPN / Sportradar / SportsDataIO providers — see resolveSportsSource in showFactories.ts.`
      );
    }
    this.meta = meta;
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
