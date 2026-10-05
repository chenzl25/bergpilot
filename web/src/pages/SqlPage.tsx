import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import CodeMirror, { keymap, Prec } from "@uiw/react-codemirror";
import { sql as sqlLanguage } from "@codemirror/lang-sql";
import { useSearchParams } from "react-router";

import { api } from "../api/client";
import type { QueryResult } from "../api/generated/QueryResult";
import { errorMessage } from "../components/Layout";
import { formatNumber } from "../format";

const STORAGE_KEY = "bergpilot.sql";
const DEFAULT_SQL = "-- Tables are named catalog.namespace.table\nSELECT 1 AS ok";

export function SqlPage() {
  const [search, setSearch] = useSearchParams();
  const [text, setText] = useState(() => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_SQL);

  // "Query" buttons elsewhere open this page with ?q=.
  useEffect(() => {
    const q = search.get("q");
    if (q) {
      setText(q);
      setSearch({}, { replace: true });
    }
  }, [search, setSearch]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, text);
  }, [text]);

  const run = useMutation({ mutationFn: (statement: string) => api.query(statement) });
  const execute = useCallback(() => {
    if (text.trim() && !run.isPending) run.mutate(text);
  }, [run, text]);

  const extensions = useMemo(
    () => [
      sqlLanguage(),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              execute();
              return true;
            },
          },
        ]),
      ),
    ],
    [execute],
  );

  return (
    <div className="page sql-page">
      <div className="page-header">
        <h1>SQL</h1>
        <div className="actions">
          <span className="muted small">Read-only · ⌘/Ctrl + Enter to run</span>
          <button className="primary" onClick={execute} disabled={run.isPending}>
            {run.isPending ? "Running…" : "Run"}
          </button>
        </div>
      </div>
      <div className="editor">
        <CodeMirror value={text} height="220px" extensions={extensions} onChange={setText} />
      </div>
      {run.isError && <div className="notice bad mono">{errorMessage(run.error)}</div>}
      {run.data && <Results result={run.data} />}
    </div>
  );
}

function Results({ result }: { result: QueryResult }) {
  return (
    <div className="results">
      <div className="results-meta muted small">
        {formatNumber(result.rows.length)} row{result.rows.length === 1 ? "" : "s"}
        {result.truncated && " (more rows exist; showing the first ones)"} · {formatNumber(result.elapsed_ms)} ms
      </div>
      <div className="results-scroll">
        <table className="grid results-grid">
          <thead>
            <tr>
              <th className="row-number">#</th>
              {result.columns.map((column, index) => (
                <th key={index} title={column.type}>
                  {column.name}
                  <span className="column-type">{column.type}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <td className="row-number">{rowIndex + 1}</td>
                {row.map((value, index) => (
                  <td key={index} className="mono">
                    {value === null ? <span className="null">NULL</span> : value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
