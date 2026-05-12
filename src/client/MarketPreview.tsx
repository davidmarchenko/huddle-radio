import React from "react";
import type { MarketSnapshot } from "../shared/contracts";
import { HoverPopover } from "./HoverPopover";

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
  const noPrice = 100 - snapshot.yesPriceCents;
  const delta = snapshot.recentDeltaCents ?? 0;
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const url = marketSourceUrl(snapshot);
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
    <HoverPopover cardClassName="market-preview-card" className={className} content={card}>
      {children}
    </HoverPopover>
  );
}

function marketSourceUrl(snapshot: MarketSnapshot): string | undefined {
  if (snapshot.source === "kalshi") {
    return `https://kalshi.com/markets/${snapshot.externalId.toLowerCase()}`;
  }
  if (snapshot.source === "polymarket") {
    return `https://polymarket.com/event/${snapshot.externalId}`;
  }
  return undefined;
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
