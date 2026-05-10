import type { SportLeague } from "../shared/contracts";
import seedJson from "./data/playerIdMap.json" with { type: "json" };

/**
 * Cross-provider player ID resolver.
 *
 * Each fantasy/sports vendor uses its own player-ID namespace: Sleeper
 * uses one set, ESPN scoreboard another, ESPN Fantasy a third (close to
 * scoreboard but not identical), Yahoo a fourth. When the user picks an
 * ESPN scoreboard play and we try to match `play.playerIds[]` against a
 * Sleeper roster's `starters[].id`, the namespaces don't line up and the
 * personalization silently fails.
 *
 * Resolution rule: Sleeper IDs are canonical for NFL (and other sports
 * Sleeper covers). Other providers either share that ID via the seed
 * map, or get a namespaced fallback like `espn:3139477` so the data is
 * preserved without colliding into a different player on the Sleeper
 * side.
 */

export type ExternalIdProvider = "sleeper" | "espn" | "yahoo";

export type PlayerRecord = {
  canonicalId: string;
  name: string;
  sport: SportLeague;
  position?: string;
  team?: string;
  external: Partial<Record<ExternalIdProvider, string>>;
};

export type ResolveInput = {
  provider: ExternalIdProvider;
  externalId: string | number;
  sport: SportLeague;
};

export type ResolverStats = {
  resolved: number;
  missed: number;
  registered: number;
};

export type SeedFile = {
  version: string;
  source?: string;
  players: PlayerRecord[];
};

export class PlayerIdResolver {
  private byExternal = new Map<string, string>();
  private byCanonical = new Map<string, PlayerRecord>();
  private resolvedCount = 0;
  private missedCount = 0;

  register(record: PlayerRecord): void {
    this.byCanonical.set(record.canonicalId, record);
    for (const provider of Object.keys(record.external) as ExternalIdProvider[]) {
      const externalId = record.external[provider];
      if (!externalId) continue;
      this.byExternal.set(this.makeKey(provider, record.sport, externalId), record.canonicalId);
    }
  }

  registerMany(records: PlayerRecord[]): void {
    for (const record of records) this.register(record);
  }

  /**
   * Resolve an external ID to canonical. On miss, returns a namespaced
   * fallback (e.g. `espn:3139477`) so the original ID is preserved and
   * cannot collide with a Sleeper-canonical ID.
   */
  resolve(input: ResolveInput): string {
    const externalId = String(input.externalId);
    const key = this.makeKey(input.provider, input.sport, externalId);
    const canonical = this.byExternal.get(key);
    if (canonical) {
      this.resolvedCount++;
      return canonical;
    }
    this.missedCount++;
    return `${input.provider}:${externalId}`;
  }

  /**
   * Like `resolve` but returns the raw external ID on miss instead of
   * a namespaced fallback. Use for providers whose IDs are themselves
   * canonical (Sleeper for NFL) so unmapped players still match against
   * other Sleeper-side data.
   */
  resolveOrPassthrough(input: ResolveInput): string {
    const externalId = String(input.externalId);
    const key = this.makeKey(input.provider, input.sport, externalId);
    const canonical = this.byExternal.get(key);
    if (canonical) {
      this.resolvedCount++;
      return canonical;
    }
    this.missedCount++;
    return externalId;
  }

  lookup(canonicalId: string): PlayerRecord | undefined {
    return this.byCanonical.get(canonicalId);
  }

  getStats(): ResolverStats {
    return {
      resolved: this.resolvedCount,
      missed: this.missedCount,
      registered: this.byCanonical.size
    };
  }

  resetStats(): void {
    this.resolvedCount = 0;
    this.missedCount = 0;
  }

  private makeKey(provider: ExternalIdProvider, sport: SportLeague, externalId: string): string {
    return `${provider}|${sport}|${externalId}`;
  }
}

let defaultResolver: PlayerIdResolver | undefined;

/**
 * Module-level resolver loaded from the shipped seed JSON. Lazy so tests
 * that exercise the resolver class directly (without a seed file) can
 * still construct fresh instances without touching the singleton.
 */
export function getDefaultPlayerIdResolver(): PlayerIdResolver {
  if (defaultResolver) return defaultResolver;
  defaultResolver = new PlayerIdResolver();
  const seed = seedJson as SeedFile;
  if (seed?.players?.length) defaultResolver.registerMany(seed.players);
  return defaultResolver;
}

/** Reset the singleton — for tests. Production code should not need this. */
export function resetDefaultPlayerIdResolver(): void {
  defaultResolver = undefined;
}
