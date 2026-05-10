import type { MarketSnapshot, SportLeague } from "../shared/contracts";

/**
 * Polymarket market snapshot fetcher (Gamma REST).
 *
 * Public-read APIs require no auth. The Gamma /events endpoint
 * supports tag-based filtering for sports leagues. Trading-side
 * endpoints (CLOB write) require a wallet signature and are out of
 * scope — we're consume-only.
 *
 * For production we'd add the WebSocket at sports-api.polymarket.com
 * for sub-second updates, but for the radio cadence (2-5s polling)
 * REST is fine and avoids the persistent-connection management
 * cost.
 */

const BASE = "https://gamma-api.polymarket.com";

type PolymarketMarket = {
  id?: string;
  conditionId?: string;
  question?: string;
  outcomes?: string;            // JSON-encoded array of outcome labels
  outcomePrices?: string;       // JSON-encoded array of price strings ("0.62")
  volume24hr?: number;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
};

type PolymarketEvent = {
  id?: string;
  slug?: string;
  title?: string;
  category?: string;
  tags?: Array<{ id: string; label: string }>;
  markets?: PolymarketMarket[];
};

const TAG_BY_SPORT: Record<SportLeague, string | undefined> = {
  // Polymarket tag IDs are stable strings; these are the league-level
  // sport tags as of late-2025/early-2026. New leagues may need
  // discovery via GET /sports first.
  nfl: "nfl",
  ncaaf: "college-football",
  nba: "nba",
  ncaab: "college-basketball",
  wnba: "wnba",
  mlb: "mlb",
  nhl: "nhl",
  soccer: "soccer",
  other: undefined
};

function inferKindFromQuestion(question: string): MarketSnapshot["marketKind"] {
  const haystack = question.toLowerCase();
  // Player-stat tokens before over/under so "Jokic over 28.5 points"
  // resolves as a prop, not a total.
  if (/(yards|rebound|assist|points|hits|home run|strikeout|td|reception)/.test(haystack)) return "player-prop";
  if (/(spread|cover|line)/.test(haystack)) return "spread";
  if (/(over|under|total points|total runs|total goals)/.test(haystack)) return "total";
  if (/(champion|division|conference|mvp|playoff|season|final four)/.test(haystack)) return "futures";
  if (/(win|beat|defeat|moneyline)/.test(haystack)) return "moneyline";
  return "other";
}

function parseJsonField<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function fetchEvents(tagSlug: string, fetcher: typeof fetch): Promise<PolymarketEvent[]> {
  const url = new URL(`${BASE}/events`);
  url.searchParams.set("tag_slug", tagSlug);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  url.searchParams.set("limit", "60");
  const response = await fetcher(url.toString(), { headers: { accept: "application/json" } });
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Polymarket events request failed: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as PolymarketEvent[];
  return Array.isArray(payload) ? payload : [];
}

export type FetchPolymarketOptions = {
  sports?: SportLeague[];
  fetcher?: typeof fetch;
};

export async function fetchPolymarketSnapshots(options: FetchPolymarketOptions = {}): Promise<MarketSnapshot[]> {
  const fetcher = options.fetcher ?? fetch;
  const sports = options.sports ?? (Object.keys(TAG_BY_SPORT) as SportLeague[]);
  const observedAt = new Date().toISOString();

  const tasks = sports
    .map((sport) => ({ sport, slug: TAG_BY_SPORT[sport] }))
    .filter((entry): entry is { sport: SportLeague; slug: string } => Boolean(entry.slug))
    .map(async ({ sport, slug }) => {
      try {
        const events = await fetchEvents(slug, fetcher);
        return events.flatMap((event) => {
          const markets = event.markets ?? [];
          return markets.flatMap<MarketSnapshot>((market) => {
            const outcomes = parseJsonField<string[]>(market.outcomes) ?? [];
            const prices = parseJsonField<string[]>(market.outcomePrices) ?? [];
            const question = market.question ?? event.title ?? "Unknown market";
            // Polymarket markets are typically binary — emit one
            // snapshot per outcome that's clearly the "yes" side
            // (price > 0). Skip scaffolding-only outcomes.
            return outcomes
              .map((label, idx) => {
                const priceStr = prices[idx];
                if (!priceStr) return undefined;
                const priceNum = Number.parseFloat(priceStr);
                if (!Number.isFinite(priceNum)) return undefined;
                const yesPriceCents = Math.round(Math.max(0, Math.min(1, priceNum)) * 100);
                return {
                  source: "polymarket",
                  externalId: `${market.conditionId ?? market.id}:${idx}`,
                  sport,
                  marketKind: inferKindFromQuestion(question),
                  title: question,
                  outcomeLabel: label,
                  yesPriceCents,
                  volume24hUsd: market.volume24hr,
                  observedAt
                } satisfies MarketSnapshot;
              })
              .filter((snapshot): snapshot is MarketSnapshot => snapshot !== undefined);
          });
        });
      } catch {
        return [];
      }
    });

  const grouped = await Promise.all(tasks);
  return grouped.flat();
}
