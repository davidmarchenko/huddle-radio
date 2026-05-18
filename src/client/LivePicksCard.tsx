import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LivePickEntry,
  LivePickProp,
  LivePickSide
} from "../shared/livePicksContracts";
import { fetchActiveLivePicks, lockLivePick } from "./livePicksClient";

/**
 * In-show snap pick panel — sits in the live rail alongside
 * PicksTracker. Polls `/api/picks/live/active` every ~15s, shows
 * 1-3 active props with a live countdown, lets the listener lock
 * a single-leg pick with one tap.
 *
 * Locked picks float to the top with their side highlighted and a
 * countdown to resolution. Resolved picks linger for a couple of
 * polls so the listener sees the hit/miss confirmation before they
 * scroll off.
 */

type LivePicksCardProps = {
  gameId: string;
  listenerId: string;
  /** Hidden when the show isn't actually live — the panel only makes
   *  sense once the engine is generating props. */
  isLive: boolean;
};

const POLL_INTERVAL_MS = 15_000;

export function LivePicksCard({ gameId, listenerId, isLive }: LivePicksCardProps) {
  const [active, setActive] = useState<LivePickProp[]>([]);
  const [entries, setEntries] = useState<LivePickEntry[]>([]);
  const [pendingLocks, setPendingLocks] = useState<Set<string>>(new Set());
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  // Live countdown — re-renders every second so the badge ticks
  // smoothly. Local clock; resolution itself is server-driven so
  // a slow client clock just makes the countdown imprecise, not
  // incorrect.
  const [tickNow, setTickNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return;
    const t = window.setInterval(() => setTickNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [isLive]);

  // Poll for active props + entries. The active endpoint also runs
  // the server-side resolver on each call so a poll doubles as a
  // resolution tick.
  const inflight = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    const result = await fetchActiveLivePicks({ gameId, listenerId, signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    setActive(result.active);
    setEntries(result.entries);
  }, [gameId, listenerId]);

  // Hard-reset visible state whenever the gameId changes so a
  // pivot (slate auto-switch, discovery → new game) never shows
  // game-A entries against game-B's matchup while the next poll is
  // in flight.
  useEffect(() => {
    setActive([]);
    setEntries([]);
    setErrorMessage(undefined);
  }, [gameId]);

  useEffect(() => {
    if (!isLive) return;
    void refresh();
    const t = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(t);
      inflight.current?.abort();
    };
  }, [isLive, refresh]);

  const entryByPropId = useMemo(() => {
    const map = new Map<string, LivePickEntry>();
    for (const entry of entries) map.set(entry.propId, entry);
    return map;
  }, [entries]);

  // Rows the panel renders. Build a unified list: locked entries
  // first (open then recently resolved), then any active props that
  // haven't been locked yet. Sort within each bucket by deadline.
  const rows = useMemo(() => buildPanelRows({ active, entries }), [active, entries]);

  const handleLock = useCallback(
    async (prop: LivePickProp, side: LivePickSide) => {
      if (pendingLocks.has(prop.id)) return;
      setPendingLocks((current) => new Set(current).add(prop.id));
      setErrorMessage(undefined);
      const result = await lockLivePick({
        listenerId,
        gameId,
        propId: prop.id,
        side
      });
      setPendingLocks((current) => {
        const next = new Set(current);
        next.delete(prop.id);
        return next;
      });
      if ("error" in result) {
        setErrorMessage(result.error);
        return;
      }
      // Optimistic: drop the entry into local state immediately so
      // the row flips to its locked state without waiting on the
      // next poll.
      setEntries((current) => {
        const without = current.filter((entry) => entry.propId !== result.entry.propId);
        return [result.entry, ...without];
      });
    },
    [gameId, listenerId, pendingLocks]
  );

  if (!isLive) return null;

  if (rows.length === 0) {
    return (
      <article className="huddle-card live-picks-card live-picks-empty">
        <span className="eyebrow">
          <span className="icon icon-target" aria-hidden="true" />Live picks
        </span>
        <p className="live-picks-empty-line">
          Waiting for the next snap window — the model generates a fresh prop every couple of minutes.
        </p>
      </article>
    );
  }

  return (
    <article className="huddle-card live-picks-card">
      <header className="live-picks-header">
        <span className="eyebrow">
          <span className="icon icon-target" aria-hidden="true" />Live picks
        </span>
        <span className="live-picks-tag" title="In-show single-leg snap picks">snap</span>
      </header>
      <ul className="live-picks-list">
        {rows.map((row) => (
          <LivePickRow
            key={row.prop.id}
            prop={row.prop}
            entry={row.entry}
            tickNow={tickNow}
            locking={pendingLocks.has(row.prop.id)}
            onLock={handleLock}
          />
        ))}
      </ul>
      {errorMessage && (
        <p className="live-picks-error" role="alert">{errorMessage}</p>
      )}
    </article>
  );
}

type PanelRow = {
  prop: LivePickProp;
  entry?: LivePickEntry;
};

function buildPanelRows(input: { active: LivePickProp[]; entries: LivePickEntry[] }): PanelRow[] {
  const { active, entries } = input;
  // 1. Locked open — closest expiry first
  // 2. Recently resolved — newest resolution first
  // 3. Unlocked active — closest expiry first
  const openLocked: PanelRow[] = [];
  const resolvedLocked: PanelRow[] = [];
  for (const entry of entries) {
    if (entry.status === "open") {
      openLocked.push({ prop: entry.prop, entry });
    } else {
      resolvedLocked.push({ prop: entry.prop, entry });
    }
  }
  openLocked.sort((a, b) => a.prop.expiresAt.localeCompare(b.prop.expiresAt));
  resolvedLocked.sort((a, b) => (b.entry?.resolvedAt ?? "").localeCompare(a.entry?.resolvedAt ?? ""));

  const lockedIds = new Set([...openLocked, ...resolvedLocked].map((row) => row.prop.id));
  const unlocked: PanelRow[] = active
    .filter((prop) => !lockedIds.has(prop.id))
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
    .map((prop) => ({ prop }));

  // Cap recently-resolved so the panel doesn't grow indefinitely
  // — the engine has its own ring buffer for the host hint.
  return [...openLocked, ...resolvedLocked.slice(0, 2), ...unlocked];
}

function LivePickRow({
  prop,
  entry,
  tickNow,
  locking,
  onLock
}: {
  prop: LivePickProp;
  entry?: LivePickEntry;
  tickNow: number;
  locking: boolean;
  onLock: (prop: LivePickProp, side: LivePickSide) => void;
}) {
  const status = entry?.status ?? "open";
  const expiresMs = new Date(prop.expiresAt).getTime();
  const secondsLeft = Math.max(0, Math.ceil((expiresMs - tickNow) / 1000));
  const closed = secondsLeft <= 0;

  return (
    <li className="live-picks-row" data-status={status} data-side={entry?.side ?? "none"}>
      <div className="live-picks-row-head">
        <strong className="live-picks-row-title">{prop.title}</strong>
        {prop.subtitle && <small className="live-picks-row-subtitle">{prop.subtitle}</small>}
      </div>
      <div className="live-picks-row-foot">
        {entry ? (
          <LockedEntryFoot entry={entry} secondsLeft={secondsLeft} />
        ) : (
          <UnlockedRowButtons
            prop={prop}
            disabled={closed || locking}
            locking={locking}
            onLock={onLock}
            secondsLeft={secondsLeft}
          />
        )}
      </div>
    </li>
  );
}

function UnlockedRowButtons({
  prop,
  disabled,
  locking,
  onLock,
  secondsLeft
}: {
  prop: LivePickProp;
  disabled: boolean;
  locking: boolean;
  onLock: (prop: LivePickProp, side: LivePickSide) => void;
  secondsLeft: number;
}) {
  return (
    <>
      <div className="live-picks-buttons">
        <button
          type="button"
          className="live-picks-side-btn"
          data-side="more"
          disabled={disabled}
          onClick={() => onLock(prop, "more")}
        >
          {locking ? "…" : "More"}
        </button>
        <button
          type="button"
          className="live-picks-side-btn"
          data-side="less"
          disabled={disabled}
          onClick={() => onLock(prop, "less")}
        >
          {locking ? "…" : "Less"}
        </button>
      </div>
      <span className="live-picks-countdown" data-warning={secondsLeft <= 15 ? "true" : "false"}>
        {secondsLeft > 0 ? `${formatCountdown(secondsLeft)} left` : "closed"}
      </span>
    </>
  );
}

function LockedEntryFoot({ entry, secondsLeft }: { entry: LivePickEntry; secondsLeft: number }) {
  if (entry.status === "open") {
    return (
      <>
        <span className="live-picks-side-pill" data-side={entry.side}>
          Locked: {entry.side === "more" ? "More" : "Less"}
        </span>
        <span className="live-picks-countdown" data-warning={secondsLeft <= 15 ? "true" : "false"}>
          {secondsLeft > 0 ? `${formatCountdown(secondsLeft)} left` : "resolving"}
        </span>
      </>
    );
  }
  if (entry.status === "hit") {
    return (
      <>
        <span className="live-picks-side-pill" data-result="hit">
          Hit · +${(entry.payout ?? 0).toFixed(0)}
        </span>
        {entry.resolutionNote && (
          <small className="live-picks-resolution-note">{entry.resolutionNote}</small>
        )}
      </>
    );
  }
  if (entry.status === "miss") {
    return (
      <>
        <span className="live-picks-side-pill" data-result="miss">Miss</span>
        {entry.resolutionNote && (
          <small className="live-picks-resolution-note">{entry.resolutionNote}</small>
        )}
      </>
    );
  }
  return <span className="live-picks-side-pill" data-result="void">Void</span>;
}

function formatCountdown(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem.toString().padStart(2, "0")}s`;
}
