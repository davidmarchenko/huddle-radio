import type { MarketSnapshot, SportLeague } from "../shared/contracts";
import { fetchKalshiSnapshots } from "../providers/kalshiMarketsProvider";
import { fetchPolymarketSnapshots } from "../providers/polymarketMarketsProvider";

/**
 * Unified prediction-markets provider.
 *
 * Fans out to Kalshi + Polymarket in parallel, normalizes into the
 * shared MarketSnapshot shape, and tracks a 5-minute price history
 * per market so consumers can surface "the line just moved" signals
 * to the AI hosts.
 *
 * In-process state is fine for a single Next.js Function instance.
 * For multi-instance prod we'd back the history with Upstash Redis;
 * for now the cache resets on cold starts which is acceptable for
 * the demo.
 */

type CacheEntry = {
  snapshots: MarketSnapshot[];
  fetchedAt: number;
};

type HistoryEntry = {
  cents: number;
  observedAt: number;
};

const FRESH_MS = 2_000;          // serve from cache for 2s — radio cadence
const HISTORY_WINDOW_MS = 5 * 60_000;
const HISTORY_CAP = 64;          // bounded ring per market

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<MarketSnapshot[]>>();
const history = new Map<string, HistoryEntry[]>();

function cacheKey(sports: SportLeague[]): string {
  return [...sports].sort().join(",");
}

function recordHistory(snapshot: MarketSnapshot): void {
  const id = `${snapshot.source}:${snapshot.externalId}`;
  const existing = history.get(id) ?? [];
  const now = Date.now();
  const fresh: HistoryEntry[] = [
    ...existing.filter((entry) => now - entry.observedAt <= HISTORY_WINDOW_MS),
    { cents: snapshot.yesPriceCents, observedAt: now }
  ].slice(-HISTORY_CAP);
  history.set(id, fresh);
}

function attachDelta(snapshot: MarketSnapshot): MarketSnapshot {
  const id = `${snapshot.source}:${snapshot.externalId}`;
  const entries = history.get(id);
  if (!entries || entries.length < 2) return snapshot;
  // Compare against the oldest entry in the window — that gives a
  // 5-minute drift signal that tracks "the market is warming/cooling
  // on this story" rather than the noise of a single quote update.
  const baseline = entries[0]!.cents;
  const delta = snapshot.yesPriceCents - baseline;
  if (Math.abs(delta) < 1) return snapshot;
  return { ...snapshot, recentDeltaCents: delta };
}

export type FetchMarketsOptions = {
  sports?: SportLeague[];
  /** Bypass cache — only useful for tests / health endpoints. */
  force?: boolean;
};

export async function fetchMarketSnapshots(options: FetchMarketsOptions = {}): Promise<MarketSnapshot[]> {
  const sports = options.sports ?? ([
    "nfl", "nba", "wnba", "mlb", "nhl", "ncaaf", "ncaab", "soccer"
  ] as SportLeague[]);
  const key = cacheKey(sports);
  const now = Date.now();

  if (!options.force) {
    const cached = cache.get(key);
    if (cached && now - cached.fetchedAt < FRESH_MS) {
      return cached.snapshots;
    }
    const pending = inFlight.get(key);
    if (pending) return pending;
  }

  const job = (async () => {
    const [kalshi, polymarket] = await Promise.all([
      fetchKalshiSnapshots({ sports }),
      fetchPolymarketSnapshots({ sports })
    ]);
    const merged = [...kalshi, ...polymarket];
    for (const snapshot of merged) recordHistory(snapshot);
    const withDeltas = merged.map(attachDelta);
    cache.set(key, { snapshots: withDeltas, fetchedAt: Date.now() });
    return withDeltas;
  })();

  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Pick the N most-relevant markets for a single game. Heuristic:
 * prefer moneyline > player-prop > spread > total > futures, then
 * by absolute volume. Used by the UI ticker (W19) to choose which
 * 2-3 markets to surface alongside the score bug.
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

/** Reset for tests. */
export function resetMarketsProviderState(): void {
  cache.clear();
  inFlight.clear();
  history.clear();
}
