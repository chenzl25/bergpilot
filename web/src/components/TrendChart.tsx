import { useState } from "react";

import type { SnapshotInfo } from "../api/generated/SnapshotInfo";
import { formatBytes, formatNumber, formatTime } from "../format";

type Metric = "records" | "files" | "size" | "deletes";

const METRICS: { id: Metric; label: string; key: string; format: (value: number) => string }[] = [
  { id: "records", label: "Records", key: "total-records", format: formatNumber },
  { id: "files", label: "Data files", key: "total-data-files", format: formatNumber },
  { id: "size", label: "Data size", key: "total-files-size", format: formatBytes },
  { id: "deletes", label: "Delete files", key: "total-delete-files", format: formatNumber },
];

const WIDTH = 860;
const HEIGHT = 200;
const PAD = { left: 64, right: 16, top: 12, bottom: 28 };

/**
 * A step chart of a table total across snapshots, read from snapshot
 * summaries. Snapshots are evenly spaced in commit order (commits are
 * usually bursty, so a time axis would bunch them up); snapshots without the
 * total are skipped.
 */
export function TrendChart({ snapshots }: { snapshots: SnapshotInfo[] }) {
  const [metric, setMetric] = useState<Metric>("records");
  const config = METRICS.find((m) => m.id === metric)!;
  const points = snapshots
    .map((snapshot) => ({
      t: snapshot.timestamp_ms,
      v: Number(snapshot.summary[config.key]),
      op: snapshot.operation,
    }))
    .filter((point) => Number.isFinite(point.v));
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) return null;
  const tMin = points[0].t;
  const tMax = points[points.length - 1].t;
  const vMax = Math.max(...points.map((p) => p.v), 1);
  const x = (index: number) => PAD.left + (index / (points.length - 1)) * (WIDTH - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / vMax) * (HEIGHT - PAD.top - PAD.bottom);
  let path = `M ${x(0)} ${y(points[0].v)}`;
  for (let i = 1; i < points.length; i++) {
    path += ` H ${x(i)} V ${y(points[i].v)}`;
  }
  const active = hover !== null ? points[hover] : points[points.length - 1];

  return (
    <div className="trend">
      <div className="trend-header">
        <div className="segmented">
          {METRICS.map((m) => (
            <button key={m.id} className={metric === m.id ? "active" : ""} onClick={() => setMetric(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <span className="muted small">
          {config.format(active.v)} at {formatTime(active.t)} ({active.op})
        </span>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="trend-svg"
        role="img"
        aria-label={`${config.label} over time`}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(vMax * f)} y2={y(vMax * f)} className="trend-grid" />
            <text x={PAD.left - 8} y={y(vMax * f) + 4} className="trend-axis" textAnchor="end">
              {config.format(vMax * f)}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={HEIGHT - 8} className="trend-axis">
          {formatTime(tMin)}
        </text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 8} className="trend-axis" textAnchor="end">
          {formatTime(tMax)}
        </text>
        <path d={path} className="trend-line" />
        {points.map((point, index) => (
          <circle
            key={index}
            cx={x(index)}
            cy={y(point.v)}
            r={hover === index ? 5 : 3}
            className={`trend-dot op-dot-${point.op}`}
            onMouseEnter={() => setHover(index)}
          />
        ))}
      </svg>
    </div>
  );
}
