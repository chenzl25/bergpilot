import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Clock,
  Database,
  FileStack,
  Files,
  FileX,
  GitBranch,
  History,
  Rows3,
  SquareTerminal,
  Table2,
  Tag,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router";

import { api } from "@/api/client";
import type { FileStats } from "@/api/generated/FileStats";
import type { TableDetail } from "@/api/generated/TableDetail";
import { Results } from "@/components/DataGrid";
import { MaintenanceTab } from "@/components/MaintenanceTab";
import { SnapshotsTab } from "@/components/SnapshotGraph";
import {
  CopyButton,
  Dot,
  ErrorNotice,
  FactList,
  Loading,
  Page,
  PageHeader,
  PageSkeleton,
  Panel,
  Section,
  Stat,
  StatGrid,
} from "@/components/page";
import { PropertiesEditor } from "@/components/PropertiesEditor";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatAge, formatBytes, formatNumber, formatTime, sqlTableName } from "@/format";
import { attention } from "@/health";

const TABS = ["overview", "data", "schema", "snapshots", "files", "maintenance"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  data: "Data",
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

  if (namespace.length === 0) {
    return (
      <Page>
        <ErrorNotice error="Not a table path." />
      </Page>
    );
  }
  if (table.isPending) return <PageSkeleton />;
  if (table.isError) {
    return (
      <Page>
        <ErrorNotice title={`Cannot load ${name}`} error={table.error} />
      </Page>
    );
  }
  const detail = table.data;
  const qualified = sqlTableName(detail.catalog, namespace, name);
  const notes = attention({
    data_files: detail.totals.data_files,
    data_bytes: detail.totals.bytes,
    delete_files: detail.totals.delete_files,
    snapshots: detail.snapshots.length,
  });

  return (
    <Page>
      <PageHeader
        icon={Table2}
        title={name}
        meta={
          <>
            <span className="inline-flex items-center gap-0.5 font-mono text-xs">
              {qualified}
              <CopyButton value={qualified} label="Copy SQL name" />
            </span>
            <Badge variant="outline">Iceberg v{detail.format_version}</Badge>
            <span title={formatTime(detail.last_updated_ms)}>Updated {formatAge(detail.last_updated_ms)}</span>
            {notes.map((note) => (
              <Badge key={note} variant="outline" className="border-warning/40 bg-warning/10 text-warning">
                {note}
              </Badge>
            ))}
          </>
        }
        actions={
          <Button variant="outline" asChild>
            <Link to={`/sql?q=${encodeURIComponent(`SELECT * FROM ${qualified} LIMIT 100`)}`}>
              <SquareTerminal />
              Query
            </Link>
          </Button>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) => setSearch(value === "overview" ? {} : { tab: value }, { replace: true })}
        className="gap-5"
      >
        <div className="-mx-4 overflow-x-auto border-b px-4 md:-mx-8 md:px-8">
          <TabsList variant="line" className="h-10">
            {TABS.map((item) => (
              <TabsTrigger key={item} value={item} className="px-2.5">
                {TAB_LABELS[item]}
                {item === "snapshots" && (
                  <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums">
                    {detail.snapshots.length}
                  </span>
                )}
                {item === "maintenance" && notes.length > 0 && <Dot className="bg-warning" />}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview">
          <Overview detail={detail} catalogId={catalogId} notes={notes} />
        </TabsContent>
        <TabsContent value="data">
          <DataTab sql={`SELECT * FROM ${qualified} LIMIT 50`} />
        </TabsContent>
        <TabsContent value="schema">
          <SchemaTab detail={detail} />
        </TabsContent>
        <TabsContent value="snapshots">
          <SnapshotsTab detail={detail} />
        </TabsContent>
        <TabsContent value="files">
          <FilesTab detail={detail} catalogId={catalogId} namespace={namespace} />
        </TabsContent>
        <TabsContent value="maintenance">
          <MaintenanceTab target={{ catalog_id: catalogId, namespace, table: name }} detail={detail} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function Overview({ detail, catalogId, notes }: { detail: TableDetail; catalogId: number; notes: string[] }) {
  const { records, data_files: files, delete_files: deleteFiles, bytes } = detail.totals;
  const empty = detail.current_snapshot_id === undefined;
  return (
    <div className="flex flex-col gap-6">
      {notes.length > 0 && (
        <Alert className="border-warning/40 bg-warning/5">
          <TriangleAlert className="text-warning" />
          <AlertTitle>Worth a look: {notes.join(", ")}</AlertTitle>
          <AlertDescription>The Maintenance tab shows what a compaction or cleanup would change.</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" asChild>
              <Link to="?tab=maintenance">
                <Wrench />
                Maintenance
              </Link>
            </Button>
          </AlertAction>
        </Alert>
      )}
      <StatGrid>
        <Stat icon={Rows3} label="Records" value={empty ? "—" : formatNumber(records)} />
        <Stat
          icon={Files}
          label="Data files"
          value={empty ? "—" : formatNumber(files)}
          hint={files ? `avg ${formatBytes(bytes / files)}` : undefined}
        />
        <Stat icon={Database} label="Size" value={empty ? "—" : formatBytes(bytes)} />
        <Stat
          icon={FileX}
          label="Delete files"
          value={empty ? "—" : formatNumber(deleteFiles)}
          tone={deleteFiles > 0 ? "warning" : undefined}
        />
        <Stat icon={History} label="Snapshots" value={formatNumber(detail.snapshots.length)} />
        <Stat
          icon={Clock}
          label="Last updated"
          value={formatAge(detail.last_updated_ms)}
          title={formatTime(detail.last_updated_ms)}
        />
      </StatGrid>
      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="Details">
          <Panel>
            <FactList
              facts={[
                { label: "Location", value: detail.location, mono: true, copy: detail.location },
                {
                  label: "Metadata file",
                  value: detail.metadata_location ?? "—",
                  mono: true,
                  copy: detail.metadata_location,
                },
                { label: "Table UUID", value: detail.uuid, mono: true, copy: detail.uuid },
                {
                  label: "Current snapshot",
                  value: detail.current_snapshot_id ?? "None (empty table)",
                  mono: true,
                  copy: detail.current_snapshot_id,
                },
                {
                  label: "Partitioned by",
                  value:
                    detail.partition_fields.length === 0 ? (
                      <span className="text-muted-foreground">Not partitioned</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {detail.partition_fields.map((field) => (
                          <Badge key={field.name} variant="secondary" className="font-mono">
                            {field.transform}({field.source})
                          </Badge>
                        ))}
                      </span>
                    ),
                },
                {
                  label: "Sorted by",
                  value:
                    detail.sort_fields.length === 0 ? (
                      <span className="text-muted-foreground">Unsorted</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {detail.sort_fields.map((field, index) => (
                          <Badge key={index} variant="secondary" className="font-mono">
                            {field.transform === "identity" ? field.source : `${field.transform}(${field.source})`}{" "}
                            {field.direction} {field.null_order}
                          </Badge>
                        ))}
                      </span>
                    ),
                },
                {
                  label: "Branches and tags",
                  value:
                    detail.refs.length === 0 ? (
                      "—"
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {detail.refs.map((ref) => (
                          <Badge key={ref.name} variant="outline" title={ref.snapshot_id}>
                            {ref.kind === "tag" ? <Tag /> : <GitBranch />}
                            {ref.name}
                          </Badge>
                        ))}
                      </span>
                    ),
                },
              ]}
            />
          </Panel>
        </Section>
        <PropertiesEditor
          detail={detail}
          target={{ catalog_id: catalogId, namespace: detail.namespace, table: detail.name }}
        />
      </div>
    </div>
  );
}

function DataTab({ sql }: { sql: string }) {
  const rows = useQuery({ queryKey: ["preview-rows", sql], queryFn: () => api.query(sql, 50) });
  return (
    <Section
      title="First rows"
      description="The first 50 rows of the current snapshot."
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link to={`/sql?q=${encodeURIComponent(sql)}`}>
            <SquareTerminal />
            Open in SQL
          </Link>
        </Button>
      }
    >
      {rows.isPending && <Loading label="Reading rows…" />}
      {rows.isError && <ErrorNotice error={rows.error} />}
      {rows.data && <Results result={rows.data} />}
    </Section>
  );
}

function SchemaTab({ detail }: { detail: TableDetail }) {
  const top = detail.schema.filter((field) => field.depth === 0).length;
  return (
    <Section title={`Schema ${detail.schema_id}`} description={`${top} column${top === 1 ? "" : "s"}${detail.schema.length > top ? `, ${detail.schema.length - top} nested fields` : ""}.`}>
      <Panel>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="w-14 text-right">ID</TableHead>
              <TableHead>Column</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Nullable</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.schema.map((field) => (
              <TableRow key={field.id}>
                <TableCell className="text-right text-muted-foreground tabular-nums">{field.id}</TableCell>
                <TableCell className="font-mono text-[13px]" style={{ paddingLeft: `${8 + field.depth * 20}px` }}>
                  {field.depth > 0 && <span className="mr-1 text-muted-foreground">└</span>}
                  {field.name}
                </TableCell>
                <TableCell>
                  <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-primary">{field.type}</span>
                </TableCell>
                <TableCell className="text-muted-foreground">{field.required ? "required" : "nullable"}</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{field.doc ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </Section>
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
    <div className="flex flex-col gap-6">
      {newestFirst.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Snapshot</span>
          <Select value={snapshotId ?? "current"} onValueChange={(value) => setSnapshotId(value === "current" ? undefined : value)}>
            <SelectTrigger className="w-[min(100%,440px)]" aria-label="Snapshot">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="current">Current</SelectItem>
              {newestFirst.map((snapshot) => (
                <SelectItem key={snapshot.snapshot_id} value={snapshot.snapshot_id}>
                  {formatTime(snapshot.timestamp_ms)} · {snapshot.operation} ·{" "}
                  <span className="font-mono text-xs">{snapshot.snapshot_id}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {files.isPending && <Loading label="Reading manifests…" />}
      {files.isError && <ErrorNotice error={files.error} />}
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
  if (partitions.isPending) return <Loading label="Reading partitions…" />;
  if (partitions.isError) return <ErrorNotice error={partitions.error} />;
  const rows = [...partitions.data].sort((a, b) =>
    sort === "size" ? b.data_bytes - a.data_bytes : a.partition.localeCompare(b.partition),
  );
  const largest = Math.max(1, ...rows.map((row) => row.data_bytes));
  const total = rows.reduce((sum, row) => sum + row.data_bytes, 0);
  return (
    <Section
      title={`Partitions (${formatNumber(rows.length)})`}
      actions={
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={sort}
          onValueChange={(value) => value && setSort(value as "size" | "name")}
        >
          <ToggleGroupItem value="size">Largest first</ToggleGroupItem>
          <ToggleGroupItem value="name">By name</ToggleGroupItem>
        </ToggleGroup>
      }
    >
      <Panel>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead>Partition</TableHead>
              <TableHead className="text-right">Records</TableHead>
              <TableHead className="text-right">Data files</TableHead>
              <TableHead className="text-right">Data size</TableHead>
              <TableHead className="w-48">Share of data</TableHead>
              <TableHead className="text-right">Avg file</TableHead>
              <TableHead className="text-right">Delete files</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, PARTITION_ROWS).map((row) => (
              <TableRow key={row.partition}>
                <TableCell className="font-mono text-[13px]">{row.partition || "(unpartitioned)"}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(row.record_count)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(row.data_files)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatBytes(row.data_bytes)}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-chart-1"
                        style={{ width: `${Math.max(2, (row.data_bytes / largest) * 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {total ? `${((row.data_bytes / total) * 100).toFixed(1)}%` : ""}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.data_files ? formatBytes(row.data_bytes / row.data_files) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.delete_files ? formatNumber(row.delete_files) : ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
      {rows.length > PARTITION_ROWS && (
        <p className="text-xs text-muted-foreground">
          Showing {PARTITION_ROWS} of {formatNumber(rows.length)}. Query <code>"{props.name}$partitions"</code> in SQL
          for all of them.
        </p>
      )}
    </Section>
  );
}

function FileStatsView({ stats }: { stats: FileStats }) {
  if (!stats.snapshot_id) return <p className="text-sm text-muted-foreground">This table has no snapshots yet.</p>;
  const deletes = stats.position_deletes.files + stats.equality_deletes.files;
  const max = Math.max(1, ...stats.buckets.map((b) => b.data_files + b.delete_files));
  const small = stats.buckets[0]?.data_files ?? 0;
  const average = stats.data.files ? stats.data.bytes / stats.data.files : 0;
  return (
    <>
      <StatGrid>
        <Stat icon={Files} label="Data files" value={formatNumber(stats.data.files)} />
        <Stat icon={Database} label="Data size" value={formatBytes(stats.data.bytes)} />
        <Stat icon={Files} label="Average data file" value={stats.data.files ? formatBytes(average) : "—"} />
        <Stat icon={Rows3} label="Records" value={formatNumber(stats.data.records)} />
        <Stat icon={FileX} label="Delete files" value={formatNumber(deletes)} tone={deletes > 0 ? "warning" : undefined} />
        <Stat icon={FileStack} label="Manifests" value={formatNumber(stats.manifests)} />
      </StatGrid>
      <Section
        title="Files by size"
        description={
          stats.data.files > 0
            ? `${formatNumber(small)} of ${formatNumber(stats.data.files)} data files are smaller than 8 MiB.`
            : undefined
        }
        actions={
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Dot className="rounded-sm bg-chart-1" /> Data files
            </span>
            <span className="flex items-center gap-1.5">
              <Dot className="rounded-sm bg-chart-3" /> Delete files
            </span>
          </div>
        }
      >
        <Panel className="p-4">
          <div className="flex flex-col gap-2">
            {stats.buckets.map((bucket) => (
              <div key={bucket.label} className="grid grid-cols-[88px_1fr_auto] items-center gap-3 text-sm">
                <span className="text-right text-xs text-muted-foreground tabular-nums">{bucket.label}</span>
                <div className="flex h-5 items-center gap-0.5">
                  <div
                    className="h-full rounded-sm bg-chart-1 transition-[width]"
                    style={{ width: `${(bucket.data_files / max) * 100}%` }}
                  />
                  <div
                    className="h-full rounded-sm bg-chart-3 transition-[width]"
                    style={{ width: `${(bucket.delete_files / max) * 100}%` }}
                  />
                </div>
                <span className="min-w-24 text-right text-xs tabular-nums">
                  {formatNumber(bucket.data_files)}
                  {bucket.delete_files > 0 && (
                    <span className="text-muted-foreground"> + {formatNumber(bucket.delete_files)} deletes</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </Section>
      {deletes > 0 && (
        <Section title="Delete files">
          <Panel>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Files</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Records</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[
                  { label: "Position deletes", stats: stats.position_deletes },
                  { label: "Equality deletes", stats: stats.equality_deletes },
                ].map((row) => (
                  <TableRow key={row.label}>
                    <TableCell>{row.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.stats.files)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(row.stats.bytes)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.stats.records)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        </Section>
      )}
    </>
  );
}
