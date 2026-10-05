import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import type { TableDetail } from "../api/generated/TableDetail";
import type { TableRef } from "../api/generated/TableRef";
import { errorMessage } from "./Layout";

type Row = { key: string; value: string; original?: string };

/** Table properties, with an edit mode that commits all changes at once. */
export function PropertiesEditor({ detail, target }: { detail: TableDetail; target: TableRef }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const entries = Object.entries(detail.properties) as [string, string][];

  const start = () => {
    setRows(entries.map(([key, value]) => ({ key, value, original: key })));
    setEditing(true);
  };
  const save = useMutation({
    mutationFn: () => {
      const set: Record<string, string> = {};
      const kept = new Set<string>();
      for (const row of rows) {
        const key = row.key.trim();
        if (!key) continue;
        kept.add(key);
        if (detail.properties[key] !== row.value) set[key] = row.value;
      }
      const remove = entries.map(([key]) => key).filter((key) => !kept.has(key));
      return api.updateProperties({ ...target, set, remove });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["table", target.catalog_id, target.namespace, target.table], updated);
      setEditing(false);
    },
  });

  if (!editing) {
    return (
      <>
        <div className="section-header">
          <h2>Properties</h2>
          <button className="link" onClick={start}>
            Edit
          </button>
        </div>
        {entries.length === 0 ? (
          <p className="muted">No properties.</p>
        ) : (
          <table className="grid compact">
            <tbody>
              {entries.map(([key, value]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td className="mono">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  }

  return (
    <>
      <div className="section-header">
        <h2>Properties</h2>
      </div>
      <div className="properties-editor">
        {rows.map((row, index) => (
          <div className="kv-row" key={index}>
            <input
              className="mono"
              value={row.key}
              placeholder="property"
              onChange={(event) => setRows(rows.map((r, i) => (i === index ? { ...r, key: event.target.value } : r)))}
            />
            <input
              className="mono"
              value={row.value}
              placeholder="value"
              onChange={(event) => setRows(rows.map((r, i) => (i === index ? { ...r, value: event.target.value } : r)))}
            />
            <button className="link" onClick={() => setRows(rows.filter((_, i) => i !== index))}>
              Remove
            </button>
          </div>
        ))}
        <div className="actions">
          <button className="secondary" onClick={() => setRows([...rows, { key: "", value: "" }])}>
            Add property
          </button>
          <button
            className="primary"
            disabled={save.isPending}
            onClick={() => {
              if (confirm("Commit these property changes to the table?")) save.mutate();
            }}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button className="link" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
        {save.isError && <div className="notice bad">{errorMessage(save.error)}</div>}
        <p className="muted small">
          Changes are one commit to the table metadata; data files are untouched. Engines read some
          properties (for example write.target-file-size-bytes) on their next write.
        </p>
      </div>
    </>
  );
}
