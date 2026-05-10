import type { NewsItem, NewsProvider, ProviderHealth, SportLeague } from "../shared/contracts";

/**
 * Demo news content. Sport-aware so the pregame "Storylines to watch"
 * card surfaces something that reads like real beat-writer copy in each
 * sport instead of a single generic placeholder.
 *
 * Real news integration would pull from RSS/ESPN news feeds — this
 * provider stands in until that's plumbed.
 */
const SPORT_STORYLINES: Record<SportLeague, Array<Omit<NewsItem, "id" | "publishedAt" | "team" | "playerIds">>> = {
  nfl: [
    { title: "Beat writers expect starters to play full snaps tonight", source: "Demo Wire" },
    { title: "Matchup history favors the home line in red-zone trips", source: "Demo Beat" },
    { title: "Weather note: clear and cold — passing volume should hold", source: "Demo Weather" }
  ],
  ncaaf: [
    { title: "Spring depth chart still being settled at the skill positions", source: "Demo Wire" },
    { title: "Coordinator signals a heavier RPO package for this matchup", source: "Demo Beat" }
  ],
  nba: [
    { title: "Back-to-back schedule note — minutes likely capped on the road team", source: "Demo Wire" },
    { title: "Playoff math: this game swings the seeding picture", source: "Demo Beat" },
    { title: "Coach hinted at a tighter rotation tonight in his presser", source: "Demo Press" }
  ],
  wnba: [
    { title: "Opening-week energy — both starting fives at full strength", source: "Demo Wire" },
    { title: "Coordinator notes: extra ball pressure on the perimeter", source: "Demo Beat" }
  ],
  ncaab: [
    { title: "Conference-tournament implications still alive for both squads", source: "Demo Wire" },
    { title: "Tempo battle — one team wants to run, the other wants to grind", source: "Demo Beat" }
  ],
  mlb: [
    { title: "Pitching matchup heavily favors the home dugout", source: "Demo Wire" },
    { title: "Bullpen note: closer rested and available", source: "Demo Beat" },
    { title: "Lineup card has the starter batting fifth — stretch out the order", source: "Demo Press" }
  ],
  nhl: [
    { title: "Goalie matchup — both starters above .920 over their last five", source: "Demo Wire" },
    { title: "Power-play units ranked top-10 for both teams this season", source: "Demo Beat" }
  ],
  soccer: [
    { title: "Lineup confirmed — first-choice forward back from rotation", source: "Demo Wire" },
    { title: "Tactical battle: pressing line vs. counter-attacking shape", source: "Demo Beat" }
  ],
  other: [
    { title: "Beat writers expect a competitive game throughout", source: "Demo Wire" }
  ]
};

export class DemoNewsProvider implements NewsProvider {
  id = "demo-news";

  async getLatest(input: { playerIds: string[]; teams: string[]; sport?: SportLeague }): Promise<NewsItem[]> {
    const sport: SportLeague = input.sport ?? "nfl";
    const team = input.teams[0] ?? sport.toUpperCase();
    const storylines = SPORT_STORYLINES[sport] ?? SPORT_STORYLINES.other;
    const now = Date.now();
    return storylines.map((entry, index) => ({
      id: `demo-news-${sport}-${index + 1}`,
      title: entry.title,
      source: entry.source,
      // Spread publishedAt so the UI can show "5m ago", "1h ago", etc. —
      // the sidebar formatter handles relative time.
      publishedAt: new Date(now - index * 32 * 60 * 1000).toISOString(),
      team,
      playerIds: input.playerIds.slice(0, 2)
    }));
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Demo News",
      status: "ready",
      detail: "Sport-aware placeholder storylines. Replace with a real feed for live shows."
    };
  }
}
