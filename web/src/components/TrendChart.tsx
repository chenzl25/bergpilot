import { type ReactNode, useEffect, useRef, useState } from "react";

import type { SnapshotInfo } from "@/api/generated/SnapshotInfo";
import { Panel } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatBytes, formatNumber, formatTime } from "@/format";
import { cn } from "@/lib/utils";

type Metric = "records" | "files" | "size" | "deletes";

const METRICS: { id: Metric; label: string; key: string; format: (value: number) => string }[] = [
  { id: "records", label: "Records", key: "total-records", format: formatNumber },
  { id: "files", label: "Data files", key: "total-data-files", format: formatNumber },
  { id: "size", label: "Data size", key: "total-files-size", format: formatBytes },
  { id: "deletes", label: "Delete files", key: "total-delete-files", format: formatNumber },
];

const OPERATIONS: Record<string, { className: string; color: string }> = {
  append: { className: "border-success/30 bg-success/10 text-success", color: "var(--chart-1)" },
  overwrite: { className: "border-warning/40 bg-warning/10 text-warning", color: "var(--chart-3)" },
  replace: { className: "border-chart-4/30 bg-chart-4/10 text-chart-4", color: "var(--chart-4)" },
  delete: { className: "border-destructive/30 bg-destructive/10 text-destructive", color: "var(--chart-5)" },
};

/** Snapshot operation: append, overwrite, replace (compaction) or delete. */
export function OperationBadge({ operation }: { operation: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", OPERATIONS[operation]?.className)}>
      {operation}
    </Badge>
  );
}

const HEIGHT = 220;
const PAD = { left: 64, right: 16, top: 16, bottom: 28 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * A step chart of a table total across snapshots, read from snapshot
 * summaries. Snapshots are evenly spaced in commit order (commits are
 * usually bursty, so a time axis would bunch them up); snapshots without the
 * total are skipped.
 */
export function TrendChart({ snapshots, extra }: { snapshots: SnapshotInfo[]; extra?: ReactNode }) {
  const [metric, setMetric] = useState<Metric>("records");
  const [hover, setHover] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();
  const config = METRICS.find((m) => m.id === metric)!;
  const points = snapshots
    .map((snapshot) => ({ t: snapshot.timestamp_ms, v: Number(snapshot.summary[config.key]), op: snapshot.operation }))
    .filter((point) => Number.isFinite(point.v));

  if (points.length < 2) return null;
  const vMax = Math.max(...points.map((p) => p.v), 1);
  const plotWidth = Math.max(width - PAD.left - PAD.right, 10);
  const x = (index: number) => PAD.left + (index / (points.length - 1)) * plotWidth;
  const y = (v: number) => PAD.top + (1 - v / vMax) * (HEIGHT - PAD.top - PAD.bottom);
  let line = `M ${x(0)} ${y(points[0].v)}`;
  for (let i = 1; i < points.length; i++) line += ` H ${x(i)} V ${y(points[i].v)}`;
  const area = `${line} V ${y(0)} H ${x(0)} Z`;
  const active = hover ?? points.length - 1;
  const point = points[active];

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
        {extra}
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={metric}
          onValueChange={(value) => value && setMetric(value as Metric)}
        >
          {METRICS.map((m) => (
            <ToggleGroupItem key={m.id} value={m.id}>
              {m.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold tabular-nums">{config.format(point.v)}</span>
          <span className="text-muted-foreground">{formatTime(point.t)}</span>
          <OperationBadge operation={point.op} />
        </div>
      </div>
      <div ref={ref} className="px-2 py-2">
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`${config.label} over time`}
            className="block"
            onMouseLeave={() => setHover(null)}
            onMouseMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              const fraction = (event.clientX - box.left - PAD.left) / plotWidth;
              setHover(Math.min(points.length - 1, Math.max(0, Math.round(fraction * (points.length - 1)))));
            }}
          >
            <defs>
              <linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(vMax * f)}
                  y2={y(vMax * f)}
                  stroke="var(--border)"
                  strokeDasharray={f === 0 ? undefined : "3 4"}
                />
                <text
                  x={PAD.left - 10}
                  y={y(vMax * f) + 4}
                  textAnchor="end"
                  className="fill-muted-foreground text-[11px] tabular-nums"
                >
                  {config.format(vMax * f)}
                </text>
              </g>
            ))}
            <text x={PAD.left} y={HEIGHT - 8} className="fill-muted-foreground text-[11px]">
              {formatTime(points[0].t)}
            </text>
            <text x={width - PAD.right} y={HEIGHT - 8} textAnchor="end" className="fill-muted-foreground text-[11px]">
              {formatTime(points[points.length - 1].t)}
            </text>
            <path d={area} fill="url(#trend-fill)" />
            <path d={line} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinejoin="round" />
            {hover !== null && (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD.top}
                y2={HEIGHT - PAD.bottom}
                stroke="var(--muted-foreground)"
                strokeOpacity={0.4}
              />
            )}
            {points.map((p, index) =>
              p.op !== "append" || index === active ? (
                <circle
                  key={index}
                  cx={x(index)}
                  cy={y(p.v)}
                  r={index === active ? 4.5 : 3.5}
                  fill={OPERATIONS[p.op]?.color ?? "var(--muted-foreground)"}
                  stroke="var(--card)"
                  strokeWidth={2}
                />
              ) : null,
            )}
          </svg>
        )}
      </div>
    </Panel>
  );
}
