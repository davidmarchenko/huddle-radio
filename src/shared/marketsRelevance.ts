import type { MarketSnapshot, SportLeague } from "./contracts";

/**
 * Pure ranking helper for prediction-market snapshots, shared by the
 * server-side commentary engine and the W19 client ticker. Lives in
 * `shared/` so the client doesn't accidentally pull in the
 * server-only Kalshi / Polymarket fetchers.
 *
 * Heuristic: prefer markets that mention either of the game's teams
 * or any of the listener's players, then weight by market kind
 * (moneyline > player-prop > spread > total > futures > other) and
 * tiebreak on volume. Returns at most `limit` snapshots, highest
 * relevance first.
 */
export function pickRelevantMarketsForGame(
  snapshots: MarketSnapshot[],
  game: { sport: SportLeague; teams: string[]; players?: string[] },
  limit = 3
): MarketSnapshot[] {
  const teamMatchers = game.teams.map((t) => t.toLowerCase());
  const playerMatchers = (game.players ?? []).map((p) => p.toLowerCase());

  const scored = snapshots
    .filter((snapshot) => snapshot.sport === game.sport)
    .map((snapshot) => {
      const haystack = `${snapshot.title} ${snapshot.outcomeLabel}`.toLowerCase();
      const teamHit = teamMatchers.some((needle) => needle && haystack.includes(needle));
      const playerHit = playerMatchers.some((needle) => needle && haystack.includes(needle));
      if (!teamHit && !playerHit) return undefined;
      const kindWeight = ({
        moneyline: 5,
        "player-prop": 4,
        spread: 3,
        total: 2,
        futures: 1,
        other: 0
      } satisfies Record<MarketSnapshot["marketKind"], number>)[snapshot.marketKind];
      const volumeScore = Math.log10(1 + (snapshot.volume24hUsd ?? 0));
      const playerBonus = playerHit ? 2 : 0;
      return {
        snapshot,
        score: kindWeight + volumeScore + playerBonus
      };
    })
    .filter((entry): entry is { snapshot: MarketSnapshot; score: number } => entry !== undefined)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((entry) => entry.snapshot);
}
