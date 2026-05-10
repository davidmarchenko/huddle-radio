import { OddsApiProvider } from "../providers/oddsApiProvider";
import type { OddsProvider } from "../shared/contracts";
import { config } from "./config";

let cachedProvider: OddsProvider | undefined;

/**
 * Single source of truth for odds-provider construction. Returns the
 * Odds API client when keyed; otherwise a stub that always returns
 * `undefined` so callers don't need to special-case the disabled state.
 */
export function createOddsProvider(): OddsProvider {
  if (cachedProvider) return cachedProvider;
  if (config.THE_ODDS_API_KEY) {
    cachedProvider = new OddsApiProvider(config.THE_ODDS_API_KEY);
  } else {
    cachedProvider = new DisabledOddsProvider();
  }
  return cachedProvider;
}

/** Reset the singleton — for tests. */
export function resetOddsProvider(): void {
  cachedProvider = undefined;
}

class DisabledOddsProvider implements OddsProvider {
  id = "odds-disabled";
  async getOdds() {
    return undefined;
  }
  async health() {
    return {
      id: this.id,
      label: "Vegas lines",
      status: "disabled" as const,
      detail: "Set THE_ODDS_API_KEY to surface live spreads and totals."
    };
  }
}
