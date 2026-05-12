import type { FantasyLeagueState, FantasyProvider, ProviderHealth, SportLeague } from "../shared/contracts";
import { demoLeagueState, emptyDemoLeagueForSport, pickDemoLeagueForSport } from "./demoData";

/**
 * Resolution order for which demo league to return:
 *
 *   1. customLeague — only when its sport matches sportHint (or when
 *      no hint was supplied). The client's customLeague is pre-filled
 *      with the bundled NFL league and persists in localStorage, so
 *      letting it win unconditionally caused the NFL roster (Mahomes,
 *      Amon-Ra) to leak into commentary on NBA / MLB games. Sport
 *      mismatch falls through.
 *   2. sportHint — matched against the bundled demo leagues. Returns
 *      the NFL or NBA league when the picked game is in that sport,
 *      or an empty-shell league (no rosters) when there's no demo
 *      data for the sport (MLB, NHL, etc.).
 *   3. No hint — bundled NFL default (back-compat for landing-page
 *      sample CTA and any caller that hasn't been threaded through).
 */
export class DemoFantasyProvider implements FantasyProvider {
  id = "demo-fantasy";

  constructor(
    private readonly customLeague?: FantasyLeagueState,
    private readonly sportHint?: SportLeague
  ) {}

  async getLeagueState(): Promise<FantasyLeagueState> {
    if (this.customLeague && (!this.sportHint || this.customLeague.sport === this.sportHint)) {
      return {
        ...this.customLeague,
        provider: "custom-demo",
        updatedAt: new Date().toISOString()
      };
    }
    const base = this.sportHint
      ? (pickDemoLeagueForSport(this.sportHint) ?? emptyDemoLeagueForSport(this.sportHint))
      : demoLeagueState;
    return {
      ...base,
      provider: "demo",
      updatedAt: new Date().toISOString()
    };
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Demo Fantasy",
      status: "ready",
      detail: "Using bundled placeholder fantasy league state."
    };
  }
}
