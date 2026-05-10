import type { GameOdds, OddsProvider, ProviderHealth, SportLeague } from "../shared/contracts";

type Fetcher = typeof fetch;

const ODDS_API_SPORT_KEY: Record<SportLeague, string | undefined> = {
  nfl: "americanfootball_nfl",
  ncaaf: "americanfootball_ncaaf",
  nba: "basketball_nba",
  wnba: "basketball_wnba",
  ncaab: "basketball_ncaab",
  mlb: "baseball_mlb",
  nhl: "icehockey_nhl",
  soccer: undefined,
  other: undefined
};

type OddsApiEvent = {
  id: string;
  sport_key?: string;
  commence_time?: string;
  home_team?: string;
  away_team?: string;
  bookmakers?: Array<{
    key?: string;
    title?: string;
    last_update?: string;
    markets?: Array<{
      key?: "h2h" | "spreads" | "totals" | string;
      outcomes?: Array<{
        name?: string;
        price?: number;
        point?: number;
      }>;
    }>;
  }>;
};

/**
 * The Odds API client. Free tier is 500 requests/month — pair with a
 * cache (W7-style) once we open this up to live traffic.
 *
 * Disabled until `THE_ODDS_API_KEY` is set; absence is treated as a
 * normal "no odds available" response, not an error, so the chain in
 * `createOddsProvider` can return `undefined` cleanly.
 */
export class OddsApiProvider implements OddsProvider {
  id = "the-odds-api";
  private readonly baseUrl = "https://api.the-odds-api.com/v4";

  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetcher: Fetcher = fetch,
    private readonly options: { regions?: string; markets?: string } = {}
  ) {}

  async getOdds(input: { gameId: string; sport: SportLeague; homeTeam: string; awayTeam: string }): Promise<GameOdds | undefined> {
    if (!this.apiKey) return undefined;
    const sportKey = ODDS_API_SPORT_KEY[input.sport];
    if (!sportKey) return undefined;

    const params = new URLSearchParams({
      apiKey: this.apiKey,
      regions: this.options.regions ?? "us",
      markets: this.options.markets ?? "h2h,spreads,totals",
      oddsFormat: "american"
    });
    const response = await this.fetcher(`${this.baseUrl}/sports/${sportKey}/odds?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Odds API request failed: ${response.status} ${response.statusText}`);
    }
    const events = (await response.json()) as OddsApiEvent[];
    const event = pickEvent(events, input.homeTeam, input.awayTeam);
    if (!event) return undefined;
    return normalizeOddsEvent(event, input);
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "The Odds API",
      status: this.apiKey ? "ready" : "disabled",
      detail: this.apiKey ? "Configured. Free tier is 500 requests/month — pair with a cache before opening to live traffic." : "Set THE_ODDS_API_KEY to enable."
    };
  }
}

function pickEvent(events: OddsApiEvent[], homeTeam: string, awayTeam: string): OddsApiEvent | undefined {
  // The Odds API returns full team names ("Kansas City Chiefs"). Our
  // callers pass abbreviations from the scoreboard ("KC"). Translate
  // both sides through a known abbrev→city map and check substring
  // containment in either orientation.
  const homeNeedle = ABBREV_TO_CITY[homeTeam.toUpperCase()] ?? homeTeam.toUpperCase();
  const awayNeedle = ABBREV_TO_CITY[awayTeam.toUpperCase()] ?? awayTeam.toUpperCase();
  return events.find((event) => {
    const h = (event.home_team ?? "").toUpperCase();
    const a = (event.away_team ?? "").toUpperCase();
    return h.includes(homeNeedle.toUpperCase()) && a.includes(awayNeedle.toUpperCase());
  });
}

// NFL-focused abbreviation → city/nickname map. The Odds API returns
// full team names ("Kansas City Chiefs"); ESPN's scoreboard returns
// abbreviations ("KC"). We match by city for most teams and by mascot
// for two-team cities (Chargers/Rams, Giants/Jets) where city alone is
// ambiguous. NBA/NHL/MLB can be added when those sports get real shows.
const ABBREV_TO_CITY: Record<string, string> = {
  KC: "Kansas City", BUF: "Buffalo", DET: "Detroit", PHI: "Philadelphia",
  ATL: "Atlanta", CHI: "Chicago", CIN: "Cincinnati", CLE: "Cleveland",
  DAL: "Dallas", DEN: "Denver", GB: "Green Bay", HOU: "Houston",
  IND: "Indianapolis", JAX: "Jacksonville", LAC: "Chargers", LAR: "Rams",
  LV: "Las Vegas", MIA: "Miami", MIN: "Minnesota", NE: "New England",
  NO: "New Orleans", NYG: "Giants", NYJ: "Jets", PIT: "Pittsburgh",
  SEA: "Seattle", SF: "San Francisco", TB: "Tampa Bay", TEN: "Tennessee",
  WAS: "Washington", WSH: "Washington", CAR: "Carolina", BAL: "Baltimore", ARI: "Arizona"
};

export function normalizeOddsEvent(
  event: OddsApiEvent,
  input: { gameId: string; sport: SportLeague; homeTeam: string; awayTeam: string }
): GameOdds {
  const bookmaker = event.bookmakers?.[0];
  const markets = bookmaker?.markets ?? [];
  const spreadMarket = markets.find((m) => m.key === "spreads");
  const totalsMarket = markets.find((m) => m.key === "totals");
  const h2hMarket = markets.find((m) => m.key === "h2h");

  // Outcomes within a market also use full team names. Translate the
  // abbreviation through the same city map used to pick the event so
  // we find the right outcome by substring.
  const homeNeedle = (ABBREV_TO_CITY[input.homeTeam.toUpperCase()] ?? input.homeTeam).toUpperCase();
  const awayNeedle = (ABBREV_TO_CITY[input.awayTeam.toUpperCase()] ?? input.awayTeam).toUpperCase();
  const homeSpread = spreadMarket?.outcomes?.find((outcome) => outcome.name?.toUpperCase().includes(homeNeedle));
  const totalOver = totalsMarket?.outcomes?.find((outcome) => outcome.name?.toLowerCase() === "over");
  const homeMoneyline = h2hMarket?.outcomes?.find((outcome) => outcome.name?.toUpperCase().includes(homeNeedle));
  const awayMoneyline = h2hMarket?.outcomes?.find((outcome) => outcome.name?.toUpperCase().includes(awayNeedle));

  return {
    gameId: input.gameId,
    sport: input.sport,
    homeTeam: input.homeTeam,
    awayTeam: input.awayTeam,
    spread: homeSpread?.point,
    total: totalOver?.point,
    moneyline:
      homeMoneyline?.price != null || awayMoneyline?.price != null
        ? { home: homeMoneyline?.price, away: awayMoneyline?.price }
        : undefined,
    book: bookmaker?.title,
    fetchedAt: bookmaker?.last_update ?? new Date().toISOString()
  };
}
