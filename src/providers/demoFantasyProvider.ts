import type { FantasyLeagueState, FantasyProvider, ProviderHealth } from "../shared/contracts";
import { demoLeagueState } from "./demoData";

export class DemoFantasyProvider implements FantasyProvider {
  id = "demo-fantasy";

  constructor(private readonly customLeague?: FantasyLeagueState) {}

  async getLeagueState(): Promise<FantasyLeagueState> {
    return {
      ...(this.customLeague ?? demoLeagueState),
      provider: this.customLeague ? "custom-demo" : "demo",
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
