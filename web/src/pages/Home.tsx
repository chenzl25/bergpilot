import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { api } from "../api/client";
import { errorMessage } from "../components/Layout";

export function HomePage() {
  const catalogs = useQuery({ queryKey: ["catalogs"], queryFn: api.listCatalogs });

  if (catalogs.isPending) return <p className="muted">Loading…</p>;
  if (catalogs.isError) return <p className="error">{errorMessage(catalogs.error)}</p>;

  if (catalogs.data.length === 0) {
    return (
      <div className="empty-state">
        <h1>Connect your first catalog</h1>
        <p className="muted">
          BergPilot reads Apache Iceberg tables through their catalog. Add a REST catalog to
          browse its namespaces and tables, inspect snapshots and files, and run SQL.
        </p>
        <Link to="/catalogs/new" className="button primary">
          Add a catalog
        </Link>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Catalogs</h1>
        <Link to="/catalogs/new" className="button primary">
          Add a catalog
        </Link>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>URI</th>
            <th>Warehouse</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {catalogs.data.map((catalog) => (
            <tr key={catalog.id}>
              <td className="strong">{catalog.name}</td>
              <td>{catalog.kind.toUpperCase()}</td>
              <td className="mono">{catalog.properties.uri ?? "—"}</td>
              <td className="mono">{catalog.properties.warehouse ?? "—"}</td>
              <td className="right">
                <Link to={`/catalogs/${catalog.id}/edit`}>Edit</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Expand a catalog in the explorer on the left to browse its tables.</p>
    </div>
  );
}
