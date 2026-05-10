import type { SportLeague, SportsGameOption } from "../shared/contracts";
import type { EspnSportPath } from "../providers/espnSportsDataProvider";
import { EspnSportsDataProvider } from "../providers/espnSportsDataProvider";

/**
 * Per-sport in-memory cache for `/api/sports/games`.
 *
 * Today every client GET hits ESPN through the server. This collapses
 * "user count" into "ESPN request count," and one viral moment will
 * rate-limit us out of our only live-data source. The cache is keyed by
 * sport so a transient failure on one scoreboard (e.g. WNBA) does not
 * poison the others, and uses stale-while-revalidate so a brief ESPN
 * blip doesn't surface to users.
 *
 * In-memory is fine for a single Fastify instance. A multi-instance
 * deploy would need Redis or similar — folded into W11 when we get
 * there.
 */

type CachedEntry = {
  games: SportsGameOption[];
  expires: number;
  staleUntil: number;
};

export type SportsGamesCacheOptions = {
  freshMs?: number;
  staleMs?: number;
  now?: () => number;
};

export type SportGamesFetcher = (sportPath: EspnSportPath) => Promise<SportsGameOption[]>;

const DEFAULT_FRESH_MS = 30_000;
const DEFAULT_STALE_MS = 120_000;

export class SportsGamesCache {
  private readonly entries = new Map<SportLeague, CachedEntry>();
  private readonly inFlight = new Map<SportLeague, Promise<SportsGameOption[]>>();
  private readonly freshMs: number;
  private readonly staleMs: number;
  private readonly now: () => number;
  private hitCount = 0;
  private staleCount = 0;
  private missCount = 0;

  constructor(
    private readonly fetchGames: SportGamesFetcher,
    options: SportsGamesCacheOptions = {}
  ) {
    this.freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async get(sportPath: EspnSportPath): Promise<SportsGameOption[]> {
    const now = this.now();
    const cached = this.entries.get(sportPath.sport);
    if (cached && cached.expires > now) {
      this.hitCount++;
      return cached.games;
    }
    if (cached && cached.staleUntil > now) {
      this.staleCount++;
      // Kick off a refresh but return the stale value immediately so a
      // brief ESPN hiccup never surfaces. Background errors are
      // swallowed because the next caller will retry.
      this.refresh(sportPath).catch(() => {
        /* swallow background refresh errors */
      });
      return cached.games;
    }
    this.missCount++;
    return this.refresh(sportPath);
  }

  private refresh(sportPath: EspnSportPath): Promise<SportsGameOption[]> {
    const existing = this.inFlight.get(sportPath.sport);
    if (existing) return existing;
    const promise = Promise.resolve(this.fetchGames(sportPath))
      .then((games) => {
        const now = this.now();
        this.entries.set(sportPath.sport, {
          games,
          expires: now + this.freshMs,
          staleUntil: now + this.staleMs
        });
        return games;
      })
      .finally(() => {
        this.inFlight.delete(sportPath.sport);
      });
    this.inFlight.set(sportPath.sport, promise);
    return promise;
  }

  invalidate(sport?: SportLeague): void {
    if (sport) {
      this.entries.delete(sport);
      return;
    }
    this.entries.clear();
  }

  getStats() {
    return {
      hits: this.hitCount,
      stale: this.staleCount,
      misses: this.missCount,
      sports: [...this.entries.keys()]
    };
  }
}

let defaultCache: SportsGamesCache | undefined;

export function getDefaultSportsGamesCache(): SportsGamesCache {
  if (defaultCache) return defaultCache;
  defaultCache = new SportsGamesCache((sportPath) =>
    new EspnSportsDataProvider(fetch, undefined, sportPath).listGames()
  );
  return defaultCache;
}

/** Reset the singleton — for tests. Production code should not need this. */
export function resetDefaultSportsGamesCache(): void {
  defaultCache = undefined;
}
