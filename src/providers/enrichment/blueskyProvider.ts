/**
 * BlueskyProvider — pulls fan + beat-reporter posts from Bluesky's
 * public AT-Proto search endpoint.
 *
 * Two strategies, combined per call:
 *
 *   1. General search — `app.bsky.feed.searchPosts?q=<team> game` over
 *      the last hour, sorted by latest. Catches the firehose of fan
 *      reactions during live play.
 *
 *   2. Curated beat-reporter list per sport — pull recent posts from
 *      a small whitelist of accounts (Wojnarowski, Schefter, etc.).
 *      Higher signal-to-noise; weighted higher in the dedup
 *      aggregator's source-trust ranking. Optional — the provider
 *      works fine when no beat-reporter handles are configured for
 *      a given sport.
 *
 * Public Bluesky endpoints don't require auth, which keeps this in
 * the "free" tier alongside Reddit. Rate limits are generous; we
 * cache per-game for 90s and dedupe across both strategies before
 * shipping signals to the aggregator.
 *
 * Per-contract: never throws past `gather()` — the aggregator wraps
 * us in `Promise.allSettled` but a thrown rejection still costs us
 * a log line, and reaches `tickSummary` as a flapping provider.
 */

import type { EnrichmentSignal, ProviderHealth, SportLeague, SportsGameState, TeamMeta } from "../../shared/contracts";
import type { EnrichmentProvider } from "./types";

type Fetcher = typeof fetch;

const PUBLIC_API = "https://public.api.bsky.app/xrpc";
const REQUEST_USER_AGENT = "huddle-radio/1.0";
const SEARCH_LIMIT = 25;
const TOP_N = 10;
const POST_CACHE_MS = 90 * 1000;
const MIN_POST_LENGTH = 25;
const MAX_POST_LENGTH = 280;
const MIN_LIKES = 1;

/** Curated beat-reporter handles per sport. Empty by default — every
 *  handle here MUST be verified to actually exist on Bluesky and
 *  actually post sports content. Several major NBA/NFL insiders
 *  (Wojnarowski, Schefter, Shams, Rapoport) post primarily to X and
 *  do NOT have active Bluesky accounts as of this writing — listing
 *  guesses here just causes silent 404 floods on every tick.
 *
 *  When adding a handle:
 *    1. Confirm the account exists at https://bsky.app/profile/<handle>
 *    2. Confirm the post cadence is meaningful for live shows
 *    3. Note the verification date in a comment alongside the entry
 *
 *  Until that work is done, the general search path (searchPosts on
 *  team names + "game") still surfaces fan reactions for every sport
 *  — the curated path is purely additive. */
const BEAT_REPORTERS_BY_SPORT: Partial<Record<SportLeague, string[]>> = {
  nba: [],
  wnba: [],
  nfl: [],
  mlb: [],
  nhl: [],
  ncaaf: [],
  ncaab: [],
  soccer: []
};

type BlueskySearchResponse = {
  posts?: BlueskyPost[];
  cursor?: string;
};

type BlueskyAuthorFeedResponse = {
  feed?: Array<{ post?: BlueskyPost }>;
  cursor?: string;
};

type BlueskyPost = {
  uri?: string;
  cid?: string;
  author?: { did?: string; handle?: string; displayName?: string };
  record?: { text?: string; createdAt?: string };
  replyCount?: number;
  likeCount?: number;
  repostCount?: number;
  indexedAt?: string;
};

type CacheEntry = { fetchedAt: number; signals: EnrichmentSignal[] };

type BlueskyProviderOptions = {
  fetcher?: Fetcher;
  now?: () => number;
  /** Override the per-sport beat-reporter list. Tests use this to
   *  inject known handles without depending on the production list
   *  (which is intentionally empty until handles are verified). */
  beatReporters?: Partial<Record<SportLeague, string[]>>;
};

export class BlueskyProvider implements EnrichmentProvider {
  id = "bluesky";
  label = "Bluesky";

  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly beatReporters: Partial<Record<SportLeague, string[]>>;

  constructor(options: BlueskyProviderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.beatReporters = options.beatReporters ?? BEAT_REPORTERS_BY_SPORT;
  }

  async gather(input: { game: SportsGameState; deadlineMs: number }): Promise<EnrichmentSignal[]> {
    const cacheKey = `${input.game.sport}:${input.game.gameId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && this.now() - cached.fetchedAt < POST_CACHE_MS) return cached.signals;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.deadlineMs);
    try {
      const [searchPosts, beatPosts] = await Promise.all([
        this.searchPosts(input.game, controller.signal).catch(() => []),
        this.fetchBeatReporters(input.game.sport, controller.signal).catch(() => [])
      ]);
      const signals = mergeAndShape([...beatPosts, ...searchPosts], input.game, this.beatReporters);
      this.cache.set(cacheKey, { fetchedAt: this.now(), signals });
      return signals;
    } catch {
      // Per-contract: never throw past the public surface.
      return cached?.signals ?? [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async searchPosts(game: SportsGameState, signal: AbortSignal): Promise<BlueskyPost[]> {
    const query = buildSearchQuery(game);
    if (!query) return [];
    const url = `${PUBLIC_API}/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}&sort=latest`;
    const response = await this.fetcher(url, {
      signal,
      headers: { "User-Agent": REQUEST_USER_AGENT, Accept: "application/json" }
    });
    if (!response.ok) return [];
    const json = (await response.json()) as BlueskySearchResponse;
    return json.posts ?? [];
  }

  private async fetchBeatReporters(sport: SportLeague, signal: AbortSignal): Promise<BlueskyPost[]> {
    const handles = this.beatReporters[sport] ?? [];
    if (handles.length === 0) return [];
    // Cap at 4 handles per tick so a long beat-reporter list doesn't
    // blow the deadline budget. Future: rotate which handles we hit.
    const capped = handles.slice(0, 4);
    const results = await Promise.allSettled(
      capped.map((handle) => this.fetchOneAuthor(handle, signal))
    );
    const out: BlueskyPost[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") out.push(...r.value);
    }
    return out;
  }

  private async fetchOneAuthor(handle: string, signal: AbortSignal): Promise<BlueskyPost[]> {
    // 5 most recent posts per beat reporter — enough to catch a
    // breaking-news drop but not so many we drown out fan voices.
    const url = `${PUBLIC_API}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=5&filter=posts_no_replies`;
    const response = await this.fetcher(url, {
      signal,
      headers: { "User-Agent": REQUEST_USER_AGENT, Accept: "application/json" }
    });
    if (!response.ok) return [];
    const json = (await response.json()) as BlueskyAuthorFeedResponse;
    return (json.feed ?? [])
      .map((entry) => entry.post)
      .filter((p): p is BlueskyPost => Boolean(p));
  }

  async health(): Promise<ProviderHealth> {
    const start = performance.now();
    try {
      // Cheap reachability check — searching for a stable, low-traffic
      // term that always returns a 200 with at least zero results.
      const response = await this.fetcher(
        `${PUBLIC_API}/app.bsky.feed.searchPosts?q=basketball&limit=1`,
        { headers: { "User-Agent": REQUEST_USER_AGENT, Accept: "application/json" } }
      );
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return {
        id: this.id,
        label: this.label,
        status: "ready",
        detail: "Bluesky public search reachable.",
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (error) {
      return {
        id: this.id,
        label: this.label,
        status: "error",
        detail: error instanceof Error ? error.message : "Bluesky health check failed."
      };
    }
  }
}

function buildSearchQuery(game: SportsGameState): string {
  const homeName = preferredName(game.homeTeam, game.homeMeta);
  const awayName = preferredName(game.awayTeam, game.awayMeta);
  const parts = [awayName, homeName].filter((s): s is string => Boolean(s));
  if (parts.length === 0) return "";
  // "<away> <home>" plus the literal "game" gets us recency-sorted
  // posts that are about the matchup specifically, not stray
  // mentions. We drop quotes so Bluesky's tokenizer treats the
  // names as separate query terms instead of a literal phrase.
  return `${parts.join(" ")} game`;
}

function preferredName(abbrev: string, meta?: TeamMeta): string {
  return meta?.shortName ?? meta?.displayName ?? abbrev;
}

function mergeAndShape(
  posts: BlueskyPost[],
  game: SportsGameState,
  beatReporters: Partial<Record<SportLeague, string[]>>
): EnrichmentSignal[] {
  const seen = new Set<string>();
  const candidates: Array<{ signal: EnrichmentSignal; weight: number }> = [];
  for (const post of posts) {
    if (!post.uri || !post.record?.text) continue;
    if (seen.has(post.uri)) continue;
    seen.add(post.uri);
    const text = post.record.text.trim();
    if (text.length < MIN_POST_LENGTH || text.length > MAX_POST_LENGTH) continue;
    if (looksLikeSpam(text)) continue;
    const likes = post.likeCount ?? 0;
    const reposts = post.repostCount ?? 0;
    const handle = (post.author?.handle ?? "").toLowerCase();
    const isBeatReporter = isReporterHandle(handle, game.sport, beatReporters);
    // Beat reporters skip the engagement gate — a fresh injury
    // tweet from Schefter is worth surfacing even with zero likes
    // because the tick race beats the like count.
    if (!isBeatReporter && likes < MIN_LIKES) continue;

    const occurredAt = post.record.createdAt ?? post.indexedAt ?? new Date().toISOString();
    const score = isBeatReporter
      ? Math.min(1, 0.7 + likes * 0.001) // floor 0.7 for reporters; small log lift from likes
      : Math.min(1, Math.log10(likes + 1) / 3 + reposts * 0.005);

    candidates.push({
      signal: {
        id: `bluesky-${stableHash(post.uri)}`,
        source: "bluesky",
        kind: isBeatReporter ? "news" : "reaction",
        text,
        score,
        occurredAt,
        refs: { teamId: detectTeamRef(text, game) }
      },
      weight: score
    });
  }
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates.slice(0, TOP_N).map((entry) => entry.signal);
}

function isReporterHandle(
  handle: string,
  sport: SportLeague,
  beatReporters: Partial<Record<SportLeague, string[]>>
): boolean {
  const list = beatReporters[sport] ?? [];
  return list.some((h) => h.toLowerCase() === handle);
}

function detectTeamRef(text: string, game: SportsGameState): string | undefined {
  const lower = text.toLowerCase();
  const candidates = [
    game.homeMeta?.shortName,
    game.homeMeta?.displayName,
    game.homeTeam,
    game.awayMeta?.shortName,
    game.awayMeta?.displayName,
    game.awayTeam
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length >= 3 && lower.includes(c.toLowerCase())) {
      return c;
    }
  }
  return undefined;
}

/** Drop posts that look like crypto/airdrop spam, automated boxscore
 *  feeds, or pure self-promo. Light filter — false positives are OK
 *  since the dedup pass + ranking will further cull. */
function looksLikeSpam(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("airdrop")) return true;
  if (lower.includes("free crypto")) return true;
  if (lower.startsWith("score update:") || lower.startsWith("boxscore:")) return true;
  // Only-emoji or only-link posts.
  const stripped = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, "");
  if (stripped.length < 10) return true;
  return false;
}

/** djb2-ish 32-bit hash → base36. Used for signal ids so a re-poll
 *  of the same post collapses cleanly in the aggregator's id-dedup
 *  pass. URI-based hash is stable across calls. */
function stableHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
