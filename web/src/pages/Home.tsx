import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { api } from "../api/client";
import { errorMessage } from "../components/Layout";
import { LAYOUTS } from "./catalogFields";

export function HomePage() {
  const catalogs = useQuery({ queryKey: ["catalogs"], queryFn: api.listCatalogs });

  if (catalogs.isPending) return <p className="muted">Loading…</p>;
  if (catalogs.isError) return <p className="error">{errorMessage(catalogs.error)}</p>;

  if (catalogs.data.length === 0) {
    return (
      <div className="empty-state">
        <h1>Connect your first catalog</h1>
        <p className="muted">
          BergPilot works with Apache Iceberg tables through their catalog: REST, AWS Glue, S3
          Tables or JDBC. Browse namespaces and tables, inspect snapshots and files, run SQL, and
          keep tables healthy with compaction and cleanup.
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
            <th>Location</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {catalogs.data.map((catalog) => (
            <tr key={catalog.id}>
              <td className="strong">
                <Link to={`/catalogs/${catalog.id}`}>{catalog.name}</Link>
              </td>
              <td>{LAYOUTS[catalog.kind].label}</td>
              <td className="mono">
                {catalog.properties.uri ?? catalog.properties.table_bucket_arn ?? catalog.properties.warehouse ?? "—"}
              </td>
              <td className="right">
                <Link to={`/catalogs/${catalog.id}/edit`}>Edit</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Open a catalog to see its namespaces, or expand it in the explorer.</p>
    </div>
  );
}
