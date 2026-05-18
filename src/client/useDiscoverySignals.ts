/**
 * Discovery-feed signals hook. Calls /api/discovery/signals with the
 * visible slate and returns a Map<gameId, DiscoverySignal[]> the
 * `GameCard` reads to render chips.
 *
 * Behaviour notes:
 *   - Debounced. Filter changes on the discovery feed shouldn't fire
 *     a network round-trip per keystroke.
 *   - Cached across the lifetime of the App component. When the
 *     listener filters down to a single sport then back to "all",
 *     chips re-appear instantly from the cache.
 *   - Auto-refresh on a long interval. The discovery feed sits open
 *     for minutes while a listener browses; markets move under it.
 *     30s feels live without being noisy.
 *   - Soft-fail. If the endpoint errors or returns nothing, the hook
 *     surfaces an empty map and the cards render as before.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SportsGameOption, SportsGameState } from "../shared/contracts";
import type { DiscoverySignal } from "../server/discoverySignals";

const REFRESH_INTERVAL_MS = 30_000;
const DEBOUNCE_MS = 200;

export function useDiscoverySignals(
  games: SportsGameOption[],
  listenerStarterPlayerIds?: string[]
): Map<string, DiscoverySignal[]> {
  // Server returns one entry per game id. We keep the full union of
  // ever-seen game ids cached so that a filter-change doesn't blink
  // chips off — they simply remain from the last fetch that covered
  // their game.
  const [signalsByGameId, setSignalsByGameId] = useState<Map<string, DiscoverySignal[]>>(
    () => new Map()
  );
  const inFlightRef = useRef<AbortController | undefined>(undefined);
  const [refreshTick, setRefreshTick] = useState(0);

  // Snapshot the inputs that should trigger a refetch when they
  // CHANGE. Stable across renders when the same array of ids is
  // passed because we hash to a sorted string.
  const gameIdsKey = useMemo(() => games.map((g) => g.id).sort().join(","), [games]);
  const playerIdsKey = useMemo(
    () => (listenerStarterPlayerIds ?? []).slice().sort().join(","),
    [listenerStarterPlayerIds]
  );

  useEffect(() => {
    if (games.length === 0) return;
    let cancelled = false;
    const debounce = window.setTimeout(() => {
      // Abort any in-flight request so a rapid filter change doesn't
      // leak stale chips on top of fresh ones.
      inFlightRef.current?.abort();
      const controller = new AbortController();
      inFlightRef.current = controller;
      fetch("/api/discovery/signals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          games: games.map((g) => ({
            id: g.id,
            sport: g.sport,
            awayTeam: g.awayTeam,
            homeTeam: g.homeTeam,
            awayMeta: g.awayMeta,
            homeMeta: g.homeMeta,
            status: g.status,
            broadcast: g.broadcast,
            // Server doesn't need score/detail/label — keep payload small.
            score: { away: 0, home: 0 },
            shortName: g.shortName,
            label: g.label,
            detail: g.detail
          })),
          listenerStarterPlayerIds
        }),
        signal: controller.signal
      })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`signals ${response.status}`))))
        .then((payload: { signals?: Record<string, DiscoverySignal[]> }) => {
          if (cancelled) return;
          const incoming = payload.signals ?? {};
          setSignalsByGameId((prev) => {
            // Merge incoming into the cache: replace entries for
            // games the server responded to, drop nothing. The
            // server returns an entry per game with >=1 signal —
            // games with no signals are absent, but we still want to
            // CLEAR their chips in case a previous fetch had them.
            const next = new Map(prev);
            for (const gameId of Object.keys(incoming)) {
              next.set(gameId, incoming[gameId]);
            }
            // Clear chips for games in the current slate that didn't
            // come back with signals — otherwise stale chips persist
            // after a market cools off.
            for (const game of games) {
              if (!(game.id in incoming)) next.delete(game.id);
            }
            return next;
          });
        })
        .catch((error) => {
          // AbortError on filter change is expected; ignore quietly.
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (cancelled) return;
          // Other errors: leave the cache untouched, just log.
          console.warn("discovery signals fetch failed", error);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(debounce);
    };
    // We intentionally key the effect on the stable hashes so a
    // re-rendered parent that passes a new-array-same-contents
    // doesn't refetch. games is included for the merge step inside
    // the effect (closure captures the freshest value).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameIdsKey, playerIdsKey, refreshTick]);

  // Periodic background refresh — markets move under a long-open
  // discovery feed; refresh keeps chips live without making the
  // feed feel twitchy.
  useEffect(() => {
    if (games.length === 0) return;
    const id = window.setInterval(() => setRefreshTick((n) => n + 1), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [gameIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return signalsByGameId;
}

/**
 * Single-game variant for the live show views. Builds the minimal
 * SportsGameOption-shaped payload the endpoint expects from a
 * SportsGameState (which is what the live UI holds in state) and
 * returns just THIS game's chips. Refreshes on the same cadence as
 * the discovery hook — fast enough to catch a market move during a
 * live show, slow enough not to thrash.
 */
export function useGameSignals(
  game: SportsGameState | undefined,
  listenerStarterPlayerIds?: string[]
): DiscoverySignal[] {
  // Project the live game into the option shape the discovery hook
  // already speaks. Wrap in a one-element array so we can reuse the
  // same hook + endpoint without inventing a second pipeline.
  const games = useMemo<SportsGameOption[]>(() => {
    if (!game) return [];
    return [
      {
        id: game.gameId,
        label: `${game.awayTeam} at ${game.homeTeam}`,
        shortName: `${game.awayTeam} @ ${game.homeTeam}`,
        sport: game.sport,
        awayTeam: game.awayTeam,
        homeTeam: game.homeTeam,
        awayMeta: game.awayMeta,
        homeMeta: game.homeMeta,
        score: { away: game.currentPlay?.score.away ?? 0, home: game.currentPlay?.score.home ?? 0 },
        status: game.status,
        detail: ""
      }
    ];
  }, [game]);
  const signals = useDiscoverySignals(games, listenerStarterPlayerIds);
  if (!game) return [];
  return signals.get(game.gameId) ?? [];
}
