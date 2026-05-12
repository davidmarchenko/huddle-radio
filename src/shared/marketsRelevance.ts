import type { MarketSnapshot, SportLeague, TeamMeta } from "./contracts";

/**
 * Pure ranking helper for prediction-market snapshots, shared by the
 * server-side commentary engine and the W19 client ticker. Lives in
 * `shared/` so the client doesn't accidentally pull in the server-only
 * Kalshi / Polymarket fetchers.
 *
 * Heuristic: prefer markets that mention either of the game's teams
 * or any of the listener's players, then weight by market kind
 * (moneyline > player-prop > spread > total > futures > other) and
 * tiebreak on volume.
 *
 * Match strategy:
 *   - Caller passes `teamIdentifiers` — full team names, short names,
 *     city, and abbreviations. We word-boundary match the long ones,
 *     and only literal-include the short ones (avoids false positives
 *     like "lad" matching inside "Vladimir" or "salad").
 *   - When NO market in the sport mentions any team/player at all,
 *     fall back to general league markets ranked by kind+volume so the
 *     ticker / board never disappears entirely on a quiet news day.
 *     Better to show "Will the Phillies win the World Series?" than to
 *     hide the section completely on a Dodgers game.
 */
export function pickRelevantMarketsForGame(
  snapshots: MarketSnapshot[],
  game: {
    sport: SportLeague;
    /**
     * Mix of team identifiers — abbreviations, short names, full
     * display names. The function picks the appropriate match strategy
     * per identifier (word-boundary for short tokens to avoid
     * substring false positives, plain include for long ones).
     */
    teams: string[];
    players?: string[];
  },
  limit = 3
): MarketSnapshot[] {
  const sportMatches = collapseBinaryDuplicates(
    snapshots.filter((snapshot) => snapshot.sport === game.sport)
  );

  const teamMatchers = buildMatchers(game.teams);
  const playerMatchers = buildMatchers(game.players ?? []);

  const matched: Array<{ snapshot: MarketSnapshot; score: number }> = [];
  const general: Array<{ snapshot: MarketSnapshot; score: number }> = [];

  for (const snapshot of sportMatches) {
    const haystack = `${snapshot.title} ${snapshot.outcomeLabel}`.toLowerCase();
    const teamHit = teamMatchers.some((matcher) => matcher.test(haystack));
    const playerHit = playerMatchers.some((matcher) => matcher.test(haystack));
    const kindWeight = ({
      moneyline: 5,
      "player-prop": 4,
      spread: 3,
      total: 2,
      futures: 1,
      other: 0
    } satisfies Record<MarketSnapshot["marketKind"], number>)[snapshot.marketKind];
    const volumeScore = Math.log10(1 + (snapshot.volume24hUsd ?? 0));
    const baseScore = kindWeight + volumeScore;
    if (teamHit || playerHit) {
      matched.push({ snapshot, score: baseScore + (playerHit ? 2 : 0) });
    } else {
      general.push({ snapshot, score: baseScore });
    }
  }

  matched.sort((a, b) => b.score - a.score);
  if (matched.length > 0) {
    return matched.slice(0, limit).map((entry) => entry.snapshot);
  }

  // Fallback: no team-tagged markets matched. Surface the most
  // important general league markets instead of returning [] (which
  // would hide the section entirely). Listeners on a quiet game still
  // see real markets and can click into them.
  general.sort((a, b) => b.score - a.score);
  return general.slice(0, limit).map((entry) => entry.snapshot);
}

/**
 * Build a list of test functions from team / player identifiers.
 * Long identifiers (>3 chars) match anywhere as a substring; short
 * identifiers (≤3 chars, e.g. "SF", "LAD", "KC") match only on word
 * boundaries so "lad" doesn't false-match inside "Vladimir" / "salad".
 */
function buildMatchers(identifiers: string[]): Array<{ test: (haystack: string) => boolean }> {
  return identifiers
    .map((id) => id?.trim())
    .filter((id): id is string => Boolean(id))
    .map((id) => {
      const needle = id.toLowerCase();
      if (needle.length <= 3) {
        const re = new RegExp(`\\b${escapeRegex(needle)}\\b`, "i");
        return { test: (haystack: string) => re.test(haystack) };
      }
      return { test: (haystack: string) => haystack.includes(needle) };
    });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collapse Yes/No (or Team-A/Team-B) inverse-pair snapshots into a
 * single representative. Both Polymarket and Kalshi emit binary
 * markets as TWO snapshots:
 *
 *   - Polymarket: same conditionId, outcomes "Yes" + "No", externalIds
 *     differ by a `:0` / `:1` suffix
 *   - Kalshi: separate tickers (PHI_VS_BOS_PHI, PHI_VS_BOS_BOS), same
 *     event title, outcomeLabels are the team / outcome names
 *
 * Both shapes share the SAME title, and the two snapshots' YES prices
 * sum to ~100¢ (with a small spread for vig). When we detect that
 * pattern we keep only the favored side — higher yesPriceCents — so
 * the listener sees one row per market instead of mirrored duplicates.
 *
 * Genuinely multi-outcome markets (futures with 30 different team
 * questions, each its own title) aren't affected: each title is its
 * own group of one.
 */
export function collapseBinaryDuplicates(snapshots: MarketSnapshot[]): MarketSnapshot[] {
  const byTitle = new Map<string, MarketSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.source}:${snapshot.title.trim().toLowerCase()}`;
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(snapshot);
    else byTitle.set(key, [snapshot]);
  }
  const out: MarketSnapshot[] = [];
  for (const bucket of byTitle.values()) {
    if (bucket.length === 2) {
      const [a, b] = bucket;
      const sum = a.yesPriceCents + b.yesPriceCents;
      // Allow a generous 10¢ window for the vig — real binary pairs
      // typically sum to 95-105¢ depending on the platform's fee.
      if (sum >= 90 && sum <= 110) {
        out.push(a.yesPriceCents >= b.yesPriceCents ? a : b);
        continue;
      }
    }
    // Multi-outcome OR title collision OR pair that doesn't add up
    // to ~100¢ — keep all so we don't accidentally drop information.
    out.push(...bucket);
  }
  return out;
}

/**
 * Convenience: extract the richest set of team identifiers from a
 * SportsGameState's TeamMeta. Callers can pass the result straight to
 * pickRelevantMarketsForGame's `teams` field. Falls back to just the
 * abbreviation when meta is missing.
 */
export function teamIdentifiersFromMeta(
  abbreviation: string,
  meta?: TeamMeta
): string[] {
  const ids = new Set<string>();
  if (abbreviation) ids.add(abbreviation);
  if (meta?.abbreviation) ids.add(meta.abbreviation);
  if (meta?.shortName) ids.add(meta.shortName);
  if (meta?.displayName) {
    ids.add(meta.displayName);
    // Many display names are "City Mascot" — split so each half can
    // match independently ("Giants" or "San Francisco").
    const parts = meta.displayName.split(/\s+/);
    if (parts.length >= 2) {
      ids.add(parts.slice(0, -1).join(" "));
      ids.add(parts[parts.length - 1]);
    }
  }
  return Array.from(ids);
}
