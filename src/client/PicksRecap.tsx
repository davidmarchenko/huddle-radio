import React, { useEffect, useState } from "react";
import type { EntryStatus, PickEntry } from "../shared/picksContracts";
import { settleEntry, statIcon, statLabel } from "./picksClient";

/**
 * Final recap card — visible in the recap phase and in any history
 * surface. Forces a settle on mount (so the entry has a payout) then
 * shows hit/miss per leg and the actual won/lost amount.
 */

type PicksRecapProps = {
  entry: PickEntry;
  listenerId: string;
};

export function PicksRecap({ entry, listenerId }: PicksRecapProps) {
  const [status, setStatus] = useState<EntryStatus | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    settleEntry(listenerId, entry.gameId).then((next) => {
      if (cancelled) return;
      setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, [entry.gameId, listenerId]);

  const won = (status?.payout ?? 0) > 0;
  const tone = won ? "win" : "loss";

  return (
    <article className={`huddle-card picks-recap-card recap-${tone}`}>
      <header className="picks-recap-header">
        <span className="eyebrow"><span className="icon icon-trophy" aria-hidden="true" />Picks recap</span>
        <span className={`picks-recap-result result-${tone}`}>
          {won ? "Won" : "Lost"} ${won ? (status?.payout ?? 0).toFixed((status?.payout ?? 0) % 1 === 0 ? 0 : 1) : entry.stake}
        </span>
      </header>
      <ul className="picks-recap-list">
        {entry.lockedProps.map((prop) => {
          const pick = status?.picks.find((p) => p.propId === prop.id);
          const side = entry.selections.find((s) => s.propId === prop.id)?.side ?? "more";
          const result = pick?.status ?? "pending";
          return (
            <li key={prop.id} className="picks-recap-row" data-status={result}>
              <span className={`icon ${statIcon(prop.statType)}`} aria-hidden="true" />
              <div className="picks-recap-row-text">
                <strong>{prop.playerName}</strong>
                <small>
                  {side === "more" ? "Over" : "Under"} {prop.line.toFixed(prop.line % 1 === 0 ? 0 : 1)} {statLabel(prop.statType)}
                  {pick?.currentValue !== undefined && (
                    <em className="picks-recap-final"> · finished {pick.currentValue}</em>
                  )}
                </small>
              </div>
              <ResultBadge status={result} />
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function ResultBadge({ status }: { status: string }) {
  switch (status) {
    case "hit":
      return <span className="picks-recap-badge badge-hit">✓</span>;
    case "miss":
      return <span className="picks-recap-badge badge-miss">✕</span>;
    case "push":
      return <span className="picks-recap-badge badge-push">=</span>;
    default:
      return <span className="picks-recap-badge badge-pending">—</span>;
  }
}
