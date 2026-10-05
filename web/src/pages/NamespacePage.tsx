import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";

import { api } from "../api/client";
import type { TableSummary } from "../api/generated/TableSummary";
import { errorMessage } from "../components/Layout";
import {
  formatAge,
  formatBytes,
  formatNumber,
  formatTime,
  namespacePath,
  splatSegments,
  tablePath,
} from "../format";

const SMALL_FILE_BYTES = 32 * 1024 * 1024;

type SortKey = "name" | "records" | "data_bytes" | "data_files" | "avg" | "delete_files" | "snapshots" | "updated";

/** Facts worth a look, phrased as observations. */
function attention(table: TableSummary): string[] {
  const notes: string[] = [];
  const files = table.data_files ?? 0;
  if (files >= 16 && (table.data_bytes ?? 0) / files < SMALL_FILE_BYTES) notes.push("small files");
  if ((table.delete_files ?? 0) > 0) notes.push(`${formatNumber(table.delete_files)} delete files`);
  if (table.snapshots > 100) notes.push(`${formatNumber(table.snapshots)} snapshots`);
  return notes;
}

function value(table: TableSummary, key: SortKey): number | string {
  switch (key) {
    case "name":
      return table.name;
    case "avg":
      return table.data_files ? (table.data_bytes ?? 0) / table.data_files : -1;
    case "updated":
      return table.last_updated_ms ?? 0;
    default:
      return (table[key] as number | undefined) ?? -1;
  }
}

export function NamespacePage() {
  const params = useParams();
  const catalogId = Number(params.id);
  const namespace = splatSegments(params["*"]);
  const catalog = useQuery({ queryKey: ["catalog", catalogId], queryFn: () => api.getCatalog(catalogId) });
  const detail = useQuery({
    queryKey: ["namespace", catalogId, namespace],
    queryFn: () => api.namespace(catalogId, namespace),
    enabled: namespace.length > 0,
  });
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });

  if (detail.isPending) return <p className="muted">Loading {namespace.join(".")}…</p>;
  if (detail.isError) return <p className="error">{errorMessage(detail.error)}</p>;
  const data = detail.data;
  const tables = [...data.tables].sort((a, b) => {
    const [x, y] = [value(a, sort.key), value(b, sort.key)];
    const order = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
    return sort.desc ? -order : order;
  });
  const header = (key: SortKey, label: string, right = true) => (
    <th
      className={`sortable ${right ? "right" : ""}`}
      onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : key !== "name" })}
    >
      {label}
      {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
    </th>
  );
  const totals = data.tables.reduce(
    (sum, table) => ({
      records: sum.records + (table.records ?? 0),
      bytes: sum.bytes + (table.data_bytes ?? 0),
      files: sum.files + (table.data_files ?? 0),
    }),
    { records: 0, bytes: 0, files: 0 },
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <Link to={`/catalogs/${catalogId}`}>{catalog.data?.name ?? "catalog"}</Link>
            {data.namespace.slice(0, -1).map((_, index) => (
              <span key={index}>
                {" / "}
                <Link to={namespacePath(catalogId, data.namespace.slice(0, index + 1))}>
                  {data.namespace[index]}
                </Link>
              </span>
            ))}
          </div>
          <h1>{data.namespace[data.namespace.length - 1]}</h1>
        </div>
      </div>
      <div className="stats">
        <div className="stat">
          <div className="stat-value">{formatNumber(data.tables.length)}</div>
          <div className="stat-label">Tables{data.truncated ? " (first 500)" : ""}</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatNumber(totals.records)}</div>
          <div className="stat-label">Records</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatBytes(totals.bytes)}</div>
          <div className="stat-label">Data size</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatNumber(totals.files)}</div>
          <div className="stat-label">Data files</div>
        </div>
      </div>
      {data.child_namespaces.length > 0 && (
        <>
          <h2>Namespaces</h2>
          <div className="chips">
            {data.child_namespaces.map((levels) => (
              <Link key={levels.join("\u001f")} className="chip" to={namespacePath(catalogId, levels)}>
                {levels[levels.length - 1]}
              </Link>
            ))}
          </div>
        </>
      )}
      <h2>Tables</h2>
      {tables.length === 0 ? (
        <p className="muted">No tables.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              {header("name", "Table", false)}
              {header("records", "Records")}
              {header("data_bytes", "Data size")}
              {header("data_files", "Data files")}
              {header("avg", "Avg file")}
              {header("delete_files", "Delete files")}
              {header("snapshots", "Snapshots")}
              {header("updated", "Last updated")}
              <th>Worth a look</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((table) => (
              <tr key={table.name}>
                <td className="strong">
                  <Link to={tablePath(catalogId, data.namespace, table.name)}>{table.name}</Link>
                </td>
                {table.error ? (
                  <td colSpan={8} className="error">
                    {table.error}
                  </td>
                ) : (
                  <>
                    <td className="right">{formatNumber(table.records)}</td>
                    <td className="right">{table.data_bytes !== undefined ? formatBytes(table.data_bytes) : "—"}</td>
                    <td className="right">{formatNumber(table.data_files)}</td>
                    <td className="right">
                      {table.data_files ? formatBytes((table.data_bytes ?? 0) / table.data_files) : "—"}
                    </td>
                    <td className="right">{formatNumber(table.delete_files)}</td>
                    <td className="right">{formatNumber(table.snapshots)}</td>
                    <td className="nowrap" title={table.last_updated_ms ? formatTime(table.last_updated_ms) : ""}>
                      {table.last_updated_ms ? formatAge(table.last_updated_ms) : "—"}
                    </td>
                    <td>
                      {attention(table).map((note) => (
                        <Link
                          key={note}
                          className="badge attention"
                          to={`${tablePath(catalogId, data.namespace, table.name)}?tab=maintenance`}
                        >
                          {note}
                        </Link>
                      ))}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {Object.keys(data.properties).length > 0 && (
        <>
          <h2>Properties</h2>
          <table className="grid compact">
            <tbody>
              {Object.entries(data.properties).map(([key, val]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td className="mono">{val}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
