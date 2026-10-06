// Catalog → namespace → table tree in the sidebar. Levels load when expanded.

import { type ComponentType, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Database, Folder, FolderOpen, Table2 } from "lucide-react";
import { NavLink, useLocation } from "react-router";

import { api } from "@/api/client";
import type { CatalogSummary } from "@/api/generated/CatalogSummary";
import { Skeleton } from "@/components/ui/skeleton";
import { namespacePath, splatSegments, tablePath } from "@/format";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

/** The catalog and namespace the current page is about, if any. */
function useRouteTarget(): { catalogId: number; namespace: string[] } | null {
  const { pathname } = useLocation();
  const match = pathname.match(/^\/catalogs\/(\d+)(?:\/(namespaces|tables)\/(.*))?$/);
  if (!match) return null;
  const segments = splatSegments(match[3]);
  return {
    catalogId: Number(match[1]),
    namespace: match[2] === "tables" ? segments.slice(0, -1) : segments,
  };
}

/** Open a node when the current page is inside it. */
function useOpenOnPath(onPath: boolean) {
  const [open, setOpen] = useState(onPath);
  useEffect(() => {
    if (onPath) setOpen(true);
  }, [onPath]);
  return [open, setOpen] as const;
}

export function Explorer() {
  const catalogs = useQuery({ queryKey: ["catalogs"], queryFn: api.listCatalogs });
  if (catalogs.isPending) return <TreeSkeleton depth={0} />;
  if (catalogs.isError) return <TreeNote depth={0} error>{errorMessage(catalogs.error)}</TreeNote>;
  if (catalogs.data.length === 0) return <TreeNote depth={0}>No catalogs yet.</TreeNote>;
  return (
    <ul className="flex flex-col gap-px" aria-label="Explorer">
      {catalogs.data.map((catalog) => (
        <CatalogNode key={catalog.id} catalog={catalog} />
      ))}
    </ul>
  );
}

function CatalogNode({ catalog }: { catalog: CatalogSummary }) {
  const target = useRouteTarget();
  const [open, setOpen] = useOpenOnPath(target?.catalogId === catalog.id);
  return (
    <li>
      <TreeRow
        depth={0}
        open={open}
        onToggle={() => setOpen(!open)}
        label={catalog.name}
        icon={Database}
        to={`/catalogs/${catalog.id}`}
      />
      {open && <NamespaceChildren catalogId={catalog.id} parent={[]} depth={1} />}
    </li>
  );
}

function NamespaceChildren({ catalogId, parent, depth }: { catalogId: number; parent: string[]; depth: number }) {
  const namespaces = useQuery({
    queryKey: ["namespaces", catalogId, parent],
    queryFn: () => api.namespaces(catalogId, parent),
  });
  const tables = useQuery({
    queryKey: ["tables", catalogId, parent],
    queryFn: () => api.tables(catalogId, parent),
    enabled: parent.length > 0,
  });

  if (namespaces.isPending || (parent.length > 0 && tables.isPending)) return <TreeSkeleton depth={depth} />;
  const error = namespaces.error ?? tables.error;
  if (error) return <TreeNote depth={depth} error>{errorMessage(error)}</TreeNote>;

  const childNamespaces = namespaces.data?.namespaces ?? [];
  const tableNames = tables.data?.tables ?? [];
  if (childNamespaces.length === 0 && tableNames.length === 0) return <TreeNote depth={depth}>Empty</TreeNote>;
  return (
    <ul className="flex flex-col gap-px">
      {childNamespaces.map((levels) => (
        <NamespaceNode key={levels.join("\u001f")} catalogId={catalogId} levels={levels} depth={depth} />
      ))}
      {tableNames.map((name) => (
        <li key={name}>
          <NavLink
            to={tablePath(catalogId, parent, name)}
            className={({ isActive }) => rowClass(isActive)}
            style={indent(depth)}
          >
            <span className="size-5 shrink-0" />
            <Table2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{name}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function NamespaceNode({ catalogId, levels, depth }: { catalogId: number; levels: string[]; depth: number }) {
  const target = useRouteTarget();
  const onPath =
    target?.catalogId === catalogId &&
    target.namespace.length >= levels.length &&
    levels.every((level, index) => target.namespace[index] === level);
  const [open, setOpen] = useOpenOnPath(onPath);
  return (
    <li>
      <TreeRow
        depth={depth}
        open={open}
        onToggle={() => setOpen(!open)}
        label={levels[levels.length - 1]}
        icon={open ? FolderOpen : Folder}
        to={namespacePath(catalogId, levels)}
      />
      {open && <NamespaceChildren catalogId={catalogId} parent={levels} depth={depth + 1} />}
    </li>
  );
}

const indent = (depth: number) => ({ paddingLeft: `${4 + depth * 14}px` });

function rowClass(active: boolean) {
  return cn(
    "flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-sm text-sidebar-foreground outline-hidden ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2",
    active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
  );
}

/** A folder row: the chevron expands it, the name opens its page. */
function TreeRow(props: {
  depth: number;
  open: boolean;
  onToggle: () => void;
  label: string;
  icon: ComponentType<{ className?: string }>;
  to: string;
}) {
  return (
    <div
      className={cn(
        rowClass(false),
        "has-[a[aria-current=page]]:bg-sidebar-accent has-[a[aria-current=page]]:font-medium has-[a[aria-current=page]]:text-sidebar-accent-foreground has-[:focus-visible]:ring-2",
      )}
      style={indent(props.depth)}
    >
      <button
        type="button"
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-hidden hover:bg-sidebar-border/60 hover:text-foreground"
        onClick={props.onToggle}
        aria-expanded={props.open}
        aria-label={`${props.open ? "Collapse" : "Expand"} ${props.label}`}
      >
        <ChevronRight className={cn("size-3.5 transition-transform", props.open && "rotate-90")} />
      </button>
      <NavLink
        to={props.to}
        end
        className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch outline-hidden"
        onClick={() => !props.open && props.onToggle()}
      >
        <props.icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{props.label}</span>
      </NavLink>
    </div>
  );
}

function TreeNote({ depth, error, children }: { depth: number; error?: boolean; children: string }) {
  return (
    <p
      className={cn("py-1 pr-2 text-xs", error ? "text-destructive" : "text-muted-foreground")}
      style={{ paddingLeft: `${4 + depth * 14 + 26}px` }}
    >
      {children}
    </p>
  );
}

function TreeSkeleton({ depth }: { depth: number }) {
  return (
    <div className="flex flex-col gap-1.5 py-1 pr-2" style={{ paddingLeft: `${4 + depth * 14 + 26}px` }}>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}
