import React, { useMemo } from "react";
import type { MarketHistoryPoint } from "../shared/contracts";

/**
 * Tiny inline SVG sparkline of YES-side price over the last 24h.
 * Used inside the rich market preview card.
 *
 *   - Y axis: 0..100¢, but we crop to the actual data range with a
 *     small buffer so a market trading 45-55¢ doesn't draw a near-flat
 *     line on a 0-100 axis. Min/max labels are shown to keep the
 *     scale honest.
 *   - X axis: linear time, evenly spaced points (no gap weighting —
 *     fidelity is uniform from the upstreams we use).
 *   - Colors: trend-aware. Up move = success green, down = danger,
 *     flat = muted. The fill below the line is the same hue at low
 *     opacity so the trend reads at a glance.
 *
 * Renders nothing when fewer than 2 points exist (a single point
 * isn't a line).
 */

type MarketSparklineProps = {
  history: MarketHistoryPoint[];
  /** Visible width in CSS px. SVG viewBox uses the same coordinate
   *  system; height defaults to 56. */
  width?: number;
  height?: number;
};

export function MarketSparkline({ history, width = 280, height = 56 }: MarketSparklineProps) {
  const view = useMemo(() => buildSparkline(history, width, height), [history, width, height]);
  if (!view) return null;
  const { points, areaPath, linePath, trend, minY, maxY, lastY } = view;
  const trendClass = `market-sparkline market-sparkline-${trend}`;
  return (
    <div className={trendClass}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path className="market-sparkline-area" d={areaPath} />
        <path className="market-sparkline-line" d={linePath} />
        {/* Last-point marker so the user can see "we're here" at the
            end of the line. */}
        <circle
          className="market-sparkline-dot"
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r={2.5}
        />
      </svg>
      <div className="market-sparkline-labels" data-trend={trend}>
        <span title={`24h low: ${minY}¢`}>{minY}¢</span>
        <span className="market-sparkline-spread">24h range</span>
        <span title={`24h high: ${maxY}¢`}>{maxY}¢</span>
      </div>
      <span className="market-sparkline-last">last {lastY}¢</span>
    </div>
  );
}

function buildSparkline(history: MarketHistoryPoint[], width: number, height: number) {
  if (history.length < 2) return null;
  const prices = history.map((p) => p.priceCents);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  // Buffer so a flat market still has visual height; clamped to 0..100.
  const bufferCents = Math.max(2, Math.round((maxPrice - minPrice) * 0.15));
  const lo = Math.max(0, minPrice - bufferCents);
  const hi = Math.min(100, maxPrice + bufferCents);
  const range = Math.max(1, hi - lo);
  const padX = 2;
  const padY = 2;
  const usableW = width - padX * 2;
  const usableH = height - padY * 2;

  const points = prices.map((price, idx) => {
    const x = padX + (idx / (prices.length - 1)) * usableW;
    // Invert Y: higher price → smaller y in SVG coords.
    const y = padY + (1 - (price - lo) / range) * usableH;
    return { x, y };
  });

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
  const areaPath =
    `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${(height - padY).toFixed(1)}` +
    ` L ${points[0].x.toFixed(1)} ${(height - padY).toFixed(1)} Z`;

  const first = prices[0];
  const last = prices[prices.length - 1];
  const trend: "up" | "down" | "flat" = last - first > 1 ? "up" : last - first < -1 ? "down" : "flat";

  return {
    points,
    linePath,
    areaPath,
    trend,
    minY: minPrice,
    maxY: maxPrice,
    lastY: last
  };
}
