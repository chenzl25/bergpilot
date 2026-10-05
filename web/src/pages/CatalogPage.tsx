import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";

import { api } from "../api/client";
import { errorMessage } from "../components/Layout";
import { namespacePath } from "../format";
import { LAYOUTS } from "./catalogFields";

export function CatalogPage() {
  const params = useParams();
  const id = Number(params.id);
  const catalog = useQuery({ queryKey: ["catalog", id], queryFn: () => api.getCatalog(id) });
  const namespaces = useQuery({ queryKey: ["namespaces", id, []], queryFn: () => api.namespaces(id, []) });

  if (catalog.isPending) return <p className="muted">Loading…</p>;
  if (catalog.isError) return <p className="error">{errorMessage(catalog.error)}</p>;
  const data = catalog.data;
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb">{LAYOUTS[data.kind].label} catalog</div>
          <h1>{data.name}</h1>
        </div>
        <Link className="button secondary" to={`/catalogs/${id}/edit`}>
          Edit connection
        </Link>
      </div>
      <h2>Namespaces</h2>
      {namespaces.isPending && <p className="muted">Loading…</p>}
      {namespaces.isError && <p className="error">{errorMessage(namespaces.error)}</p>}
      {namespaces.data?.namespaces.length === 0 && <p className="muted">No namespaces.</p>}
      <div className="chips">
        {namespaces.data?.namespaces.map((levels) => (
          <Link key={levels.join("\u001f")} className="chip" to={namespacePath(id, levels)}>
            {levels[levels.length - 1]}
          </Link>
        ))}
      </div>
      <h2>Connection</h2>
      <table className="grid compact">
        <tbody>
          {Object.entries(data.properties).map(([key, value]) => (
            <tr key={key}>
              <td className="mono">{key}</td>
              <td className="mono">{value}</td>
            </tr>
          ))}
          {data.secret_keys.map((key) => (
            <tr key={key}>
              <td className="mono">{key}</td>
              <td className="muted">stored encrypted</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
