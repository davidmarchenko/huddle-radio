/**
 * RedditGameThreadProvider — pulls fan reactions from the live game
 * thread on the relevant team subreddit.
 *
 * Strategy:
 *
 *   1. Map sport → subreddit ("nba" → "r/nba", "wnba" → "r/wnba", …).
 *   2. Search that sub for a game thread mentioning both teams. Cache
 *      the thread URL per gameId for ~10 min so we don't re-search
 *      every 30s tick.
 *   3. Fetch the thread's comments JSON, take the top N by score, and
 *      emit them as `EnrichmentSignal[]` of kind="reaction".
 *
 * Reddit is a flaky free source, so the provider is forgiving:
 *
 *   - Returns `[]` (never throws past the public surface) so the
 *     aggregator's `Promise.allSettled` never sees a rejection from us.
 *   - Honours the aggregator's deadline via AbortSignal so a slow
 *     reddit.com doesn't hold up a tick.
 *   - Caches both the thread URL and the last successful fetch so a
 *     transient 429/503 doesn't blank the show.
 *   - Sets a custom User-Agent — Reddit aggressively rate-limits the
 *     default `node-fetch` UA.
 *
 * What we DON'T do (intentional):
 *   - Authenticate. Public JSON endpoints are enough for read-only
 *     comment access; OAuth would add complexity and another secret.
 *   - Hit /api/comments live-stream. We poll the thread JSON instead;
 *     the aggregator's 30s tick is finer-grained than fan thread
 *     activity matters anyway.
 */

import type { EnrichmentSignal, ProviderHealth, SportLeague, SportsGameState, TeamMeta } from "../../shared/contracts";
import type { EnrichmentProvider } from "./types";

type Fetcher = typeof fetch;

const SUBREDDIT_BY_SPORT: Partial<Record<SportLeague, string>> = {
  nba: "nba",
  wnba: "wnba",
  nfl: "nfl",
  mlb: "baseball",
  nhl: "hockey",
  ncaaf: "CFB",
  ncaab: "CollegeBasketball",
  soccer: "soccer"
};

const THREAD_CACHE_MS = 10 * 60 * 1000;
const REQUEST_USER_AGENT = "huddle-radio/1.0 (free-tier; contact via app)";
const COMMENTS_LIMIT = 50;
const TOP_N_COMMENTS = 12;
/** Comments shorter than this are usually emoji-only or "lol" — skip. */
const MIN_COMMENT_LENGTH = 15;
/** Comments longer than this are usually copy-pasta or off-topic. */
const MAX_COMMENT_LENGTH = 280;

type ThreadCacheEntry = { url: string; fetchedAt: number };

type RedditSearchResponse = {
  data?: {
    children?: Array<{
      data?: {
        id?: string;
        title?: string;
        url?: string;
        permalink?: string;
        link_flair_text?: string;
        num_comments?: number;
        created_utc?: number;
      };
    }>;
  };
};

type RedditCommentNode = {
  kind?: string;
  data?: {
    id?: string;
    body?: string;
    score?: number;
    created_utc?: number;
    author?: string;
    stickied?: boolean;
    distinguished?: string | null;
  };
};

type RedditCommentsResponse = Array<{
  data?: {
    children?: RedditCommentNode[];
  };
}>;

type RedditProviderOptions = {
  fetcher?: Fetcher;
  now?: () => number;
};

export class RedditGameThreadProvider implements EnrichmentProvider {
  id = "reddit";
  label = "Reddit Game Threads";

  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly threadCache = new Map<string, ThreadCacheEntry>();

  constructor(options: RedditProviderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async gather(input: { game: SportsGameState; deadlineMs: number }): Promise<EnrichmentSignal[]> {
    const subreddit = SUBREDDIT_BY_SPORT[input.game.sport];
    if (!subreddit) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.deadlineMs);
    try {
      const threadUrl = await this.findGameThread(subreddit, input.game, controller.signal);
      if (!threadUrl) return [];
      const comments = await this.fetchComments(threadUrl, controller.signal);
      return rankAndShape(comments, input.game);
    } catch {
      // Per-contract: providers must never throw. Swallow + return [].
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async findGameThread(
    subreddit: string,
    game: SportsGameState,
    signal: AbortSignal
  ): Promise<string | undefined> {
    const cached = this.threadCache.get(game.gameId);
    if (cached && this.now() - cached.fetchedAt < THREAD_CACHE_MS) return cached.url;

    const homeNames = candidateNames(game.homeTeam, game.homeMeta);
    const awayNames = candidateNames(game.awayTeam, game.awayMeta);
    // Pick the most-likely-to-match string for the search query. ESPN
    // abbrevs like "OKC" / "VGK" / "GB" don't appear in Reddit titles
    // ("Oklahoma City Thunder", "Vegas Golden Knights", "Green Bay
    // Packers") — shortName / displayName work much better. Falls back
    // to the abbrev only when meta is absent.
    const homeQuery = preferredSearchTerm(game.homeTeam, game.homeMeta);
    const awayQuery = preferredSearchTerm(game.awayTeam, game.awayMeta);
    const query = `flair:"game thread" ${awayQuery} ${homeQuery}`;
    const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&limit=10`;
    const response = await this.fetcher(url, {
      signal,
      headers: { "User-Agent": REQUEST_USER_AGENT, Accept: "application/json" }
    });
    if (!response.ok) return cached?.url;
    const json = (await response.json()) as RedditSearchResponse;
    const children = json.data?.children ?? [];

    const match = children.find((child) => {
      const title = (child.data?.title ?? "").toLowerCase();
      const flair = (child.data?.link_flair_text ?? "").toLowerCase();
      const looksLikeGameThread = flair.includes("game thread") || title.includes("game thread");
      // Match on either team appearing in the title — not both, since
      // some subs only put one team in the title for road games. We
      // accept any of the candidate names (abbrev, shortName, full
      // displayName) so "Game Thread: Oklahoma City Thunder @ Heat"
      // matches an "OKC" gameState.
      return looksLikeGameThread && (titleMatchesAny(title, homeNames) || titleMatchesAny(title, awayNames));
    });

    const permalink = match?.data?.permalink;
    if (!permalink) return cached?.url;
    const threadUrl = `https://www.reddit.com${permalink}.json?limit=${COMMENTS_LIMIT}&sort=top`;
    this.threadCache.set(game.gameId, { url: threadUrl, fetchedAt: this.now() });
    return threadUrl;
  }

  async health(): Promise<ProviderHealth> {
    const start = performance.now();
    try {
      // Cheapest reachability check: 1-item listing on a stable sub.
      // Doesn't burn search quota and tells us whether reddit.com is
      // serving JSON to our UA (which is the most common failure
      // mode — 429s and Cloudflare blocks both look like non-2xx
      // responses here).
      const response = await this.fetcher("https://www.reddit.com/r/nba/new.json?limit=1", {
        headers: { "User-Agent": REQUEST_USER_AGENT, Accept: "application/json" }
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return {
        id: this.id,
        label: this.label,
        status: "ready",
        detail: "Reddit JSON endpoint reachable.",
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (error) {
      return {
        id: this.id,
        label: this.label,
        status: "error",
        detail: error instanceof Error ? error.message : "Reddit health check failed."
      };
    }
  }

  private async fetchComments(threadUrl: string, signal: AbortSignal): Promise<RedditCommentNode[]> {
    const response = await this.fetcher(threadUrl, {
      signal,
      headers: { "User-Agent": REQUEST_USER_AGENT, Accept: "application/json" }
    });
    if (!response.ok) return [];
    const json = (await response.json()) as RedditCommentsResponse;
    // Reddit returns [postListing, commentListing]; we want index 1.
    const commentListing = json[1];
    return commentListing?.data?.children ?? [];
  }
}

function rankAndShape(nodes: RedditCommentNode[], game: SportsGameState): EnrichmentSignal[] {
  const candidates: Array<{ signal: EnrichmentSignal; weight: number }> = [];
  for (const node of nodes) {
    const data = node.data;
    if (!data?.body || !data.id) continue;
    if (data.stickied) continue; // mod posts, rules, etc.
    if (data.distinguished === "moderator") continue;
    const text = data.body.trim();
    if (text.length < MIN_COMMENT_LENGTH || text.length > MAX_COMMENT_LENGTH) continue;
    if (text.startsWith("[deleted]") || text.startsWith("[removed]")) continue;
    const score = data.score ?? 0;
    if (score < 1) continue; // downvoted comments are usually noise.

    const occurredAtMs = (data.created_utc ?? 0) * 1000;
    const signal: EnrichmentSignal = {
      id: `reddit-${data.id}`,
      source: "reddit",
      kind: "reaction",
      // Normalize provider score to ~0..1 range; raw upvotes vary
      // wildly between game-thread sizes (10 in a regular-season WNBA
      // game vs 5000 in a Lakers playoff). Log-compress.
      score: Math.min(1, Math.log10(score + 1) / 3),
      text,
      occurredAt: occurredAtMs > 0 ? new Date(occurredAtMs).toISOString() : new Date().toISOString(),
      refs: { teamId: detectTeamRef(text, game) }
    };
    candidates.push({ signal, weight: score });
  }
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates.slice(0, TOP_N_COMMENTS).map((entry) => entry.signal);
}

function detectTeamRef(text: string, game: SportsGameState): string | undefined {
  const lower = text.toLowerCase();
  if (lower.includes(game.homeTeam.toLowerCase())) return game.homeTeam;
  if (lower.includes(game.awayTeam.toLowerCase())) return game.awayTeam;
  return undefined;
}

/** All names we'd accept as identifying a team in a Reddit thread title.
 *  ESPN abbrev + every TeamMeta string they provide. Trimmed + lowercased,
 *  empty strings dropped. Order doesn't matter — caller uses `some`. */
function candidateNames(abbrev: string, meta?: TeamMeta): string[] {
  const names = [abbrev, meta?.abbreviation, meta?.shortName, meta?.displayName];
  return names
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    .map((n) => n.trim().toLowerCase());
}

/** Best single string to put in a Reddit search query. shortName /
 *  displayName beat abbrevs because Reddit threads spell out team
 *  names; falls back to the abbrev only when meta is unavailable. */
function preferredSearchTerm(abbrev: string, meta?: TeamMeta): string {
  return meta?.shortName ?? meta?.displayName ?? meta?.abbreviation ?? abbrev;
}

/** Substring match with false-positive protection for short abbrevs.
 *
 *  Long names (≥4 chars) — plain substring is fine.
 *
 *  Short names (1-3 chars) — must appear at the START of a word.
 *  Team abbrevs are typically prefixes of the spelled-out name ("SEA"
 *  → "Seattle", "OKC" → "Oklahoma City"), so we accept word-prefix
 *  matches; this catches the abbrev-only case while rejecting "LA"
 *  hitting "play" (the "la" in "play" is mid-word, not a prefix). */
function titleMatchesAny(titleLower: string, names: string[]): boolean {
  for (const name of names) {
    if (name.length === 0) continue;
    if (name.length >= 4) {
      if (titleLower.includes(name)) return true;
      continue;
    }
    const re = new RegExp(`(^|[^a-z])${escapeRegex(name)}`);
    if (re.test(titleLower)) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
