import React, { useState } from "react";
import type { MarketHistoryPoint, MarketSnapshot } from "../shared/contracts";
import { HoverPopover } from "./HoverPopover";
import { MarketChart } from "./MarketChart";

/**
 * Market hovercard. Same shape as iMessage link previews but built
 * from structured market data instead of OG tags — we already know
 * everything (source, prices, move, volume), so a custom card reads
 * better than scraping the Kalshi/Polymarket page.
 *
 * Card content:
 *   - Brand bar: source logo + market kind chip (moneyline/spread/etc)
 *   - Full market title (no truncation, escapes the row clamp)
 *   - Outcome label
 *   - YES/NO price grid, color-tinted by side
 *   - 5-minute move with direction arrow
 *   - 24h volume when available
 *   - "View on Kalshi/Polymarket" CTA when we can construct the URL
 */

type MarketPreviewProps = {
  snapshot: MarketSnapshot;
  children: React.ReactNode;
  className?: string;
};

export function MarketPreview({ snapshot, children, className }: MarketPreviewProps) {
  const [history, setHistory] = useState<MarketHistoryPoint[] | undefined>(() =>
    historyCache.get(historyKey(snapshot))
  );
  const noPrice = 100 - snapshot.yesPriceCents;
  const delta = snapshot.recentDeltaCents ?? 0;
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  // Prefer the canonical URL the provider supplied — earlier we tried
  // to construct one from externalId and got a 404 because Polymarket
  // events use slugs, not condition IDs.
  const url = snapshot.marketUrl;
  const sourceLabel = snapshot.source === "kalshi" ? "Kalshi" : "Polymarket";
  const kindLabel = snapshot.marketKind.replace("-", " ");
  const observedRel = formatRelativeTime(snapshot.observedAt);
  const logoSrc =
    snapshot.source === "kalshi" ? "/icons/Logos/Kalshi_logo.svg.png" : "/icons/Logos/polymarket-logo.png";

  const card = (
    <div className="market-preview-card-body">
      <div className="market-preview-brand-bar" data-source={snapshot.source}>
        <img className="market-preview-brand-logo" src={logoSrc} alt={sourceLabel} />
        <span className="market-preview-kind">{kindLabel}</span>
      </div>
      <p className="market-preview-title">{snapshot.title}</p>
      <p className="market-preview-outcome">{snapshot.outcomeLabel}</p>
      {history && history.length >= 2 && (
        <MarketChart history={history} />
      )}
      <div className="market-preview-prices">
        <div className="market-preview-price-cell" data-side="yes">
          <small>YES</small>
          <strong>{snapshot.yesPriceCents}¢</strong>
        </div>
        <div className="market-preview-price-cell" data-side="no">
          <small>NO</small>
          <strong>{noPrice}¢</strong>
        </div>
      </div>
      <div className="market-preview-meta">
        {delta !== 0 && (
          <span className="market-preview-delta" data-direction={direction}>
            {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}¢ <em>5m</em>
          </span>
        )}
        {snapshot.volume24hUsd != null && (
          <span title="24-hour volume">${formatCompactNumber(snapshot.volume24hUsd)} vol</span>
        )}
        <span title={new Date(snapshot.observedAt).toLocaleString()}>updated {observedRel}</span>
      </div>
      {url && (
        <a
          className="market-preview-cta"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on {sourceLabel}
          <span className="icon icon-share-link" aria-hidden="true" />
        </a>
      )}
    </div>
  );

  return (
    <HoverPopover
      cardClassName="market-preview-card"
      className={className}
      content={card}
      onOpen={() => {
        const key = historyKey(snapshot);
        if (historyCache.has(key)) {
          setHistory(historyCache.get(key));
          return;
        }
        void fetchHistory(snapshot).then((points) => {
          historyCache.set(key, points);
          setHistory(points);
        });
      }}
    >
      {children}
    </HoverPopover>
  );
}

/**
 * Per-session cache of price history, keyed by source + identifier.
 * Browser-side only — the server endpoint also caches, but this saves
 * the network round trip on re-hovers in the same tab.
 */
const historyCache = new Map<string, MarketHistoryPoint[]>();
const historyInflight = new Map<string, Promise<MarketHistoryPoint[]>>();

function historyKey(snapshot: MarketSnapshot): string {
  const ident = snapshot.source === "polymarket" ? snapshot.clobTokenId ?? snapshot.externalId : snapshot.externalId;
  return `${snapshot.source}:${ident}`;
}

async function fetchHistory(snapshot: MarketSnapshot): Promise<MarketHistoryPoint[]> {
  const key = historyKey(snapshot);
  const inflight = historyInflight.get(key);
  if (inflight) return inflight;
  const params = new URLSearchParams({
    source: snapshot.source,
    externalId: snapshot.externalId,
    sport: snapshot.sport
  });
  if (snapshot.clobTokenId) params.set("clobTokenId", snapshot.clobTokenId);
  const promise = (async () => {
    try {
      const response = await fetch(`/api/markets/history?${params.toString()}`);
      if (!response.ok) return [];
      const payload = (await response.json()) as { history?: MarketHistoryPoint[] };
      return Array.isArray(payload.history) ? payload.history : [];
    } catch {
      return [];
    } finally {
      historyInflight.delete(key);
    }
  })();
  historyInflight.set(key, promise);
  return promise;
}

function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

// Local copy so this component doesn't depend on main.tsx's helper.
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const seconds = Math.round(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
