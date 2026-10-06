import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, Database, Files, Folder, FolderOpen, Rows3, Table2 } from "lucide-react";
import { Link, useParams } from "react-router";

import { api } from "@/api/client";
import type { TableSummary } from "@/api/generated/TableSummary";
import { ErrorNotice, FactList, Page, PageHeader, PageSkeleton, Panel, Section, Stat, StatGrid } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatAge, formatBytes, formatNumber, formatTime, namespacePath, splatSegments, tablePath } from "@/format";
import { attention } from "@/health";
import { cn } from "@/lib/utils";

type SortKey = "name" | "records" | "data_bytes" | "data_files" | "avg" | "delete_files" | "snapshots" | "updated";

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

  if (detail.isPending) return <PageSkeleton />;
  if (detail.isError) {
    return (
      <Page>
        <ErrorNotice title={`Cannot load ${namespace.join(".")}`} error={detail.error} />
      </Page>
    );
  }
  const data = detail.data;
  const tables = [...data.tables].sort((a, b) => {
    const [x, y] = [value(a, sort.key), value(b, sort.key)];
    const order = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
    return sort.desc ? -order : order;
  });
  const header = (key: SortKey, label: string, right = true) => {
    const active = sort.key === key;
    const Icon = active ? (sort.desc ? ArrowDown : ArrowUp) : ArrowUpDown;
    return (
      <TableHead className={cn(right && "text-right")}>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 hover:text-foreground",
            right && "flex-row-reverse",
            active ? "text-foreground" : "text-muted-foreground",
          )}
          onClick={() => setSort({ key, desc: active ? !sort.desc : key !== "name" })}
        >
          {label}
          <Icon className={cn("size-3.5", !active && "opacity-40")} />
        </button>
      </TableHead>
    );
  };
  const totals = data.tables.reduce(
    (sum, table) => ({
      records: sum.records + (table.records ?? 0),
      bytes: sum.bytes + (table.data_bytes ?? 0),
      files: sum.files + (table.data_files ?? 0),
    }),
    { records: 0, bytes: 0, files: 0 },
  );
  const path = `${catalog.data?.name ?? "…"}.${data.namespace.join(".")}`;

  return (
    <Page>
      <PageHeader
        icon={FolderOpen}
        title={data.namespace[data.namespace.length - 1]}
        meta={
          <>
            <span className="font-mono text-xs">{path}</span>
            <span>
              {formatNumber(data.tables.length)} table{data.tables.length === 1 ? "" : "s"}
              {data.truncated ? " (first 500)" : ""}
            </span>
          </>
        }
      />
      <StatGrid className="lg:grid-cols-4 xl:grid-cols-4">
        <Stat icon={Table2} label="Tables" value={formatNumber(data.tables.length)} />
        <Stat icon={Rows3} label="Records" value={formatNumber(totals.records)} />
        <Stat icon={Database} label="Data size" value={formatBytes(totals.bytes)} />
        <Stat icon={Files} label="Data files" value={formatNumber(totals.files)} />
      </StatGrid>
      {data.child_namespaces.length > 0 && (
        <Section title="Namespaces">
          <div className="flex flex-wrap gap-2">
            {data.child_namespaces.map((levels) => (
              <Button key={levels.join("\u001f")} variant="outline" size="sm" asChild>
                <Link to={namespacePath(catalogId, levels)}>
                  <Folder />
                  {levels[levels.length - 1]}
                </Link>
              </Button>
            ))}
          </div>
        </Section>
      )}
      <Section title="Tables">
        {tables.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tables.</p>
        ) : (
          <Panel>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  {header("name", "Table", false)}
                  {header("records", "Records")}
                  {header("data_bytes", "Data size")}
                  {header("data_files", "Data files")}
                  {header("avg", "Avg file")}
                  {header("delete_files", "Delete files")}
                  {header("snapshots", "Snapshots")}
                  {header("updated", "Last updated")}
                  <TableHead>Worth a look</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tables.map((table) => (
                  <TableRow key={table.name}>
                    <TableCell>
                      <Link
                        to={tablePath(catalogId, data.namespace, table.name)}
                        className="inline-flex items-center gap-2 font-medium hover:text-primary"
                      >
                        <Table2 className="size-4 text-muted-foreground" />
                        {table.name}
                      </Link>
                    </TableCell>
                    {table.error ? (
                      <TableCell colSpan={8} className="whitespace-normal text-destructive">
                        {table.error}
                      </TableCell>
                    ) : (
                      <>
                        <TableCell className="text-right tabular-nums">{formatNumber(table.records)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {table.data_bytes !== undefined ? formatBytes(table.data_bytes) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(table.data_files)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {table.data_files ? formatBytes((table.data_bytes ?? 0) / table.data_files) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(table.delete_files)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(table.snapshots)}</TableCell>
                        <TableCell
                          className="text-right text-muted-foreground"
                          title={table.last_updated_ms ? formatTime(table.last_updated_ms) : ""}
                        >
                          {table.last_updated_ms ? formatAge(table.last_updated_ms) : "—"}
                        </TableCell>
                        <TableCell>
                          <span className="flex flex-wrap gap-1">
                            {attention(table).map((note) => (
                              <Badge
                                key={note}
                                variant="outline"
                                asChild
                                className="border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"
                              >
                                <Link to={`${tablePath(catalogId, data.namespace, table.name)}?tab=maintenance`}>
                                  {note}
                                </Link>
                              </Badge>
                            ))}
                          </span>
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        )}
      </Section>
      {Object.keys(data.properties).length > 0 && (
        <Section title="Properties">
          <Panel>
            <FactList
              facts={Object.entries(data.properties).map(([key, val]) => ({
                label: key,
                value: val ?? "",
                mono: true,
              }))}
            />
          </Panel>
        </Section>
      )}
    </Page>
  );
}
