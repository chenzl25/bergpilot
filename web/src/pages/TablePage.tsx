import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";

import { api } from "../api/client";
import type { FileStats } from "../api/generated/FileStats";
import type { TableDetail } from "../api/generated/TableDetail";
import { errorMessage } from "../components/Layout";
import { MaintenanceTab } from "../components/MaintenanceTab";
import { TrendChart } from "../components/TrendChart";
import { formatAge, formatBytes, formatNumber, formatTime, sqlTableName } from "../format";

const TABS = ["overview", "schema", "snapshots", "files", "maintenance"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  schema: "Schema",
  snapshots: "Snapshots",
  files: "Files",
  maintenance: "Maintenance",
};

export function TablePage() {
  const params = useParams();
  const catalogId = Number(params.id);
  const segments = (params["*"] ?? "").split("/").filter(Boolean).map(decodeURIComponent);
  const name = segments[segments.length - 1] ?? "";
  const namespace = segments.slice(0, -1);
  const [search, setSearch] = useSearchParams();
  const tab: Tab = TABS.includes(search.get("tab") as Tab) ? (search.get("tab") as Tab) : "overview";

  const table = useQuery({
    queryKey: ["table", catalogId, namespace, name],
    queryFn: () => api.table(catalogId, namespace, name),
    enabled: namespace.length > 0 && name !== "",
  });

  if (namespace.length === 0) return <p className="error">Not a table path.</p>;
  if (table.isPending) return <p className="muted">Loading {name}…</p>;
  if (table.isError) return <p className="error">{errorMessage(table.error)}</p>;
  const detail = table.data;
  const sql = `SELECT * FROM ${sqlTableName(detail.catalog, namespace, name)} LIMIT 100`;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            {detail.catalog} / {namespace.join(" / ")}
          </div>
          <h1>{name}</h1>
        </div>
        <Link className="button secondary" to={`/sql?q=${encodeURIComponent(sql)}`}>
          Query
        </Link>
      </div>
      <div className="tabs">
        {TABS.map((item) => (
          <button
            key={item}
            className={item === tab ? "active" : ""}
            onClick={() => setSearch(item === "overview" ? {} : { tab: item }, { replace: true })}
          >
            {TAB_LABELS[item]}
            {item === "snapshots" && <span className="count">{detail.snapshots.length}</span>}
          </button>
        ))}
      </div>
      {tab === "overview" && <Overview detail={detail} />}
      {tab === "schema" && <SchemaTab detail={detail} />}
      {tab === "snapshots" && <SnapshotsTab detail={detail} />}
      {tab === "files" && <FilesTab detail={detail} catalogId={catalogId} namespace={namespace} />}
      {tab === "maintenance" && (
        <MaintenanceTab target={{ catalog_id: catalogId, namespace, table: name }} detail={detail} />
      )}
    </div>
  );
}

function Overview({ detail }: { detail: TableDetail }) {
  const current = detail.snapshots.find((s) => s.snapshot_id === detail.current_snapshot_id);
  const summary = current?.summary ?? {};
  return (
    <div className="overview">
      <div className="stats">
        <Stat label="Records" value={formatNumber(summary["total-records"])} />
        <Stat label="Data files" value={formatNumber(summary["total-data-files"])} />
        <Stat
          label="Data size"
          value={summary["total-files-size"] ? formatBytes(Number(summary["total-files-size"])) : "—"}
        />
        <Stat label="Delete files" value={formatNumber(summary["total-delete-files"])} />
        <Stat label="Snapshots" value={formatNumber(detail.snapshots.length)} />
        <Stat label="Last updated" value={formatAge(detail.last_updated_ms)} title={formatTime(detail.last_updated_ms)} />
      </div>
      <dl className="facts">
        <dt>Location</dt>
        <dd className="mono">{detail.location}</dd>
        <dt>Metadata file</dt>
        <dd className="mono">{detail.metadata_location ?? "—"}</dd>
        <dt>Format version</dt>
        <dd>v{detail.format_version}</dd>
        <dt>Table UUID</dt>
        <dd className="mono">{detail.uuid}</dd>
        <dt>Current snapshot</dt>
        <dd className="mono">{detail.current_snapshot_id ?? "None (empty table)"}</dd>
        <dt>Partitioned by</dt>
        <dd>
          {detail.partition_fields.length === 0
            ? "Not partitioned"
            : detail.partition_fields.map((f) => `${f.transform}(${f.source})`).join(", ")}
        </dd>
        <dt>Sorted by</dt>
        <dd>
          {detail.sort_fields.length === 0
            ? "Unsorted"
            : detail.sort_fields
                .map((f) => `${f.transform === "identity" ? f.source : `${f.transform}(${f.source})`} ${f.direction} ${f.null_order}`)
                .join(", ")}
        </dd>
        <dt>Branches and tags</dt>
        <dd>
          {detail.refs.length === 0
            ? "—"
            : detail.refs.map((r) => (
                <span key={r.name} className={`badge ${r.kind}`}>
                  {r.name}
                </span>
              ))}
        </dd>
      </dl>
      <h2>Properties</h2>
      {Object.keys(detail.properties).length === 0 ? (
        <p className="muted">No properties.</p>
      ) : (
        <table className="grid compact">
          <tbody>
            {Object.entries(detail.properties).map(([key, value]) => (
              <tr key={key}>
                <td className="mono">{key}</td>
                <td className="mono">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="stat" title={title}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function SchemaTab({ detail }: { detail: TableDetail }) {
  return (
    <table className="grid">
      <thead>
        <tr>
          <th className="right">ID</th>
          <th>Column</th>
          <th>Type</th>
          <th>Required</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {detail.schema.map((field) => (
          <tr key={field.id}>
            <td className="right muted">{field.id}</td>
            <td className="mono" style={{ paddingLeft: `${12 + field.depth * 18}px` }}>
              {field.name}
            </td>
            <td className="mono">{field.type}</td>
            <td>{field.required ? "Yes" : ""}</td>
            <td className="muted">{field.doc ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SnapshotsTab({ detail }: { detail: TableDetail }) {
  const refsBySnapshot = new Map<string, string[]>();
  for (const ref of detail.refs) {
    refsBySnapshot.set(ref.snapshot_id, [...(refsBySnapshot.get(ref.snapshot_id) ?? []), ref.name]);
  }
  const newestFirst = [...detail.snapshots].reverse();
  if (newestFirst.length === 0) return <p className="muted">This table has no snapshots yet.</p>;
  return (
    <>
    <TrendChart snapshots={detail.snapshots} />
    <table className="grid">
      <thead>
        <tr>
          <th>Committed</th>
          <th>Snapshot</th>
          <th>Operation</th>
          <th className="right">Files added</th>
          <th className="right">Files removed</th>
          <th className="right">Records added</th>
          <th className="right">Records removed</th>
          <th className="right">Total records</th>
        </tr>
      </thead>
      <tbody>
        {newestFirst.map((snapshot) => {
          const s = snapshot.summary;
          const added = Number(s["added-data-files"] ?? 0) + Number(s["added-delete-files"] ?? 0);
          const removed = Number(s["deleted-data-files"] ?? 0) + Number(s["removed-delete-files"] ?? 0);
          return (
            <tr key={snapshot.snapshot_id}>
              <td className="nowrap">{formatTime(snapshot.timestamp_ms)}</td>
              <td className="mono">
                {snapshot.snapshot_id}
                {snapshot.snapshot_id === detail.current_snapshot_id && <span className="badge current">current</span>}
                {(refsBySnapshot.get(snapshot.snapshot_id) ?? [])
                  .filter((name) => name !== "main")
                  .map((name) => (
                    <span key={name} className="badge branch">
                      {name}
                    </span>
                  ))}
              </td>
              <td>
                <span className={`op op-${snapshot.operation}`}>{snapshot.operation}</span>
              </td>
              <td className="right">{added ? formatNumber(added) : ""}</td>
              <td className="right">{removed ? formatNumber(removed) : ""}</td>
              <td className="right">{s["added-records"] ? formatNumber(s["added-records"]) : ""}</td>
              <td className="right">{s["deleted-records"] ? formatNumber(s["deleted-records"]) : ""}</td>
              <td className="right">{formatNumber(s["total-records"])}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </>
  );
}

function FilesTab(props: { detail: TableDetail; catalogId: number; namespace: string[] }) {
  const { detail, catalogId, namespace } = props;
  const [snapshotId, setSnapshotId] = useState<string | undefined>(undefined);
  const files = useQuery({
    queryKey: ["files", catalogId, namespace, detail.name, snapshotId ?? detail.current_snapshot_id],
    queryFn: () => api.files(catalogId, namespace, detail.name, snapshotId),
  });
  const newestFirst = [...detail.snapshots].reverse();

  return (
    <div>
      {newestFirst.length > 1 && (
        <label className="inline">
          <span>Snapshot</span>
          <select value={snapshotId ?? ""} onChange={(event) => setSnapshotId(event.target.value || undefined)}>
            <option value="">Current</option>
            {newestFirst.map((snapshot) => (
              <option key={snapshot.snapshot_id} value={snapshot.snapshot_id}>
                {formatTime(snapshot.timestamp_ms)} · {snapshot.operation} · {snapshot.snapshot_id}
              </option>
            ))}
          </select>
        </label>
      )}
      {files.isPending && <p className="muted">Reading manifests…</p>}
      {files.isError && <p className="error">{errorMessage(files.error)}</p>}
      {files.data && <FileStatsView stats={files.data} />}
      {detail.partition_fields.length > 0 && snapshotId === undefined && (
        <Partitions catalogId={catalogId} namespace={namespace} name={detail.name} />
      )}
    </div>
  );
}

const PARTITION_ROWS = 200;

function Partitions(props: { catalogId: number; namespace: string[]; name: string }) {
  const partitions = useQuery({
    queryKey: ["partitions", props.catalogId, props.namespace, props.name],
    queryFn: () => api.partitions(props.catalogId, props.namespace, props.name),
  });
  const [sort, setSort] = useState<"size" | "name">("size");
  if (partitions.isPending) return <p className="muted">Reading partitions…</p>;
  if (partitions.isError) return <p className="error">{errorMessage(partitions.error)}</p>;
  const rows = [...partitions.data].sort((a, b) =>
    sort === "size" ? b.data_bytes - a.data_bytes : a.partition.localeCompare(b.partition),
  );
  const largest = Math.max(1, ...rows.map((row) => row.data_bytes));
  const total = rows.reduce((sum, row) => sum + row.data_bytes, 0);
  return (
    <div>
      <div className="section-header">
        <h2>Partitions ({formatNumber(rows.length)})</h2>
        <div className="segmented small-segmented">
          <button className={sort === "size" ? "active" : ""} onClick={() => setSort("size")}>
            Largest first
          </button>
          <button className={sort === "name" ? "active" : ""} onClick={() => setSort("name")}>
            By name
          </button>
        </div>
      </div>
      <table className="grid compact">
        <thead>
          <tr>
            <th>Partition</th>
            <th className="right">Records</th>
            <th className="right">Data files</th>
            <th className="right">Data size</th>
            <th>Share of data</th>
            <th className="right">Avg file</th>
            <th className="right">Delete files</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, PARTITION_ROWS).map((row) => (
            <tr key={row.partition}>
              <td className="mono">{row.partition || "(unpartitioned)"}</td>
              <td className="right">{formatNumber(row.record_count)}</td>
              <td className="right">{formatNumber(row.data_files)}</td>
              <td className="right">{formatBytes(row.data_bytes)}</td>
              <td className="share-cell">
                <div className="share-bar" style={{ width: `${Math.max(1, (row.data_bytes / largest) * 110)}px` }} />
                <span className="muted small">{total ? `${((row.data_bytes / total) * 100).toFixed(1)}%` : ""}</span>
              </td>
              <td className="right">{row.data_files ? formatBytes(row.data_bytes / row.data_files) : "—"}</td>
              <td className="right">{row.delete_files ? formatNumber(row.delete_files) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > PARTITION_ROWS && (
        <p className="muted small">
          Showing {PARTITION_ROWS} of {formatNumber(rows.length)}. Query{" "}
          <code>"{props.name}$partitions"</code> in SQL for all of them.
        </p>
      )}
    </div>
  );
}

function FileStatsView({ stats }: { stats: FileStats }) {
  if (!stats.snapshot_id) return <p className="muted">This table has no snapshots yet.</p>;
  const deletes = stats.position_deletes.files + stats.equality_deletes.files;
  const max = Math.max(1, ...stats.buckets.map((b) => b.data_files + b.delete_files));
  const small = stats.buckets[0]?.data_files ?? 0;
  const average = stats.data.files ? stats.data.bytes / stats.data.files : 0;
  return (
    <div className="files">
      <div className="stats">
        <Stat label="Data files" value={formatNumber(stats.data.files)} />
        <Stat label="Data size" value={formatBytes(stats.data.bytes)} />
        <Stat label="Average data file" value={stats.data.files ? formatBytes(average) : "—"} />
        <Stat label="Records" value={formatNumber(stats.data.records)} />
        <Stat label="Delete files" value={formatNumber(deletes)} />
        <Stat label="Manifests" value={formatNumber(stats.manifests)} />
      </div>
      {stats.data.files > 0 && (
        <p className="muted">
          {formatNumber(small)} of {formatNumber(stats.data.files)} data files are smaller than 8 MiB.
        </p>
      )}
      <h2>Files by size</h2>
      <div className="histogram">
        {stats.buckets.map((bucket) => (
          <div className="histogram-row" key={bucket.label}>
            <span className="histogram-label">{bucket.label}</span>
            <div className="histogram-bar">
              <div className="bar data" style={{ width: `${(bucket.data_files / max) * 100}%` }} />
              <div className="bar deletes" style={{ width: `${(bucket.delete_files / max) * 100}%` }} />
            </div>
            <span className="histogram-count">
              {formatNumber(bucket.data_files)}
              {bucket.delete_files > 0 && <span className="muted"> + {formatNumber(bucket.delete_files)} deletes</span>}
            </span>
          </div>
        ))}
      </div>
      <div className="legend">
        <span>
          <i className="swatch data" /> Data files
        </span>
        <span>
          <i className="swatch deletes" /> Delete files
        </span>
      </div>
      {deletes > 0 && (
        <table className="grid compact">
          <thead>
            <tr>
              <th>Delete files</th>
              <th className="right">Files</th>
              <th className="right">Size</th>
              <th className="right">Records</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Position deletes</td>
              <td className="right">{formatNumber(stats.position_deletes.files)}</td>
              <td className="right">{formatBytes(stats.position_deletes.bytes)}</td>
              <td className="right">{formatNumber(stats.position_deletes.records)}</td>
            </tr>
            <tr>
              <td>Equality deletes</td>
              <td className="right">{formatNumber(stats.equality_deletes.files)}</td>
              <td className="right">{formatBytes(stats.equality_deletes.bytes)}</td>
              <td className="right">{formatNumber(stats.equality_deletes.records)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
