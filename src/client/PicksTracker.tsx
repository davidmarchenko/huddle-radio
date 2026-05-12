import React, { useEffect, useState } from "react";
import type { EntryStatus, PickEntry } from "../shared/picksContracts";
import { fetchEntryStatus, statLabel } from "./picksClient";
import { PlayerAvatar } from "./PicksCard";

/**
 * Live progress tracker for a locked entry. Polls /api/picks/status
 * every 15s during the show so per-pick progress stays current
 * without hammering ESPN.
 *
 * Renders a slim per-pick row with a progress bar and a status chip:
 *   - pending — game hasn't started, no live data
 *   - live-on-track — currently winning this leg
 *   - live-off-track — currently losing this leg
 *   - hit / miss / push — settled
 *
 * Above the picks: a "tracking $X" headline that turns gold when the
 * whole parlay is on-track and grey when at least one leg is off.
 */

type PicksTrackerProps = {
  entry: PickEntry;
  listenerId: string;
  /** When false, polling stops — used during recap so we don't keep hitting ESPN. */
  active?: boolean;
};

const POLL_INTERVAL_MS = 15_000;

export function PicksTracker({ entry, listenerId, active = true }: PicksTrackerProps) {
  const [status, setStatus] = useState<EntryStatus | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const next = await fetchEntryStatus(listenerId, entry.gameId);
      if (cancelled) return;
      if (next) {
        setStatus(next);
        setError(undefined);
      } else {
        setError("Couldn't refresh pick status.");
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [entry.gameId, listenerId, active]);

  const allOnTrack = status?.picks.every((p) => p.status === "hit" || p.status === "live-on-track") ?? false;

  return (
    <article className={`huddle-card picks-tracker-card ${allOnTrack ? "tracker-on-track" : "tracker-off-track"}`}>
      <header className="picks-tracker-header">
        <span className="eyebrow"><span className="icon icon-target" aria-hidden="true" />Your parlay</span>
        <PayoutHeadline status={status} stake={entry.stake} pickCount={entry.lockedProps.length} />
      </header>
      <ul className="picks-tracker-list">
        {entry.lockedProps.map((prop) => {
          const pick = status?.picks.find((p) => p.propId === prop.id);
          const side = entry.selections.find((s) => s.propId === prop.id)?.side ?? "more";
          const accent = prop.playerTeamColor ? `#${prop.playerTeamColor}` : undefined;
          return (
            <li
              key={prop.id}
              className="picks-tracker-row"
              data-status={pick?.status ?? "pending"}
              style={accent ? ({ "--pick-accent": accent } as React.CSSProperties) : undefined}
            >
              <div className="picks-tracker-row-label">
                <PlayerAvatar prop={prop} size="sm" />
                <div className="picks-tracker-row-text">
                  <strong>{prop.playerName}</strong>
                  <small>
                    {side === "more" ? "Over" : "Under"} {prop.line.toFixed(prop.line % 1 === 0 ? 0 : 1)} {statLabel(prop.statType)}
                  </small>
                </div>
              </div>
              <div className="picks-tracker-row-progress">
                <ProgressBar pick={pick} side={side} line={prop.line} />
                <PickStatusChip pick={pick} />
              </div>
            </li>
          );
        })}
      </ul>
      {status?.hostHint && (
        <p className="picks-tracker-host-hint" title="Surfaced to the hosts on the next turn">
          <span className="icon icon-megaphone-loud" aria-hidden="true" />
          {status.hostHint}
        </p>
      )}
      {error && <p className="picks-error" role="status">{error}</p>}
    </article>
  );
}

function PayoutHeadline({
  status,
  stake,
  pickCount
}: {
  status: EntryStatus | undefined;
  stake: number;
  pickCount: number;
}) {
  const projected = status?.payout ?? 0;
  const tone = projected > 0 ? "tracking" : "behind";
  return (
    <span className={`picks-tracker-payout payout-${tone}`}>
      <small>{projected > 0 ? "Tracking" : "If finals now"}</small>
      <strong>
        ${projected.toFixed(projected % 1 === 0 ? 0 : 1)}
        <em>from ${stake} · {pickCount} legs</em>
      </strong>
    </span>
  );
}

function ProgressBar({
  pick,
  side,
  line
}: {
  pick: { currentValue?: number; line: number; progress: number; status: string } | undefined;
  side: "more" | "less";
  line: number;
}) {
  if (!pick || pick.currentValue === undefined) {
    return <div className="picks-progress-bar progress-empty"><div className="picks-progress-fill" style={{ width: "0%" }} /></div>;
  }
  const fillPct = Math.max(0, Math.min(100, (pick.progress / 1.5) * 100));
  // The "line" mark sits at line / 1.5x cap.
  const linePct = Math.max(0, Math.min(100, (1 / 1.5) * 100));
  return (
    <div className="picks-progress-bar" data-side={side}>
      <div className="picks-progress-fill" style={{ width: `${fillPct}%` }} />
      <div className="picks-progress-line" style={{ left: `${linePct}%` }} title={`Line: ${line}`} />
      <span className="picks-progress-value">{pick.currentValue}</span>
    </div>
  );
}

function PickStatusChip({
  pick
}: {
  pick: { status: string } | undefined;
}) {
  if (!pick) return <span className="picks-chip chip-pending">queued</span>;
  switch (pick.status) {
    case "hit":
      return <span className="picks-chip chip-hit">HIT</span>;
    case "miss":
      return <span className="picks-chip chip-miss">MISS</span>;
    case "push":
      return <span className="picks-chip chip-push">PUSH</span>;
    case "live-on-track":
      return <span className="picks-chip chip-on-track">on track</span>;
    case "live-off-track":
      return <span className="picks-chip chip-off-track">behind</span>;
    case "pending":
    default:
      return <span className="picks-chip chip-pending">pending</span>;
  }
}
