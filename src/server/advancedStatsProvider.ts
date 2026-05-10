import type { AdvancedStatsProvider, PlayerSeasonStats, ProviderHealth, SportLeague } from "../shared/contracts";
import seedJson from "./data/advancedStats.json" with { type: "json" };

/**
 * W12: Beat-writer-grade analytics layer.
 *
 * Maya's analyst voice has been constrained by what `play.score` and
 * `currentPoints` carry. This provider gives the persona prompts an
 * `analytics` field with snap counts, EPA/play, target share, and a
 * single "trend" note — the kind of stuff that actually distinguishes
 * an analyst's commentary from boilerplate.
 *
 * v1 ships a hand-curated NFL snapshot keyed by canonical (Sleeper)
 * player id. The interface (`AdvancedStatsProvider`) is the seam for
 * a real pipeline (nflfastR / Football Outsiders ingestion, Sportradar
 * advanced stats subscription) to plug into later.
 */

type SeedShape = {
  version: string;
  source?: string;
  season?: string;
  players: PlayerSeasonStats[];
};

export class StaticAdvancedStatsProvider implements AdvancedStatsProvider {
  id = "static-advanced-stats";
  private readonly byCanonical = new Map<string, PlayerSeasonStats>();
  private readonly bundleVersion: string;

  constructor(seed: SeedShape = seedJson as SeedShape) {
    this.bundleVersion = seed.version;
    for (const player of seed.players) this.byCanonical.set(player.canonicalId, player);
  }

  async getPlayerSeason(input: { canonicalIds: string[]; sport: SportLeague; season?: string }): Promise<PlayerSeasonStats[]> {
    const out: PlayerSeasonStats[] = [];
    for (const id of input.canonicalIds) {
      const record = this.byCanonical.get(id);
      if (!record) continue;
      if (record.sport !== input.sport) continue;
      if (input.season && record.season !== input.season) continue;
      out.push(record);
    }
    return out;
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Advanced Stats (static)",
      status: this.byCanonical.size > 0 ? "ready" : "disabled",
      detail: `Bundle ${this.bundleVersion} with ${this.byCanonical.size} players. Refresh from nflfastR / Football Outsiders before opening to live traffic.`
    };
  }
}

let defaultProvider: AdvancedStatsProvider | undefined;

export function getDefaultAdvancedStatsProvider(): AdvancedStatsProvider {
  if (defaultProvider) return defaultProvider;
  defaultProvider = new StaticAdvancedStatsProvider();
  return defaultProvider;
}

export function resetDefaultAdvancedStatsProvider(provider?: AdvancedStatsProvider): void {
  defaultProvider = provider;
}
