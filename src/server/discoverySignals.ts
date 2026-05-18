/**
 * Discovery-feed editorial signals — the per-game chips that turn the
 * SportsCenter-style scan from "team names" into "you know why each
 * game is interesting before you tap in."
 *
 * A game can carry up to two signals. The ranker picks the strongest
 * available editorial hook from the slate's raw inputs (markets,
 * news, odds, broadcast metadata) and returns them in priority order
 * so the client renders chips top-down.
 *
 * Priority (strongest first):
 *   1. MARKET SWING — a relevant market just moved >= 5¢. Strongest
 *      because price action is itself a story ("Mahomes line cooled
 *      8 cents in the last 5 min").
 *   2. STARTER NEWS — a news headline that mentions a player ID in
 *      the listener's starter list, or a player's team. The
 *      personalization signal beats generic team news.
 *   3. SHARP LINE — a spread >= 7pts or total at an extreme. Tells
 *      the listener "this is a story before tip-off."
 *   4. MARKET PRICE — current YES cents on the leader. The "scan and
 *      see who's favored" signal.
 *   5. TEAM NEWS — a headline mentioning either team.
 *   6. BROADCAST — when the game is on national TV (ABC, ESPN, FOX,
 *      etc.) — modest signal but better than nothing for marquee
 *      windows.
 *
 * The ranker is PURE — takes raw inputs, returns the ranked signals.
 * Caching, fetching, and team-identifier resolution live in the
 * endpoint that calls this.
 */
import type { GameOdds, MarketSnapshot, NewsItem, SportsGameOption, TeamMeta } from "../shared/contracts";

export type DiscoverySignal =
  | {
      kind: "market-swing";
      source: MarketSnapshot["source"];
      outcomeLabel: string;
      yesCents: number;
      deltaCents: number;
      direction: "warming" | "cooling";
    }
  | {
      kind: "market-price";
      source: MarketSnapshot["source"];
      outcomeLabel: string;
      yesCents: number;
    }
  | {
      kind: "news";
      headline: string;
      source: string;
      personalized: boolean;
    }
  | {
      kind: "sharp-line";
      spread: number;
      total?: number;
      favorite: string;
    }
  | {
      kind: "broadcast";
      channel: string;
    };

export type DiscoverySignalsInput = {
  game: SportsGameOption;
  /** Markets the caller has already filtered to this game (via
   *  `pickRelevantMarketsForGame` + the game's team identifiers).
   *  When empty, the ranker simply skips market signals. */
  relevantMarkets: MarketSnapshot[];
  /** News items from the sport's feed. The ranker matches headlines
   *  to the game by team-name substring + optional playerId set. */
  sportNews: NewsItem[];
  odds?: GameOdds;
  /** Player IDs the listener has on their roster who are on either
   *  side of this game. Used to boost news items that mention one of
   *  them — those are personalized signals and rank higher than
   *  generic team news. */
  listenerStarterPlayerIds?: string[];
};

/** Minimum market move (cents) to surface as a swing chip. Below this,
 *  the move is noise — surfacing it would make the discovery feed feel
 *  twitchy. Matches the swing threshold the show engine uses. */
const SWING_THRESHOLD_CENTS = 5;
/** Sharp line threshold — at or above this in absolute terms is
 *  noteworthy enough to call out on the card. */
const SHARP_LINE_THRESHOLD = 7;
/** National broadcasters worth surfacing as a chip. Local affiliates
 *  ("KIRO 7") aren't editorial signal; the marquee networks are. */
const NATIONAL_BROADCAST_RE = /\b(ABC|CBS|NBC|FOX|ESPN[2]?|ESPNU|TNT|TBS|Apple TV|Prime Video|Amazon|Peacock|Paramount\+?|Max)\b/i;

const MAX_SIGNALS_PER_GAME = 2;

export function rankDiscoverySignalsForGame(input: DiscoverySignalsInput): DiscoverySignal[] {
  const out: DiscoverySignal[] = [];

  // 1. Market swing — the single strongest signal.
  const swing = pickStrongestSwing(input.relevantMarkets);
  if (swing) out.push(swing);

  // 2. Personalized news — mentions a listener starter.
  // 5. Generic team news — fallback when no personalized item.
  // We run both passes in one find so we don't double-allocate; the
  // personalized branch wins when both are eligible.
  const newsSignal = pickNewsSignal(input);
  if (newsSignal && !signalsOverlap(out, newsSignal)) out.push(newsSignal);

  // 3. Sharp line.
  if (out.length < MAX_SIGNALS_PER_GAME) {
    const line = pickSharpLine(input);
    if (line && !signalsOverlap(out, line)) out.push(line);
  }

  // 4. Market price (only when we didn't already surface a swing —
  //    a swing tells you the price implicitly).
  if (out.length < MAX_SIGNALS_PER_GAME && !out.some((s) => s.kind === "market-swing")) {
    const price = pickLeadMarketPrice(input.relevantMarkets);
    if (price) out.push(price);
  }

  // 6. Broadcast — chip-of-last-resort. Only surfaces when nothing
  //    richer is available AND the broadcast is a marquee network.
  if (out.length < MAX_SIGNALS_PER_GAME) {
    const broadcast = pickBroadcastSignal(input.game);
    if (broadcast) out.push(broadcast);
  }

  return out.slice(0, MAX_SIGNALS_PER_GAME);
}

function pickStrongestSwing(markets: MarketSnapshot[]): DiscoverySignal | undefined {
  let best: { snapshot: MarketSnapshot; delta: number } | undefined;
  for (const snapshot of markets) {
    const delta = snapshot.recentDeltaCents ?? 0;
    if (Math.abs(delta) < SWING_THRESHOLD_CENTS) continue;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      best = { snapshot, delta };
    }
  }
  if (!best) return undefined;
  return {
    kind: "market-swing",
    source: best.snapshot.source,
    outcomeLabel: best.snapshot.outcomeLabel,
    yesCents: best.snapshot.yesPriceCents,
    deltaCents: best.delta,
    direction: best.delta > 0 ? "warming" : "cooling"
  };
}

function pickLeadMarketPrice(markets: MarketSnapshot[]): DiscoverySignal | undefined {
  // Markets the caller passed are already ranked-by-relevance. Prefer
  // a moneyline-shaped market over other kinds — that's the "who wins"
  // signal a discovery card most wants to surface. Also prefer the
  // FAVORED side (yesPriceCents >= 50): "Lakers 64¢" reads as
  // confidence; "No 86¢" is editorial nonsense for a scanning eye.
  const candidates = markets
    .filter((m) => m.yesPriceCents >= 50 && m.yesPriceCents <= 95)
    // Skip the "Yes/No" outcome labels — those are paired markets;
    // we want the side that names the team or player.
    .filter((m) => {
      const label = m.outcomeLabel.trim().toLowerCase();
      return label !== "yes" && label !== "no";
    });
  const moneyline = candidates.find((m) => m.marketKind === "moneyline") ?? candidates[0];
  if (!moneyline) return undefined;
  return {
    kind: "market-price",
    source: moneyline.source,
    outcomeLabel: moneyline.outcomeLabel,
    yesCents: moneyline.yesPriceCents
  };
}

function pickNewsSignal(input: DiscoverySignalsInput): DiscoverySignal | undefined {
  if (input.sportNews.length === 0) return undefined;
  const starterIds = new Set(input.listenerStarterPlayerIds ?? []);
  const teamHaystack = buildTeamHaystack(input.game);
  // Personalized pass — find an item that mentions a listener's
  // starter by id. This beats any generic team item.
  if (starterIds.size > 0) {
    const personalized = input.sportNews.find((item) =>
      (item.playerIds ?? []).some((pid) => starterIds.has(pid))
    );
    if (personalized) {
      return {
        kind: "news",
        headline: personalized.title,
        source: personalized.source,
        personalized: true
      };
    }
  }
  // Team pass — title or team field mentions one of this game's teams.
  const teamItem = input.sportNews.find((item) => {
    if (item.team && teamHaystack.has(item.team.toUpperCase())) return true;
    return matchesAnyTeam(item.title, teamHaystack);
  });
  if (teamItem) {
    return {
      kind: "news",
      headline: teamItem.title,
      source: teamItem.source,
      personalized: false
    };
  }
  return undefined;
}

function pickSharpLine(input: DiscoverySignalsInput): DiscoverySignal | undefined {
  if (!input.odds) return undefined;
  const spread = input.odds.spread;
  if (typeof spread !== "number") return undefined;
  if (Math.abs(spread) < SHARP_LINE_THRESHOLD) return undefined;
  // GameOdds.spread is positive when home is favored, negative when
  // away is favored. Pick the favorite accordingly so the chip can
  // surface "{TEAM} −7.5".
  const favorite = spread > 0 ? input.game.homeTeam : input.game.awayTeam;
  return {
    kind: "sharp-line",
    spread,
    total: input.odds.total,
    favorite
  };
}

function pickBroadcastSignal(game: SportsGameOption): DiscoverySignal | undefined {
  if (!game.broadcast) return undefined;
  if (!NATIONAL_BROADCAST_RE.test(game.broadcast)) return undefined;
  return { kind: "broadcast", channel: game.broadcast };
}

function buildTeamHaystack(game: SportsGameOption): Set<string> {
  const set = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    set.add(value.toUpperCase());
  };
  add(game.awayTeam);
  add(game.homeTeam);
  const awayMeta: TeamMeta | undefined = game.awayMeta;
  const homeMeta: TeamMeta | undefined = game.homeMeta;
  add(awayMeta?.displayName);
  add(homeMeta?.displayName);
  add(awayMeta?.shortName);
  add(homeMeta?.shortName);
  return set;
}

function matchesAnyTeam(headline: string, teamHaystack: Set<string>): boolean {
  const upper = headline.toUpperCase();
  for (const team of teamHaystack) {
    if (team.length < 3) continue;
    // Word-boundary match on the longer names; literal substring on
    // abbreviations is too noisy (e.g., "MIA" inside "Miami").
    if (team.length >= 5) {
      if (new RegExp(`\\b${escapeRegex(team)}\\b`).test(upper)) return true;
    } else {
      // Abbreviation: only count it when surrounded by punctuation /
      // spaces so we don't match inside longer words.
      if (new RegExp(`(?:^|[^A-Z])${escapeRegex(team)}(?:[^A-Z]|$)`).test(upper)) return true;
    }
  }
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function signalsOverlap(existing: DiscoverySignal[], candidate: DiscoverySignal): boolean {
  // Dedupe shape: don't surface two "market-*" or two "news" chips on
  // the same card. The ranker already produces at most one per kind,
  // but defensive guard for future additions.
  return existing.some((signal) => {
    if (signal.kind === "market-swing" && candidate.kind === "market-price") return true;
    if (signal.kind === candidate.kind) return true;
    return false;
  });
}
