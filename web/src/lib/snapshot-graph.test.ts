// Run with `pnpm test` (node --test; Node 24 strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { RefInfo } from "@/api/generated/RefInfo";
import type { SnapshotInfo } from "@/api/generated/SnapshotInfo";

import { BRANCH_COLORS, OFF_BRANCH_COLOR, publishLag, snapshotGraph } from "./snapshot-graph.ts";

function snap(id: number, parent?: number, operation = "append", publishedFrom?: number): SnapshotInfo {
  return {
    snapshot_id: String(id),
    parent_id: parent === undefined ? undefined : String(parent),
    sequence_number: id,
    timestamp_ms: 1_000 * id,
    operation,
    summary: {},
    published_from: publishedFrom === undefined ? undefined : String(publishedFrom),
  };
}
const branch = (name: string, id: number): RefInfo => ({ name, kind: "branch", snapshot_id: String(id) });
const tag = (name: string, id: number): RefInfo => ({ name, kind: "tag", snapshot_id: String(id) });

const lanesOf = (graph: ReturnType<typeof snapshotGraph>) =>
  Object.fromEntries(graph.rows.map((row) => [row.snapshot.snapshot_id, row.lane]));

// The Spark table demo.branchy: `audit` forks from 2; main was rolled back
// from 6 to 3 and then got 7; tags v1 (2) and release (7).
const branchy = [snap(1), snap(2, 1), snap(3, 2), snap(4, 2), snap(5, 4), snap(6, 3), snap(7, 3), snap(8, 5, "delete")];
const branchyRefs = [branch("main", 7), tag("v1", 2), branch("audit", 8), tag("release", 7)];

test("forked branches get their own lanes and join where they fork", () => {
  const graph = snapshotGraph(branchy, branchyRefs);
  assert.deepEqual(
    graph.rows.map((row) => row.snapshot.snapshot_id),
    ["8", "7", "6", "5", "4", "3", "2", "1"],
  );
  assert.deepEqual(lanesOf(graph), { "8": 1, "7": 0, "6": 2, "5": 1, "4": 1, "3": 0, "2": 0, "1": 0 });
  assert.equal(graph.lanes, 3);
  assert.deepEqual(
    graph.branches.map((b) => [b.ref.name, b.color, b.history.map((s) => s.snapshot_id).join(",")]),
    [
      ["main", BRANCH_COLORS[0], "1,2,3,7"],
      ["audit", BRANCH_COLORS[1], "1,2,4,5,8"],
    ],
  );

  const row = (id: string) => graph.rows.find((r) => r.snapshot.snapshot_id === id)!;
  // The rolled-back snapshot is on no branch and joins main at 3.
  assert.deepEqual(row("6").branches, []);
  assert.equal(row("6").color, OFF_BRANCH_COLOR);
  assert.ok(row("3").segments.some((s) => s.x1 === 2 && s.y1 === 0 && s.x2 === 0 && s.y2 === 0.5));
  // audit joins main at the fork point 2, which belongs to both.
  assert.ok(row("2").segments.some((s) => s.x1 === 1 && s.y1 === 0 && s.x2 === 0 && s.y2 === 0.5));
  assert.deepEqual(row("2").branches, ["main", "audit"]);
  assert.equal(row("2").color, BRANCH_COLORS[0]);
  assert.deepEqual(row("2").refs.map((r) => r.name), ["v1"]);
  // Main passes straight through the audit rows.
  assert.ok(row("5").segments.some((s) => s.x1 === 0 && s.x2 === 0 && s.y1 === 0 && s.y2 === 1));
  assert.equal(publishLag(graph, graph.branches[0]), undefined);
});

test("a branch tip on another branch's line gets a label, not a lane", () => {
  const graph = snapshotGraph(branchy, [...branchyRefs, branch("dev", 1)]);
  assert.equal(graph.lanes, 3);
  assert.deepEqual(graph.rows.at(-1)!.refs.map((r) => r.name), ["dev"]);
  assert.equal(graph.rows.at(-1)!.lane, 0);
});

test("a rolled-back main keeps lane 0 even when a newer orphan reaches its tip first", () => {
  const graph = snapshotGraph([snap(1), snap(2, 1), snap(3, 2)], [branch("main", 2)]);
  assert.deepEqual(lanesOf(graph), { "3": 1, "2": 0, "1": 0 });
  assert.equal(graph.rows[0].color, OFF_BRANCH_COLOR);
});

// RisingWave copy-on-write (shape from a real RisingWave 3.2 sink): appends
// and compactions on `ingestion`, overwrites on `main` published from it.
const cow = [
  snap(1),
  snap(2, 1),
  snap(3, 2, "replace"),
  snap(4, undefined, "overwrite", 2),
  snap(5, 3),
  snap(6, 5),
  snap(7, 6, "replace"),
  snap(8, 4, "overwrite", 5),
  snap(9, 7),
  snap(10, 9),
];
const cowRefs = [branch("ingestion", 10), branch("main", 8)];

test("copy-on-write publishes draw a dashed edge into the ingestion line", () => {
  const graph = snapshotGraph(cow, cowRefs);
  assert.deepEqual(graph.branches.map((b) => b.ref.name), ["main", "ingestion"]);
  assert.deepEqual(lanesOf(graph), {
    "10": 1, "9": 1, "8": 0, "7": 1, "6": 1, "5": 1, "4": 0, "3": 1, "2": 1, "1": 1,
  });
  const row = (id: string) => graph.rows.find((r) => r.snapshot.snapshot_id === id)!;
  const dashed = row("8").segments.filter((s) => s.dashed);
  assert.deepEqual(dashed, [{ x1: 0, y1: 0.5, x2: 2, y2: 1, color: BRANCH_COLORS[1], dashed: true }]);
  assert.ok(row("6").segments.some((s) => s.dashed && s.x1 === 2 && s.x2 === 2));
  assert.ok(row("5").segments.some((s) => s.dashed && s.x1 === 2 && s.y1 === 0 && s.x2 === 1 && s.y2 === 0.5));
  // main's first publish has no parent; the line just ends.
  assert.equal(row("4").expiredParent, false);
  assert.equal(graph.lanes, 3);

  const lag = publishLag(graph, graph.branches[0])!;
  assert.equal(lag.publish.snapshot_id, "8");
  assert.equal(lag.source.snapshot_id, "5");
  assert.equal(lag.sourceBranch, "ingestion");
  // 6, 9 and 10 are commits; 7 is a compaction.
  assert.equal(lag.pending, 3);
  assert.equal(publishLag(graph, graph.branches[1]), undefined);
});

test("expired parents are flagged and clock skew does not break the order", () => {
  const skewed = [snap(5, 4), { ...snap(6, 5), timestamp_ms: 1 }, { ...snap(7, 6), sequence_number: 0 }];
  const graph = snapshotGraph(skewed, [branch("main", 7)]);
  assert.deepEqual(
    graph.rows.map((row) => row.snapshot.snapshot_id),
    ["7", "6", "5"],
  );
  assert.equal(graph.rows[2].expiredParent, true);
  assert.equal(graph.lanes, 1);
});
