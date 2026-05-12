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
  const sportMatches = snapshots.filter((snapshot) => snapshot.sport === game.sport);

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
