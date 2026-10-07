// The Snapshots tab: branches and tags, the trend of the chosen branch, and
// the history drawn as a branch graph (layout in lib/snapshot-graph.ts).

import { type CSSProperties, type Ref, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { GitBranch, SquareTerminal, Tag } from "lucide-react";
import { Link } from "react-router";

import type { RefInfo } from "@/api/generated/RefInfo";
import type { TableDetail } from "@/api/generated/TableDetail";
import { CopyButton, Panel, Section } from "@/components/page";
import { OperationBadge, TrendChart } from "@/components/TrendChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatAge, formatNumber, formatTime, sqlTableName } from "@/format";
import {
  type BranchLine,
  type GraphRow,
  type Segment,
  type SnapshotGraph,
  OFF_BRANCH_COLOR,
  publishLag,
  snapshotGraph,
} from "@/lib/snapshot-graph";
import { cn } from "@/lib/utils";

const ROW_HEIGHT = 40;
/** History rows: graph, snapshot and operation; four more columns on wide screens. */
const GRID = "grid items-center [grid-template-columns:var(--cols)] lg:[grid-template-columns:var(--cols-wide)]";
const LANE_WIDTH = 18;
const GRAPH_PAD = 14;

const DAY = 86_400_000;
function formatDuration(ms: number): string {
  if (ms % DAY === 0) return `${ms / DAY} day${ms === DAY ? "" : "s"}`;
  const hours = ms / 3_600_000;
  return hours >= 1 ? `${Number(hours.toFixed(1))} h` : `${Math.round(ms / 60_000)} min`;
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

function asOfSql(detail: TableDetail, at: string): string {
  return `SELECT * FROM ${sqlTableName(detail.catalog, detail.namespace, `${detail.name}@${at}`)} LIMIT 100`;
}

export function SnapshotsTab({ detail }: { detail: TableDetail }) {
  const graph = useMemo(() => snapshotGraph(detail.snapshots, detail.refs), [detail.snapshots, detail.refs]);
  const [selected, setSelected] = useState<string | null>(null);
  const [chartBranch, setChartBranch] = useState<string | null>(null);
  const listRef = useRef<HistoryHandle>(null);

  if (detail.snapshots.length === 0) {
    return <p className="text-sm text-muted-foreground">This table has no snapshots yet.</p>;
  }
  const charted = graph.branches.find((b) => b.ref.name === chartBranch) ?? graph.branches[0];
  const show = (id: string) => {
    setSelected(id);
    listRef.current?.scrollTo(id);
  };

  return (
    <div className="flex flex-col gap-6">
      {(graph.branches.length > 1 || detail.refs.some((ref) => ref.kind === "tag")) && (
        <Branches detail={detail} graph={graph} onShow={show} />
      )}
      <TrendChart
        snapshots={charted ? charted.history : detail.snapshots}
        extra={
          graph.branches.length > 1 && charted ? (
            <Select value={charted.ref.name} onValueChange={setChartBranch}>
              <SelectTrigger size="sm" className="w-auto min-w-32" aria-label="Branch shown in the chart">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {graph.branches.map((branch) => (
                  <SelectItem key={branch.ref.name} value={branch.ref.name}>
                    <BranchDot color={branch.color} />
                    {branch.ref.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : undefined
        }
      />
      <Section
        title="History"
        description={[
          "Newest first.",
          graph.branches.length > 1 && "Each line is a branch.",
          graph.rows.some((row) => row.snapshot.published_from) &&
            "A dashed line leads from a publish to the snapshot it was made from.",
          "Click a snapshot for details.",
        ]
          .filter(Boolean)
          .join(" ")}
        actions={<Legend graph={graph} />}
      >
        <History ref={listRef} graph={graph} selected={selected} onSelect={setSelected} />
      </Section>
      <SnapshotSheet detail={detail} graph={graph} id={selected} onShow={show} onClose={() => setSelected(null)} />
    </div>
  );
}

function BranchDot({ color, hollow }: { color: string; hollow?: boolean }) {
  return (
    <span
      className="inline-block size-2.5 shrink-0 rounded-full border-2"
      style={{ borderColor: color, background: hollow ? "transparent" : color }}
    />
  );
}

function Legend({ graph }: { graph: SnapshotGraph }) {
  const offBranch = graph.rows.some((row) => row.branches.length === 0);
  if (graph.branches.length < 2 && !offBranch) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {graph.branches.map((branch) => (
        <span key={branch.ref.name} className="inline-flex items-center gap-1.5">
          <BranchDot color={branch.color} />
          {branch.ref.name}
        </span>
      ))}
      {offBranch && (
        <span className="inline-flex items-center gap-1.5" title="No branch reaches these snapshots, for example the old tip after a rollback. Snapshot expiry removes them.">
          <BranchDot color={OFF_BRANCH_COLOR} hollow />
          not on a branch
        </span>
      )}
    </div>
  );
}

function retention(ref: RefInfo): string | undefined {
  const parts = [];
  if (ref.min_snapshots_to_keep !== undefined) parts.push(`keeps at least ${ref.min_snapshots_to_keep} snapshots`);
  if (ref.max_snapshot_age_ms !== undefined) parts.push(`snapshots up to ${formatDuration(ref.max_snapshot_age_ms)} old`);
  if (ref.max_ref_age_ms !== undefined) parts.push(`${ref.kind === "tag" ? "tag" : "branch"} kept ${formatDuration(ref.max_ref_age_ms)}`);
  return parts.length ? parts.join(", ") : undefined;
}

function Branches({ detail, graph, onShow }: { detail: TableDetail; graph: SnapshotGraph; onShow: (id: string) => void }) {
  const tags = detail.refs.filter((ref) => ref.kind === "tag");
  const byId = new Map(detail.snapshots.map((s) => [s.snapshot_id, s]));
  return (
    <Section title="Branches and tags">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {graph.branches.map((branch) => (
          <BranchCard key={branch.ref.name} detail={detail} graph={graph} branch={branch} onShow={onShow} />
        ))}
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {tags.map((tag) => {
            const at = byId.get(tag.snapshot_id);
            return (
              <button
                key={tag.name}
                type="button"
                onClick={() => onShow(tag.snapshot_id)}
                className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-left shadow-xs hover:bg-muted"
                title={retention(tag) ?? "Kept until it is dropped"}
              >
                <Tag className="size-3.5 text-muted-foreground" />
                <span className="font-medium">{tag.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{shortId(tag.snapshot_id)}</span>
                {at && <span className="text-xs text-muted-foreground">{formatAge(at.timestamp_ms)}</span>}
              </button>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function BranchCard(props: { detail: TableDetail; graph: SnapshotGraph; branch: BranchLine; onShow: (id: string) => void }) {
  const { branch } = props;
  const tip = branch.history[branch.history.length - 1];
  const lag = publishLag(props.graph, branch);
  const kept = retention(branch.ref);
  return (
    <Panel className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-2">
        <BranchDot color={branch.color} />
        <span className="font-medium">{branch.ref.name}</span>
        {tip.snapshot_id === props.detail.current_snapshot_id && (
          <Badge variant="secondary" className="h-4.5 px-1.5 text-[10px]">
            current
          </Badge>
        )}
        <Button variant="ghost" size="xs" className="ml-auto" asChild>
          <Link to={`/sql?q=${encodeURIComponent(asOfSql(props.detail, branch.ref.name))}`}>
            <SquareTerminal />
            Query
          </Link>
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
        <button
          type="button"
          className="font-mono text-xs text-foreground hover:underline"
          onClick={() => props.onShow(tip.snapshot_id)}
          title={`Latest snapshot ${tip.snapshot_id}`}
        >
          {shortId(tip.snapshot_id)}
        </button>
        <span title={formatTime(tip.timestamp_ms)}>{formatAge(tip.timestamp_ms)}</span>
        <span>·</span>
        <span>
          {formatNumber(branch.history.length)} snapshot{branch.history.length === 1 ? "" : "s"}
        </span>
        {tip.summary["total-records"] !== undefined && (
          <>
            <span>·</span>
            <span>{formatNumber(tip.summary["total-records"])} records</span>
          </>
        )}
      </div>
      {lag && (
        <p className="text-sm">
          Published from {lag.sourceBranch}{" "}
          <button
            type="button"
            className="font-mono text-xs hover:underline"
            onClick={() => props.onShow(lag.source.snapshot_id)}
            title={lag.source.snapshot_id}
          >
            {shortId(lag.source.snapshot_id)}
          </button>{" "}
          <span className="text-muted-foreground">({formatAge(lag.source.timestamp_ms)})</span>.{" "}
          {lag.pending === 0 ? (
            <span className="text-success">Up to date.</span>
          ) : (
            <span className="text-warning">
              {formatNumber(lag.pending)} newer {lag.sourceBranch} commit{lag.pending === 1 ? "" : "s"} not published yet.
            </span>
          )}
        </p>
      )}
      {kept && <p className="text-xs text-muted-foreground">Retention: {kept}</p>}
    </Panel>
  );
}

type HistoryHandle = { scrollTo: (id: string) => void };

function History(props: {
  ref: Ref<HistoryHandle>;
  graph: SnapshotGraph;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { graph } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: graph.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });
  const index = useMemo(() => new Map(graph.rows.map((row, i) => [row.snapshot.snapshot_id, i])), [graph]);
  useImperativeHandle(
    props.ref,
    () => ({
      scrollTo: (id) => {
        const i = index.get(id);
        if (i !== undefined) virtualizer.scrollToIndex(i, { align: "center" });
      },
    }),
    [index, virtualizer],
  );

  const graphWidth = GRAPH_PAD * 2 + (graph.lanes - 1) * LANE_WIDTH;
  const narrow = `${graphWidth}px minmax(0, 1.5fr) minmax(0, 1fr)`;
  const grid = {
    "--cols": narrow,
    "--cols-wide": `${narrow} 200px 90px 140px 110px`,
  } as CSSProperties;
  const wide = "hidden lg:block";
  return (
    <Panel>
      <div ref={scrollRef} className="relative overflow-auto" style={{ maxHeight: "min(720px, 75vh)" }}>
        <div
          className={cn(GRID, "sticky top-0 z-10 border-b bg-muted/80 text-xs font-medium text-muted-foreground backdrop-blur")}
          style={grid}
        >
          <span />
          <span className="py-2 pr-3">Snapshot</span>
          <span className="py-2 pr-3">Operation</span>
          <span className={cn(wide, "py-2 pr-3")}>Committed</span>
          <span className={cn(wide, "py-2 pr-3 text-right")}>Files</span>
          <span className={cn(wide, "py-2 pr-3 text-right")}>Records</span>
          <span className={cn(wide, "py-2 pr-4 text-right")}>Total records</span>
        </div>
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = graph.rows[item.index];
            return (
              <HistoryRow
                key={item.key}
                row={row}
                graph={graph}
                grid={grid}
                selected={props.selected === row.snapshot.snapshot_id}
                top={item.start}
                onSelect={props.onSelect}
              />
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

function change(added: number, removed: number) {
  if (!added && !removed) return null;
  return (
    <>
      {added > 0 && <span className="text-success">+{formatNumber(added)}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="text-destructive">−{formatNumber(removed)}</span>}
    </>
  );
}

function HistoryRow(props: {
  row: GraphRow;
  graph: SnapshotGraph;
  grid: CSSProperties;
  selected: boolean;
  top: number;
  onSelect: (id: string) => void;
}) {
  const { row, graph } = props;
  const s = row.snapshot.summary;
  const n = (key: string) => Number(s[key] ?? 0);
  const source = row.snapshot.published_from;
  const sourceBranch = source ? graph.rowById.get(source)?.branches[0] : undefined;
  const wide = "hidden truncate lg:block";
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={props.selected}
      onClick={() => props.onSelect(row.snapshot.snapshot_id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onSelect(row.snapshot.snapshot_id);
        }
      }}
      className={cn(
        GRID,
        "absolute left-0 w-full cursor-pointer border-b border-border/60 text-sm outline-none hover:bg-muted/50 focus-visible:bg-muted/60",
        props.selected && "bg-muted",
      )}
      style={{ ...props.grid, height: ROW_HEIGHT, transform: `translateY(${props.top}px)` }}
    >
      <GraphCell row={row} lanes={graph.lanes} />
      <span className="flex min-w-0 items-center gap-1.5 pr-3">
        <span className={cn("truncate font-mono text-[12.5px]", row.branches.length === 0 && "text-muted-foreground")}>
          {row.snapshot.snapshot_id}
        </span>
        {row.refs.map((ref) => (
          <RefBadge key={ref.name} reference={ref} color={graph.branchColor.get(ref.name)} />
        ))}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pr-3">
        <OperationBadge operation={row.snapshot.operation} />
        {sourceBranch && <span className="truncate text-xs text-muted-foreground">from {sourceBranch}</span>}
      </span>
      <span className={cn(wide, "pr-3 text-muted-foreground")} title={formatTime(row.snapshot.timestamp_ms)}>
        {formatTime(row.snapshot.timestamp_ms)}
      </span>
      <span className={cn(wide, "pr-3 text-right tabular-nums")}>
        {change(n("added-data-files") + n("added-delete-files"), n("deleted-data-files") + n("removed-delete-files"))}
      </span>
      <span className={cn(wide, "pr-3 text-right tabular-nums")}>{change(n("added-records"), n("deleted-records"))}</span>
      <span className={cn(wide, "pr-4 text-right font-medium tabular-nums")}>
        {s["total-records"] !== undefined ? formatNumber(s["total-records"]) : ""}
      </span>
    </div>
  );
}

function RefBadge({ reference, color }: { reference: RefInfo; color?: string }) {
  return (
    <Badge variant="outline" className="h-5 shrink-0 gap-1 px-1.5 text-[11px]">
      {reference.kind === "tag" ? (
        <Tag className="size-3" />
      ) : (
        <GitBranch className="size-3" style={color ? { color } : undefined} />
      )}
      {reference.name}
    </Badge>
  );
}

function segmentPath(segment: Segment): string {
  const x1 = GRAPH_PAD + segment.x1 * LANE_WIDTH;
  const x2 = GRAPH_PAD + segment.x2 * LANE_WIDTH;
  const y1 = segment.y1 * ROW_HEIGHT;
  const y2 = segment.y2 * ROW_HEIGHT;
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
}

function GraphCell({ row, lanes }: { row: GraphRow; lanes: number }) {
  const width = GRAPH_PAD * 2 + (lanes - 1) * LANE_WIDTH;
  const x = GRAPH_PAD + row.lane * LANE_WIDTH;
  const y = ROW_HEIGHT / 2;
  const tip = row.refs.some((ref) => ref.kind === "branch");
  const offBranch = row.branches.length === 0;
  return (
    <svg width={width} height={ROW_HEIGHT} className="block overflow-visible" aria-hidden>
      {row.segments.map((segment, i) => (
        <path
          key={i}
          d={segmentPath(segment)}
          fill="none"
          stroke={segment.color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={segment.dashed ? "4 4" : undefined}
          strokeOpacity={segment.color === OFF_BRANCH_COLOR ? 0.5 : 1}
        />
      ))}
      {row.expiredParent && (
        <path
          d={`M ${x} ${y} L ${x} ${ROW_HEIGHT}`}
          stroke={row.color}
          strokeWidth={2}
          strokeDasharray="1 4"
          strokeLinecap="round"
          strokeOpacity={0.6}
        />
      )}
      {tip && <circle cx={x} cy={y} r={7.5} fill="var(--card)" stroke={row.color} strokeWidth={2} />}
      <circle
        cx={x}
        cy={y}
        r={tip ? 3.5 : 4.5}
        fill={offBranch ? "var(--card)" : row.color}
        stroke={offBranch ? row.color : "var(--card)"}
        strokeWidth={offBranch ? 2 : 1.5}
      />
    </svg>
  );
}

function SnapshotSheet(props: {
  detail: TableDetail;
  graph: SnapshotGraph;
  id: string | null;
  onShow: (id: string) => void;
  onClose: () => void;
}) {
  const row = props.id === null ? undefined : props.graph.rowById.get(props.id);
  const known = (id: string | undefined) => id !== undefined && props.graph.rowById.has(id);
  const jump = (id: string) => (
    <button type="button" className="font-mono hover:underline" onClick={() => props.onShow(id)}>
      {id}
    </button>
  );
  return (
    <Sheet open={row !== undefined} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-lg" onOpenAutoFocus={(event) => event.preventDefault()}>
        {row && (
          <>
            <SheetHeader className="border-b pr-12">
              <SheetTitle className="flex items-center gap-1 font-mono text-base">
                {row.snapshot.snapshot_id}
                <CopyButton value={row.snapshot.snapshot_id} label="Copy snapshot id" />
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <OperationBadge operation={row.snapshot.operation} />
                <span title={formatTime(row.snapshot.timestamp_ms)}>
                  {formatTime(row.snapshot.timestamp_ms)} ({formatAge(row.snapshot.timestamp_ms)})
                </span>
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4 text-sm">
              <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
                <dt className="text-muted-foreground">On branches</dt>
                <dd className="flex flex-wrap items-center gap-1.5">
                  {row.branches.length === 0 ? (
                    <span className="text-muted-foreground">
                      None. No branch reaches this snapshot, so snapshot expiry will remove it.
                    </span>
                  ) : (
                    row.branches.map((name) => (
                      <span key={name} className="inline-flex items-center gap-1.5">
                        <BranchDot color={props.graph.branchColor.get(name) ?? OFF_BRANCH_COLOR} />
                        {name}
                      </span>
                    ))
                  )}
                </dd>
                {row.refs.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">Pointed to by</dt>
                    <dd className="flex flex-wrap gap-1">
                      {row.refs.map((ref) => (
                        <RefBadge key={ref.name} reference={ref} color={props.graph.branchColor.get(ref.name)} />
                      ))}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">Parent</dt>
                <dd className="text-[13px]">
                  {row.snapshot.parent_id === undefined ? (
                    <span className="text-muted-foreground">None (first snapshot of this line)</span>
                  ) : known(row.snapshot.parent_id) ? (
                    jump(row.snapshot.parent_id)
                  ) : (
                    <span>
                      <span className="font-mono">{row.snapshot.parent_id}</span>{" "}
                      <span className="text-muted-foreground">(expired)</span>
                    </span>
                  )}
                </dd>
                {row.snapshot.published_from && (
                  <>
                    <dt className="text-muted-foreground">Published from</dt>
                    <dd className="text-[13px]">
                      {jump(row.snapshot.published_from)}
                      <p className="mt-1 text-xs text-muted-foreground">
                        RisingWave compacted that snapshot and published the result here. The two share
                        risingwave.commit.epoch.
                      </p>
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">Sequence number</dt>
                <dd className="font-mono text-[13px]">{row.snapshot.sequence_number}</dd>
              </dl>
              <div>
                <Button size="sm" variant="outline" asChild>
                  <Link to={`/sql?q=${encodeURIComponent(asOfSql(props.detail, row.snapshot.snapshot_id))}`}>
                    <SquareTerminal />
                    Query the table as of this snapshot
                  </Link>
                </Button>
              </div>
              <div>
                <h3 className="mb-2 text-xs font-medium text-muted-foreground">Summary</h3>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 rounded-lg border bg-muted/30 p-3 text-xs">
                  {Object.entries(row.snapshot.summary).map(([key, value]) => (
                    <div key={key} className="contents">
                      <dt className="text-muted-foreground">{key}</dt>
                      <dd className="font-mono break-all">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
