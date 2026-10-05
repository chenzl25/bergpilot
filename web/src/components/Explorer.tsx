import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink } from "react-router";

import { api } from "../api/client";
import type { CatalogSummary } from "../api/generated/CatalogSummary";
import { namespacePath, tablePath } from "../format";
import { errorMessage } from "./Layout";

/** Catalog → namespace → table tree. Levels load when expanded. */
export function Explorer() {
  const catalogs = useQuery({ queryKey: ["catalogs"], queryFn: api.listCatalogs });

  return (
    <div className="explorer">
      <div className="explorer-header">
        <span>Explorer</span>
        <Link to="/catalogs/new" className="icon-link" title="Add a catalog">
          + Add
        </Link>
      </div>
      {catalogs.isPending && <p className="muted pad">Loading…</p>}
      {catalogs.isError && <p className="error pad">{errorMessage(catalogs.error)}</p>}
      {catalogs.data?.length === 0 && <p className="muted pad">No catalogs yet.</p>}
      <ul className="tree">
        {catalogs.data?.map((catalog) => (
          <CatalogNode key={catalog.id} catalog={catalog} />
        ))}
      </ul>
    </div>
  );
}

function CatalogNode({ catalog }: { catalog: CatalogSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <TreeRow
        open={open}
        onToggle={() => setOpen(!open)}
        label={catalog.name}
        kind="catalog"
        to={`/catalogs/${catalog.id}`}
      />
      {open && <NamespaceChildren catalogId={catalog.id} parent={[]} />}
    </li>
  );
}

function NamespaceChildren({ catalogId, parent }: { catalogId: number; parent: string[] }) {
  const namespaces = useQuery({
    queryKey: ["namespaces", catalogId, parent],
    queryFn: () => api.namespaces(catalogId, parent),
  });
  const tables = useQuery({
    queryKey: ["tables", catalogId, parent],
    queryFn: () => api.tables(catalogId, parent),
    enabled: parent.length > 0,
  });

  if (namespaces.isPending || (parent.length > 0 && tables.isPending)) {
    return <p className="muted tree-note">Loading…</p>;
  }
  const error = namespaces.error ?? tables.error;
  if (error) return <p className="error tree-note">{errorMessage(error)}</p>;

  const childNamespaces = namespaces.data?.namespaces ?? [];
  const tableNames = tables.data?.tables ?? [];
  if (childNamespaces.length === 0 && tableNames.length === 0) {
    return <p className="muted tree-note">Empty</p>;
  }
  return (
    <ul className="tree">
      {childNamespaces.map((levels) => (
        <NamespaceNode key={levels.join("\u001f")} catalogId={catalogId} levels={levels} />
      ))}
      {tableNames.map((name) => (
        <li key={name}>
          <NavLink className="tree-row tree-leaf" to={tablePath(catalogId, parent, name)}>
            <span className="tree-icon table-icon" />
            {name}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function NamespaceNode({ catalogId, levels }: { catalogId: number; levels: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <TreeRow
        open={open}
        onToggle={() => setOpen(!open)}
        label={levels[levels.length - 1]}
        kind="namespace"
        to={namespacePath(catalogId, levels)}
      />
      {open && <NamespaceChildren catalogId={catalogId} parent={levels} />}
    </li>
  );
}

/** A folder row: the chevron expands it, the name opens its page. */
function TreeRow(props: {
  open: boolean;
  onToggle: () => void;
  label: string;
  kind: "catalog" | "namespace";
  to: string;
}) {
  return (
    <div className="tree-row tree-folder">
      <button
        className="chevron-button"
        onClick={props.onToggle}
        aria-expanded={props.open}
        aria-label={`${props.open ? "Collapse" : "Expand"} ${props.label}`}
      >
        <span className={`chevron ${props.open ? "open" : ""}`}>▸</span>
      </button>
      <NavLink className="tree-label" to={props.to} end onClick={() => !props.open && props.onToggle()}>
        <span className={`tree-icon ${props.kind}-icon`} />
        {props.label}
      </NavLink>
    </div>
  );
}
