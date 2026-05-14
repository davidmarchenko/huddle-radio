/**
 * WikipediaProvider — pulls one-sentence storyline grounding from
 * Wikipedia's REST API.
 *
 * Two strategies per gather() call:
 *
 *   1. Team summaries — once per game, cache for 6 hours. Catches
 *      stable context like "the Storm have made the WNBA Finals 4
 *      times in the last decade" that the hosts can weave in.
 *
 *   2. Player summaries — extract probable player names from the
 *      current play's headline (TitleCase 2-word phrases), look up
 *      each via the search endpoint, and pull the first sentence.
 *      Cached aggressively per-name (24h) since player Wikipedia
 *      content is stable enough to outlive any show.
 *
 * Wikipedia's REST API:
 *   - /api/rest_v1/page/summary/{title} → { extract: "1-2 sentences" }
 *   - /w/api.php?action=opensearch&search=... → fuzzy search
 *
 * Both are unauthenticated, generous on rate limits, and explicit
 * about the User-Agent contract:
 *   https://www.mediawiki.org/wiki/API:Etiquette
 *
 * Per-contract: never throws past gather().
 */

import type { EnrichmentSignal, ProviderHealth, SportsGameState, TeamMeta } from "../../shared/contracts";
import type { EnrichmentProvider } from "./types";

type Fetcher = typeof fetch;

const REST_BASE = "https://en.wikipedia.org/api/rest_v1/page/summary";
const SEARCH_BASE = "https://en.wikipedia.org/w/api.php";
const REQUEST_USER_AGENT =
  "huddle-radio/1.0 (https://huddleradio.app; contact@huddleradio.app)";

const TEAM_CACHE_MS = 6 * 60 * 60 * 1000; // 6h — team blurbs are stable
const PLAYER_CACHE_MS = 24 * 60 * 60 * 1000; // 24h — same
const SEARCH_NEGATIVE_CACHE_MS = 30 * 60 * 1000; // 30m — don't re-fail fast
const MAX_PLAYERS_PER_TICK = 2;
const MAX_SUMMARY_LENGTH = 240;

type WikipediaSummary = {
  title?: string;
  description?: string;
  extract?: string;
  type?: string; // "standard" | "disambiguation" | "no-extract"
};

type WikipediaSearchResponse = [string, string[], string[], string[]]; // OpenSearch shape

type CacheEntry<T> = { fetchedAt: number; value: T };

type WikipediaProviderOptions = {
  fetcher?: Fetcher;
  now?: () => number;
};

export class WikipediaProvider implements EnrichmentProvider {
  id = "wiki";
  label = "Wikipedia";

  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly summaryCache = new Map<string, CacheEntry<WikipediaSummary | null>>();
  /** Player-name → resolved-title lookups. Same negative-cache
   *  pattern as summaries — we don't want a misspelled name in a
   *  recurring play to keep hitting the search endpoint every tick. */
  private readonly searchCache = new Map<string, CacheEntry<string | null>>();

  constructor(options: WikipediaProviderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async gather(input: { game: SportsGameState; deadlineMs: number }): Promise<EnrichmentSignal[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.deadlineMs);
    try {
      // Two parallel paths — team blurb (stable) + player blurbs
      // (extracted from this tick's play). Each handles its own
      // failures so a Wikipedia 503 on one path doesn't kill the
      // other.
      const [teamSignals, playerSignals] = await Promise.all([
        this.fetchTeamSignals(input.game, controller.signal).catch(() => []),
        this.fetchPlayerSignals(input.game, controller.signal).catch(() => [])
      ]);
      return [...teamSignals, ...playerSignals];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchTeamSignals(game: SportsGameState, signal: AbortSignal): Promise<EnrichmentSignal[]> {
    const titles = [
      teamWikiTitle(game.homeTeam, game.homeMeta, game.sport),
      teamWikiTitle(game.awayTeam, game.awayMeta, game.sport)
    ].filter((t): t is string => Boolean(t));
    const summaries = await Promise.all(
      titles.map((title) => this.fetchSummaryCached(title, TEAM_CACHE_MS, signal))
    );
    const out: EnrichmentSignal[] = [];
    for (let i = 0; i < summaries.length; i += 1) {
      const summary = summaries[i];
      const title = titles[i];
      if (!summary?.extract) continue;
      const text = trimSummary(summary.extract);
      if (text.length === 0) continue;
      out.push({
        id: `wiki-team-${stableHash(title)}`,
        source: "wiki",
        kind: "context",
        text,
        // Team blurbs are stable context — modest score so they
        // tiebreak below live signals but stay available when the
        // pregame angle hint asks for storyline.
        score: 0.4,
        occurredAt: new Date().toISOString(),
        refs: { teamId: title }
      });
    }
    return out;
  }

  private async fetchPlayerSignals(game: SportsGameState, signal: AbortSignal): Promise<EnrichmentSignal[]> {
    const playerNames = extractPlayerNames(game).slice(0, MAX_PLAYERS_PER_TICK);
    if (playerNames.length === 0) return [];
    const summaries = await Promise.all(
      playerNames.map(async (name) => {
        const title = await this.resolvePlayerTitle(name, signal);
        if (!title) return undefined;
        return this.fetchSummaryCached(title, PLAYER_CACHE_MS, signal);
      })
    );
    const out: EnrichmentSignal[] = [];
    for (let i = 0; i < summaries.length; i += 1) {
      const summary = summaries[i];
      if (!summary?.extract) continue;
      const text = trimSummary(summary.extract);
      if (text.length === 0) continue;
      out.push({
        id: `wiki-player-${stableHash(playerNames[i])}`,
        source: "wiki",
        kind: "context",
        text,
        score: 0.55,
        occurredAt: new Date().toISOString()
      });
    }
    return out;
  }

  /** Search for a player's Wikipedia title using OpenSearch — returns
   *  the most likely page title, or undefined if the search produced
   *  nothing useful. Negative results are cached too so a misspelled
   *  name doesn't keep hitting the API every tick. */
  private async resolvePlayerTitle(name: string, signal: AbortSignal): Promise<string | undefined> {
    const cached = this.searchCache.get(name);
    if (cached) {
      const expiresAt = cached.fetchedAt + (cached.value === null ? SEARCH_NEGATIVE_CACHE_MS : PLAYER_CACHE_MS);
      if (this.now() < expiresAt) return cached.value ?? undefined;
    }
    try {
      const url = `${SEARCH_BASE}?action=opensearch&search=${encodeURIComponent(name)}&limit=1&namespace=0&format=json&origin=*`;
      const response = await this.fetcher(url, {
        signal,
        headers: { "User-Agent": REQUEST_USER_AGENT, Accept: "application/json" }
      });
      if (!response.ok) {
        this.searchCache.set(name, { fetchedAt: this.now(), value: null });
        return undefined;
      }
      const json = (await response.json()) as WikipediaSearchResponse;
      const title = json[1]?.[0] ?? null;
      this.searchCache.set(name, { fetchedAt: this.now(), value: title });
      return title ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchSummaryCached(
    title: string,
    ttlMs: number,
    signal: AbortSignal
  ): Promise<WikipediaSummary | null> {
    const cached = this.summaryCache.get(title);
    if (cached) {
      const expiresAt = cached.fetchedAt + (cached.value === null ? SEARCH_NEGATIVE_CACHE_MS : ttlMs);
      if (this.now() < expiresAt) return cached.value;
    }
    try {
      const url = `${REST_BASE}/${encodeURIComponent(title)}`;
      const response = await this.fetcher(url, {
        signal,
        headers: { "User-Agent": REQUEST_USER_AGENT, Accept: "application/json" }
      });
      if (!response.ok) {
        this.summaryCache.set(title, { fetchedAt: this.now(), value: null });
        return null;
      }
      const json = (await response.json()) as WikipediaSummary;
      // Disambiguation pages are not useful — they list options instead
      // of providing a fact. Treat as a miss.
      const value = json.type === "disambiguation" ? null : json;
      this.summaryCache.set(title, { fetchedAt: this.now(), value });
      return value;
    } catch {
      // Don't poison the cache on a transient error — let the next
      // tick try again.
      return null;
    }
  }

  async health(): Promise<ProviderHealth> {
    const start = performance.now();
    try {
      const response = await this.fetcher(`${REST_BASE}/${encodeURIComponent("Basketball")}`, {
        headers: { "User-Agent": REQUEST_USER_AGENT, Accept: "application/json" }
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return {
        id: this.id,
        label: this.label,
        status: "ready",
        detail: "Wikipedia REST API reachable.",
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (error) {
      return {
        id: this.id,
        label: this.label,
        status: "error",
        detail: error instanceof Error ? error.message : "Wikipedia health check failed."
      };
    }
  }
}

/** Construct a Wikipedia-friendly title for a sports team. Wikipedia
 *  uses full names + the league suffix in disambiguation cases, but
 *  the page-summary endpoint accepts the bare team name when it's
 *  unique. We prefer the displayName from TeamMeta. */
function teamWikiTitle(abbrev: string, meta: TeamMeta | undefined, sport: SportsGameState["sport"]): string | undefined {
  const name = meta?.displayName ?? meta?.shortName ?? abbrev;
  if (!name || name.length < 3) return undefined;
  // Replace spaces with underscores per Wikipedia URL convention.
  // Don't add a sport suffix yet — most major-team pages resolve at
  // their bare name; ambiguous cases (e.g. "Wizards") would need
  // sport-specific routing, but Wikipedia's redirect logic handles
  // most of them today.
  return name.replace(/\s+/g, "_");
}

/** Extract probable player names from the current play. Looks for
 *  TitleCase 2-word phrases in the play headline + description.
 *  Conservative — false positives just waste a Wikipedia call (which
 *  is then negative-cached); false negatives mean missing context.
 *  Future: prefer canonical player ids from the fantasy provider. */
function extractPlayerNames(game: SportsGameState): string[] {
  const text = [game.currentPlay?.headline, game.currentPlay?.description]
    .filter((s): s is string => Boolean(s))
    .join(" ");
  if (text.length === 0) return [];
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g) ?? [];
  // Drop obvious false positives — short single-word "TitleCase"
  // hits, sport league names, team shortNames already covered by the
  // team path.
  const teamShorts = new Set(
    [game.homeMeta?.shortName, game.awayMeta?.shortName, game.homeMeta?.displayName, game.awayMeta?.displayName]
      .filter((s): s is string => Boolean(s))
      .map((s) => s.toLowerCase())
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of matches) {
    const lower = match.toLowerCase();
    if (teamShorts.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(match);
  }
  return out;
}

function trimSummary(extract: string): string {
  // Take the first sentence, capped at MAX_SUMMARY_LENGTH. Most
  // Wikipedia "extract" fields are 1-3 sentences; we want the
  // anchor sentence that names who/what the subject is.
  const firstSentence = extract.match(/^[^.!?]*[.!?]/)?.[0]?.trim();
  const candidate = firstSentence ?? extract;
  return candidate.length > MAX_SUMMARY_LENGTH
    ? `${candidate.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : candidate;
}

function stableHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
