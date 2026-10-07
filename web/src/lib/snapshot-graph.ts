// Lays out a table's snapshots as a branch graph, one row per snapshot,
// newest first, like `git log --graph`. Iceberg snapshots have one parent;
// the extra edge is `published_from` (a RisingWave copy-on-write publish from
// `ingestion` to `main`), drawn dashed. Rows are independent, so the list can
// be virtualized: each row carries the line segments that cross it.
//
// Only type imports here: `node --test` runs this file with types stripped.
import type { RefInfo } from "@/api/generated/RefInfo";
import type { SnapshotInfo } from "@/api/generated/SnapshotInfo";

/** Lane colors in branch order; `main` always takes the first. */
export const BRANCH_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-4)", "var(--chart-5)", "var(--chart-3)"];
/** Snapshots no branch reaches, such as the old tip after a rollback. */
export const OFF_BRANCH_COLOR = "var(--muted-foreground)";

/** A line inside one row. `x` is a lane index; `y` is 0 (top), 0.5 (the node) or 1 (bottom). */
export type Segment = {
  x1: number;
  y1: 0 | 0.5 | 1;
  x2: number;
  y2: 0 | 0.5 | 1;
  color: string;
  dashed: boolean;
};

export type GraphRow = {
  snapshot: SnapshotInfo;
  lane: number;
  color: string;
  /** Branches whose history includes this snapshot, in branch order. */
  branches: string[];
  /** Branches and tags pointing at this snapshot. */
  refs: RefInfo[];
  segments: Segment[];
  /** The parent is no longer in the metadata (expired). */
  expiredParent: boolean;
};

export type BranchLine = {
  ref: RefInfo;
  color: string;
  /** The branch's history in the metadata, oldest first. */
  history: SnapshotInfo[];
};

/** How far a branch fed by publishes (RisingWave `main`) trails its source. */
export type PublishLag = {
  /** The newest publish on the branch. */
  publish: SnapshotInfo;
  /** The snapshot it was published from. */
  source: SnapshotInfo;
  sourceBranch: string;
  /** Commits on the source branch after `source`, compactions not counted. */
  pending: number;
};

export type SnapshotGraph = {
  rows: GraphRow[];
  lanes: number;
  /** `main` first, then by most recent commit. Tags are not branches. */
  branches: BranchLine[];
  rowById: Map<string, GraphRow>;
  branchColor: Map<string, string>;
};

type Lane = { target: string; color: string; dashed: boolean };

/** Newer first: sequence number, then commit time, then id. */
function newer(a: SnapshotInfo, b: SnapshotInfo): number {
  return (
    b.sequence_number - a.sequence_number ||
    b.timestamp_ms - a.timestamp_ms ||
    (a.snapshot_id < b.snapshot_id ? 1 : a.snapshot_id > b.snapshot_id ? -1 : 0)
  );
}

/** Walks parent links from `tipId`; returns oldest first. */
export function history(byId: Map<string, SnapshotInfo>, tipId: string): SnapshotInfo[] {
  const out: SnapshotInfo[] = [];
  const seen = new Set<string>();
  let next: string | undefined = tipId;
  while (next !== undefined && !seen.has(next)) {
    const snapshot = byId.get(next);
    if (!snapshot) break;
    seen.add(next);
    out.push(snapshot);
    next = snapshot.parent_id;
  }
  return out.reverse();
}

/**
 * Orders snapshots newest first while keeping every snapshot above its parent
 * and above the snapshot it was published from, even if clocks disagree.
 */
function order(snapshots: SnapshotInfo[], byId: Map<string, SnapshotInfo>): SnapshotInfo[] {
  const below = (s: SnapshotInfo) =>
    [s.parent_id, s.published_from].filter((id): id is string => id !== undefined && byId.has(id));
  const waiting = new Map<string, number>();
  for (const s of snapshots) for (const id of below(s)) waiting.set(id, (waiting.get(id) ?? 0) + 1);

  // A binary heap keyed by `newer`; ready snapshots have no unplaced children.
  const heap: SnapshotInfo[] = [];
  const push = (s: SnapshotInfo) => {
    heap.push(s);
    for (let i = heap.length - 1; i > 0; ) {
      const up = (i - 1) >> 1;
      if (newer(heap[i], heap[up]) >= 0) break;
      [heap[i], heap[up]] = [heap[up], heap[i]];
      i = up;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < heap.length && newer(heap[l], heap[best]) < 0) best = l;
        if (r < heap.length && newer(heap[r], heap[best]) < 0) best = r;
        if (best === i) break;
        [heap[i], heap[best]] = [heap[best], heap[i]];
        i = best;
      }
    }
    return top;
  };

  for (const s of snapshots) if (!waiting.has(s.snapshot_id)) push(s);
  const out: SnapshotInfo[] = [];
  while (heap.length > 0) {
    const s = pop();
    out.push(s);
    for (const id of below(s)) {
      const left = waiting.get(id)! - 1;
      waiting.set(id, left);
      if (left === 0) push(byId.get(id)!);
    }
  }
  // Duplicate ids or a cycle would strand snapshots; list them at the end.
  if (out.length < snapshots.length) {
    const placed = new Set(out);
    out.push(...snapshots.filter((s) => !placed.has(s)).sort(newer));
  }
  return out;
}

export function snapshotGraph(snapshots: SnapshotInfo[], refs: RefInfo[]): SnapshotGraph {
  const byId = new Map(snapshots.map((s) => [s.snapshot_id, s]));

  const branchRefs = refs
    .filter((ref) => ref.kind === "branch" && byId.has(ref.snapshot_id))
    .sort((a, b) =>
      a.name === "main" ? -1 : b.name === "main" ? 1 : newer(byId.get(a.snapshot_id)!, byId.get(b.snapshot_id)!) || a.name.localeCompare(b.name),
    );
  const branches: BranchLine[] = branchRefs.map((ref, index) => ({
    ref,
    color: BRANCH_COLORS[index % BRANCH_COLORS.length],
    history: history(byId, ref.snapshot_id),
  }));

  const branchesOf = new Map<string, string[]>();
  for (const branch of branches) {
    for (const s of branch.history) branchesOf.set(s.snapshot_id, [...(branchesOf.get(s.snapshot_id) ?? []), branch.ref.name]);
  }
  const colorByBranch = new Map(branches.map((b) => [b.ref.name, b.color]));
  const colorOf = (id: string) => colorByBranch.get(branchesOf.get(id)?.[0] ?? "") ?? OFF_BRANCH_COLOR;

  // Each branch tip that is not already on an earlier branch's line gets
  // its own lane, kept free until the tip's row: `main` stays leftmost.
  const reservedLane = new Map<string, number>();
  const covered = new Set<string>();
  for (const branch of branches) {
    if (!covered.has(branch.ref.snapshot_id) && !reservedLane.has(branch.ref.snapshot_id)) {
      reservedLane.set(branch.ref.snapshot_id, reservedLane.size);
    }
    for (const s of branch.history) covered.add(s.snapshot_id);
  }
  const pending = new Set(reservedLane.values());

  const refsAt = new Map<string, RefInfo[]>();
  for (const ref of refs) refsAt.set(ref.snapshot_id, [...(refsAt.get(ref.snapshot_id) ?? []), ref]);

  const lanes: (Lane | null)[] = [];
  const freeLane = (except?: number) => {
    for (let i = 0; ; i++) if (i !== except && !lanes[i] && !pending.has(i)) return i;
  };
  let width = 0;
  const rows: GraphRow[] = [];

  for (const snapshot of order(snapshots, byId)) {
    const id = snapshot.snapshot_id;
    const color = colorOf(id);
    const incoming: number[] = [];
    lanes.forEach((lane, i) => lane?.target === id && incoming.push(i));

    let lane = reservedLane.get(id);
    if (lane !== undefined) pending.delete(lane);
    else if (incoming.length > 0) lane = incoming.find((i) => !lanes[i]!.dashed) ?? incoming[0];
    else lane = freeLane();

    const segments: Segment[] = [];
    lanes.forEach((through, i) => {
      if (!through) return;
      const style = { color: through.color, dashed: through.dashed };
      if (incoming.includes(i)) segments.push({ x1: i, y1: 0, x2: lane, y2: 0.5, ...style });
      else segments.push({ x1: i, y1: 0, x2: i, y2: 1, ...style });
    });
    for (const i of incoming) lanes[i] = null;

    const parent = snapshot.parent_id;
    if (parent !== undefined && byId.has(parent)) {
      lanes[lane] = { target: parent, color, dashed: false };
      segments.push({ x1: lane, y1: 0.5, x2: lane, y2: 1, color, dashed: false });
    }
    const source = snapshot.published_from;
    if (source !== undefined && byId.has(source)) {
      const to = freeLane(lane);
      const style = { color: colorOf(source), dashed: true };
      lanes[to] = { target: source, ...style };
      segments.push({ x1: lane, y1: 0.5, x2: to, y2: 1, ...style });
    }
    while (lanes.length > 0 && !lanes[lanes.length - 1]) lanes.pop();
    width = Math.max(width, lanes.length, lane + 1);

    rows.push({
      snapshot,
      lane,
      color,
      branches: branchesOf.get(id) ?? [],
      refs: refsAt.get(id) ?? [],
      segments,
      expiredParent: parent !== undefined && !byId.has(parent),
    });
  }

  const rowById = new Map(rows.map((row) => [row.snapshot.snapshot_id, row]));
  return { rows, lanes: width, branches, rowById, branchColor: colorByBranch };
}

/**
 * For a branch whose newest publish came from another branch, the snapshot
 * it came from and how many commits that branch has made since.
 */
export function publishLag(graph: SnapshotGraph, branch: BranchLine): PublishLag | undefined {
  const publish = [...branch.history].reverse().find((s) => s.published_from && graph.rowById.has(s.published_from));
  if (!publish) return undefined;
  const sourceRow = graph.rowById.get(publish.published_from!)!;
  const sourceBranch = graph.branches.find(
    (b) => b !== branch && sourceRow.branches.includes(b.ref.name),
  );
  if (!sourceBranch) return undefined;
  const source = sourceRow.snapshot;
  const pending = sourceBranch.history.filter(
    (s) => s.sequence_number > source.sequence_number && s.operation !== "replace",
  ).length;
  return { publish, source, sourceBranch: sourceBranch.ref.name, pending };
}
