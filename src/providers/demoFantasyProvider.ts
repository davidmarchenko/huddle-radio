import type { FantasyLeagueState, FantasyProvider, ProviderHealth, SportLeague } from "../shared/contracts";
import { demoLeagueState, emptyDemoLeagueForSport, pickDemoLeagueForSport } from "./demoData";

/**
 * Resolution order for which demo league to return:
 *
 *   1. customLeague (constructor arg) — explicit user paste-in, always wins.
 *   2. sportHint — matched against the bundled demo leagues. Returns
 *      the NFL or NBA league when the picked game is in that sport,
 *      or an empty-shell league (no rosters) when there's no demo
 *      data for the sport (MLB, NHL, etc.).
 *   3. No hint — bundled NFL default (back-compat for landing-page
 *      sample CTA and any caller that hasn't been threaded through).
 *
 * This prevents the demo NFL roster (Mahomes, Amon-Ra) from leaking
 * into commentary when the listener picks a real-game in a different
 * sport — the bug that was generating "demo audio" on the MLB show.
 */
export class DemoFantasyProvider implements FantasyProvider {
  id = "demo-fantasy";

  constructor(
    private readonly customLeague?: FantasyLeagueState,
    private readonly sportHint?: SportLeague
  ) {}

  async getLeagueState(): Promise<FantasyLeagueState> {
    if (this.customLeague) {
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
