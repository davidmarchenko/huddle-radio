import type { NewsItem, NewsProvider, ProviderHealth, SportLeague } from "../shared/contracts";
import { ESPN_SPORTS, type EspnSportPath } from "./espnSportsDataProvider";

type Fetcher = typeof fetch;

type EspnNewsResponse = {
  articles?: EspnArticle[];
  header?: string;
};

type EspnArticle = {
  type?: string;
  headline?: string;
  description?: string;
  published?: string;
  lastModified?: string;
  byline?: string;
  links?: {
    web?: { href?: string };
    api?: { news?: { href?: string } };
  };
  categories?: Array<{
    type?: "team" | "athlete" | "league" | string;
    team?: { id?: string | number; abbreviation?: string };
    athlete?: { id?: string | number; fullName?: string };
  }>;
};

const SPORT_PATH_BY_SPORT: Record<SportLeague, string | undefined> = ESPN_SPORTS.reduce(
  (acc, entry) => {
    acc[entry.sport] = entry.path;
    return acc;
  },
  {} as Record<SportLeague, string | undefined>
);

/**
 * Real news provider hitting ESPN's public news endpoint.
 *
 * Same risk profile as `EspnSportsDataProvider`: unofficial, undocumented,
 * but stable in practice and free. Filters items by team / player so the
 * pregame card surfaces beat-writer copy specifically about the listener's
 * matchup, not generic league chatter.
 *
 * On error or empty response the caller should fall back to the demo
 * provider (the chain wired in `createNewsProvider` handles that).
 */
export class EspnNewsProvider implements NewsProvider {
  id = "espn-news";

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly options: { itemLimit?: number } = {}
  ) {}

  async getLatest(input: { playerIds: string[]; teams: string[]; sport?: SportLeague }): Promise<NewsItem[]> {
    const sport = input.sport ?? "nfl";
    const path = SPORT_PATH_BY_SPORT[sport];
    if (!path) return [];

    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/news?limit=${this.options.itemLimit ?? 20}`;
    const response = await this.fetcher(url);
    if (!response.ok) {
      throw new Error(`ESPN news request failed: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as EspnNewsResponse;
    return normalizeEspnNews(json.articles ?? [], { sport, teams: input.teams, playerIds: input.playerIds });
  }

  async health(): Promise<ProviderHealth> {
    const start = performance.now();
    try {
      const response = await this.fetcher(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=1`);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return {
        id: this.id,
        label: "ESPN News",
        status: "ready",
        detail: "Public ESPN news feed reachable.",
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (error) {
      return {
        id: this.id,
        label: "ESPN News",
        status: "error",
        detail: error instanceof Error ? error.message : "ESPN news health check failed."
      };
    }
  }
}

export function normalizeEspnNews(
  articles: EspnArticle[],
  filter: { sport: SportLeague; teams: string[]; playerIds: string[]; limit?: number }
): NewsItem[] {
  const teamSet = new Set(filter.teams.map((team) => team.toUpperCase()).filter(Boolean));
  const playerSet = new Set(filter.playerIds.filter(Boolean));
  const items: NewsItem[] = [];

  const hasTeamFilter = teamSet.size > 0;
  const hasPlayerFilter = playerSet.size > 0;
  for (const article of articles) {
    if (!article.headline) continue;
    const articleTeams = teamsFromCategories(article.categories);
    const articlePlayers = playersFromCategories(article.categories);
    if (hasTeamFilter || hasPlayerFilter) {
      const teamMatch = hasTeamFilter && articleTeams.some((team) => teamSet.has(team.toUpperCase()));
      const playerMatch = hasPlayerFilter && articlePlayers.some((id) => playerSet.has(id));
      if (!teamMatch && !playerMatch) continue;
    }

    items.push({
      id: idForArticle(article, filter.sport),
      title: article.headline,
      source: article.byline ? `ESPN — ${article.byline}` : "ESPN",
      url: article.links?.web?.href,
      publishedAt: article.published ?? article.lastModified ?? new Date().toISOString(),
      team: articleTeams[0],
      playerIds: articlePlayers.slice(0, 4)
    });
  }

  // Newest first; cap at limit.
  items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  return items.slice(0, filter.limit ?? 6);
}

function teamsFromCategories(categories?: EspnArticle["categories"]): string[] {
  if (!categories) return [];
  const out: string[] = [];
  for (const category of categories) {
    if (category.team?.abbreviation) out.push(category.team.abbreviation);
  }
  return out;
}

function playersFromCategories(categories?: EspnArticle["categories"]): string[] {
  if (!categories) return [];
  const out: string[] = [];
  for (const category of categories) {
    if (category.athlete?.id != null) out.push(String(category.athlete.id));
  }
  return out;
}

function idForArticle(article: EspnArticle, sport: SportLeague): string {
  const url = article.links?.web?.href;
  if (url) return `espn-${sport}-${hash(url)}`;
  return `espn-${sport}-${hash(article.headline ?? "no-headline")}-${article.published ?? ""}`;
}

function hash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

export type { EspnArticle, EspnSportPath };
