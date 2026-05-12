import React, { useEffect, useMemo, useState } from "react";
import type {
  ListenerPickSelection,
  PickEntry,
  PickProp,
  PickSlate
} from "../shared/picksContracts";
import { MAX_PICKS, MIN_PICKS, STAKE_PER_ENTRY } from "../shared/picksContracts";
import { payoutMultiplierFor } from "../shared/picksPayouts";
import {
  clearCachedSelections,
  fetchSlate,
  loadCachedSelections,
  saveCachedSelections,
  statIcon,
  statLabel,
  submitEntry
} from "./picksClient";

/**
 * Pregame slate selector. Lists 4-6 player props for the chosen game;
 * user taps "More" or "Less" on each, builds a 2-6-leg parlay, and
 * locks it via the submit button. The locked entry then streams in as
 * a tracker during the live show.
 *
 * Persists selections to localStorage so a reload mid-pick doesn't
 * lose state. Caches resolved slate too so re-mounts (phase swaps)
 * don't blink the picks list.
 */

type PicksCardProps = {
  gameId: string;
  listenerId: string;
  /** Existing entry, if the listener has already submitted picks for this game. */
  entry?: PickEntry;
  onEntrySubmitted: (entry: PickEntry) => void;
};

export function PicksCard({ gameId, listenerId, entry, onEntrySubmitted }: PicksCardProps) {
  const [slate, setSlate] = useState<PickSlate | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [selections, setSelections] = useState<ListenerPickSelection[]>(() =>
    loadCachedSelections(listenerId, gameId)
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    fetchSlate(gameId, ctrl.signal).then((next) => {
      if (ctrl.signal.aborted) return;
      setSlate(next);
      setLoading(false);
    });
    return () => ctrl.abort();
  }, [gameId]);

  // Reset the local selection state when the user navigates to a
  // different game — selections are scoped to (listenerId, gameId).
  useEffect(() => {
    setSelections(loadCachedSelections(listenerId, gameId));
  }, [gameId, listenerId]);

  useEffect(() => {
    saveCachedSelections(listenerId, gameId, selections);
  }, [selections, listenerId, gameId]);

  const selectedById = useMemo(() => new Map(selections.map((s) => [s.propId, s.side])), [selections]);
  const payoutPreview = useMemo(() => {
    const count = selections.length;
    if (count < MIN_PICKS) return undefined;
    const multiplier = payoutMultiplierFor(count);
    return { multiplier, payout: STAKE_PER_ENTRY * multiplier };
  }, [selections]);

  if (entry) {
    // Once submitted, this card collapses to a confirmation banner.
    // The live tracker takes over visualization.
    return <PicksLockedBanner entry={entry} />;
  }

  if (loading) {
    return (
      <article className="huddle-card picks-card picks-loading">
        <span className="eyebrow"><span className="icon icon-target" aria-hidden="true" />Your picks</span>
        <p className="picks-empty-line">Pulling tonight's player props...</p>
      </article>
    );
  }

  if (!slate || slate.props.length === 0) {
    return (
      <article className="huddle-card picks-card picks-empty">
        <span className="eyebrow"><span className="icon icon-target" aria-hidden="true" />Your picks</span>
        <p className="picks-empty-line">No props available for this game yet — check back closer to tipoff.</p>
      </article>
    );
  }

  function togglePick(prop: PickProp, side: "more" | "less") {
    setError(undefined);
    setSelections((current) => {
      const existing = current.find((s) => s.propId === prop.id);
      if (existing && existing.side === side) {
        return current.filter((s) => s.propId !== prop.id);
      }
      const without = current.filter((s) => s.propId !== prop.id);
      if (without.length >= MAX_PICKS) {
        setError(`Max ${MAX_PICKS} picks per parlay.`);
        return current;
      }
      return [...without, { propId: prop.id, side }];
    });
  }

  async function lockParlay() {
    if (!slate || selections.length < MIN_PICKS) return;
    setSubmitting(true);
    setError(undefined);
    const result = await submitEntry({
      listenerId,
      gameId,
      selections,
      availableProps: slate.props
    });
    setSubmitting(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    clearCachedSelections(listenerId, gameId);
    onEntrySubmitted(result);
  }

  return (
    <article className="huddle-card picks-card">
      <header className="picks-header">
        <span className="eyebrow"><span className="icon icon-target" aria-hidden="true" />Your picks</span>
        <span className="picks-count" data-active={selections.length >= MIN_PICKS}>
          {selections.length}/{MAX_PICKS}
        </span>
      </header>
      <p className="picks-subtitle">
        Tap More or Less. Hit at least {MIN_PICKS} to lock — all picks must clear to win.
      </p>
      <ul className="picks-list">
        {slate.props.map((prop) => {
          const side = selectedById.get(prop.id);
          return (
            <li key={prop.id} className="picks-row" data-picked={side ?? "no"}>
              <div className="picks-row-label">
                <span className={`icon ${statIcon(prop.statType)}`} aria-hidden="true" />
                <div className="picks-row-text">
                  <strong>{prop.playerName}</strong>
                  <small>
                    {prop.playerTeam ? `${prop.playerTeam} · ` : ""}
                    {prop.line.toFixed(prop.line % 1 === 0 ? 0 : 1)} {statLabel(prop.statType)}
                    {prop.source === "synthetic" && <span className="picks-synth-tag" title="No live market — line set from sport baseline">est</span>}
                  </small>
                </div>
              </div>
              <div className="picks-row-buttons">
                <button
                  type="button"
                  className={`picks-side-btn ${side === "more" ? "active" : ""}`}
                  data-side="more"
                  onClick={() => togglePick(prop, "more")}
                  aria-pressed={side === "more"}
                >
                  More
                </button>
                <button
                  type="button"
                  className={`picks-side-btn ${side === "less" ? "active" : ""}`}
                  data-side="less"
                  onClick={() => togglePick(prop, "less")}
                  aria-pressed={side === "less"}
                >
                  Less
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <footer className="picks-footer">
        <div className="picks-payout-preview">
          {payoutPreview ? (
            <>
              <span className="picks-payout-stake">${STAKE_PER_ENTRY}</span>
              <span className="picks-payout-arrow">→</span>
              <span className="picks-payout-amount">${payoutPreview.payout.toFixed(payoutPreview.payout % 1 === 0 ? 0 : 1)}</span>
              <span className="picks-payout-multiplier">{payoutPreview.multiplier}×</span>
            </>
          ) : (
            <span className="picks-payout-empty">Pick {MIN_PICKS - selections.length || MIN_PICKS} more to see payout</span>
          )}
        </div>
        <button
          type="button"
          className="primary picks-lock-btn"
          disabled={selections.length < MIN_PICKS || submitting}
          onClick={lockParlay}
        >
          {submitting ? "Locking..." : `Lock ${selections.length}-pick parlay`}
        </button>
      </footer>
      {error && <p className="picks-error" role="alert">{error}</p>}
      {slate.synthetic && (
        <p className="picks-synth-note">
          Some lines were estimated from sport baselines — real markets weren't available for this game.
        </p>
      )}
    </article>
  );
}

function PicksLockedBanner({ entry }: { entry: PickEntry }) {
  const multiplier = payoutMultiplierFor(entry.lockedProps.length);
  const projected = entry.stake * multiplier;
  return (
    <article className="huddle-card picks-card picks-locked">
      <header className="picks-header">
        <span className="eyebrow"><span className="icon icon-check" aria-hidden="true" />Picks locked</span>
        <span className="picks-locked-payout">{multiplier}× → ${projected}</span>
      </header>
      <ul className="picks-locked-list">
        {entry.lockedProps.map((prop) => {
          const side = entry.selections.find((s) => s.propId === prop.id)?.side ?? "more";
          return (
            <li key={prop.id} className="picks-locked-row" data-side={side}>
              <span className={`icon ${statIcon(prop.statType)}`} aria-hidden="true" />
              <div className="picks-locked-text">
                <strong>{prop.playerName}</strong>
                <small>{side === "more" ? "Over" : "Under"} {prop.line.toFixed(prop.line % 1 === 0 ? 0 : 1)} {statLabel(prop.statType)}</small>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="picks-locked-note">Live tracker appears once the game tips.</p>
    </article>
  );
}
