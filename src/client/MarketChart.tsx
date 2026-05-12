import React, { useMemo, useRef, useState } from "react";
import type { MarketHistoryPoint } from "../shared/contracts";

/**
 * Two-line interactive chart for the rich market preview. The single
 * fetched series (YES-side over time) drives both lines:
 *
 *   - YES (success-tinted) — the favored side, rendered solid
 *   - NO  (danger-tinted)  — derived as 100 - YES, rendered as a
 *     dimmer mirror so the user can read the implied opposite side
 *     without a second network call
 *
 * Interactive: hover anywhere on the chart → vertical crosshair snaps
 * to the nearest data point, dots appear at both line intersections,
 * and a tooltip shows the timestamp + both prices. Mouse leave clears.
 *
 * Y axis: fixed 0-100¢ with faint grid lines at 25/50/75 so the
 * eye can read prices without crosshair help. Time axis: relative
 * labels at start / midpoint / end (24h ago, 12h ago, now).
 *
 * Renders nothing for <2 history points (no chart from one sample).
 */

type MarketChartProps = {
  history: MarketHistoryPoint[];
  width?: number;
  height?: number;
};

const PAD_L = 4;
const PAD_R = 4;
const PAD_T = 6;
const PAD_B = 18; // room for time-axis labels at the bottom

export function MarketChart({ history, width = 288, height = 132 }: MarketChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const view = useMemo(() => buildChart(history, width, height), [history, width, height]);

  if (!view) return null;
  const { yesPoints, noPoints, yesPath, noPath, gridYs, timeLabels } = view;

  const hovered = hoverIdx != null ? history[hoverIdx] : undefined;
  const hoveredYes = hovered?.priceCents;
  const hoveredNo = hoveredYes != null ? 100 - hoveredYes : undefined;
  const hoveredX = hoverIdx != null ? yesPoints[hoverIdx]?.x : undefined;

  function handleMove(event: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    // Map screen X to SVG coords. SVG width is `width`, rect width
    // varies with viewport, so scale.
    const localX = ((event.clientX - rect.left) / rect.width) * width;
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < yesPoints.length; i++) {
      const d = Math.abs(yesPoints[i].x - localX);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    setHoverIdx(bestIdx);
  }

  return (
    <div className="market-chart" ref={containerRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        preserveAspectRatio="none"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        aria-hidden="true"
      >
        {gridYs.map((g) => (
          <line
            key={`grid-${g.label}`}
            className="market-chart-grid"
            x1={PAD_L}
            x2={width - PAD_R}
            y1={g.y}
            y2={g.y}
          />
        ))}

        {/* NO line first so YES paints on top (favored side dominant). */}
        <path className="market-chart-line market-chart-line-no" d={noPath} />
        <path className="market-chart-line market-chart-line-yes" d={yesPath} />

        {hoverIdx != null && hoveredX != null && (
          <>
            <line
              className="market-chart-crosshair"
              x1={hoveredX}
              x2={hoveredX}
              y1={PAD_T}
              y2={height - PAD_B}
            />
            <circle
              className="market-chart-dot market-chart-dot-yes"
              cx={hoveredX}
              cy={yesPoints[hoverIdx].y}
              r={3}
            />
            <circle
              className="market-chart-dot market-chart-dot-no"
              cx={hoveredX}
              cy={noPoints[hoverIdx].y}
              r={3}
            />
          </>
        )}

        {timeLabels.map((label) => (
          <text
            key={`time-${label.x}`}
            className="market-chart-time-label"
            x={label.x}
            y={height - 4}
            textAnchor={label.anchor}
          >
            {label.text}
          </text>
        ))}
      </svg>

      {hovered && (
        <div
          className="market-chart-tooltip"
          style={{ left: `${(hoveredX! / width) * 100}%` }}
          role="status"
        >
          <div className="market-chart-tooltip-time">{formatHover(hovered.ts)}</div>
          <div className="market-chart-tooltip-prices">
            <span data-side="yes">YES {hoveredYes}¢</span>
            <span data-side="no">NO {hoveredNo}¢</span>
          </div>
        </div>
      )}
    </div>
  );
}

function buildChart(history: MarketHistoryPoint[], width: number, height: number) {
  if (history.length < 2) return null;

  const usableW = width - PAD_L - PAD_R;
  const usableH = height - PAD_T - PAD_B;
  // Fixed 0-100 axis so YES and NO line up symmetrically across the
  // 50¢ midline and the user reads absolute price levels at a glance.
  const yFromCents = (cents: number) => PAD_T + (1 - cents / 100) * usableH;

  const yesPoints = history.map((point, idx) => ({
    x: PAD_L + (idx / (history.length - 1)) * usableW,
    y: yFromCents(point.priceCents)
  }));
  const noPoints = history.map((point, idx) => ({
    x: yesPoints[idx].x,
    y: yFromCents(100 - point.priceCents)
  }));

  const toPath = (points: Array<{ x: number; y: number }>) =>
    points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(" ");

  const gridYs = [25, 50, 75].map((label) => ({ label, y: yFromCents(label) }));

  const lastTs = new Date(history[history.length - 1].ts).getTime();
  const firstTs = new Date(history[0].ts).getTime();
  const midTs = firstTs + (lastTs - firstTs) / 2;
  const timeLabels = [
    { x: PAD_L, text: relativeAge(firstTs, lastTs), anchor: "start" as const },
    { x: width / 2, text: relativeAge(midTs, lastTs), anchor: "middle" as const },
    { x: width - PAD_R, text: "now", anchor: "end" as const }
  ];

  const yesPath = toPath(yesPoints);
  const noPath = toPath(noPoints);

  return { yesPoints, noPoints, yesPath, noPath, gridYs, timeLabels };
}

function relativeAge(ts: number, nowTs: number): string {
  const diffMin = Math.round((nowTs - ts) / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  return `${diffHour}h ago`;
}

function formatHover(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
