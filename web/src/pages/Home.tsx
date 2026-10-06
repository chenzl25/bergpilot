import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Database, Pencil, Plus } from "lucide-react";
import { Link } from "react-router";

import { api } from "@/api/client";
import { ErrorNotice, Page, PageHeader, PageSkeleton } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { LAYOUTS } from "@/pages/catalogFields";

export function HomePage() {
  const catalogs = useQuery({ queryKey: ["catalogs"], queryFn: api.listCatalogs });

  if (catalogs.isPending) return <PageSkeleton />;
  if (catalogs.isError) {
    return (
      <Page>
        <ErrorNotice error={catalogs.error} />
      </Page>
    );
  }

  if (catalogs.data.length === 0) {
    return (
      <Page className="min-h-[70svh] justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Database />
            </EmptyMedia>
            <EmptyTitle>Connect your first catalog</EmptyTitle>
            <EmptyDescription>
              BergPilot works with Apache Iceberg tables through their catalog: REST, AWS Glue, S3 Tables or JDBC.
              Browse namespaces and tables, inspect snapshots and files, run SQL, and keep tables healthy with
              compaction and cleanup.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link to="/catalogs/new">
                <Plus />
                Add a catalog
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        icon={Database}
        title="Catalogs"
        meta={`${catalogs.data.length} catalog${catalogs.data.length === 1 ? "" : "s"}. Open one to see its namespaces, or press ⌘K to jump to a table.`}
        actions={
          <Button asChild>
            <Link to="/catalogs/new">
              <Plus />
              Add a catalog
            </Link>
          </Button>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {catalogs.data.map((catalog) => {
          const layout = LAYOUTS[catalog.kind];
          const location =
            catalog.properties.uri ?? catalog.properties.table_bucket_arn ?? catalog.properties.warehouse ?? "—";
          return (
            <div
              key={catalog.id}
              className="group relative flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs transition-colors hover:border-primary/40"
            >
              <div className="flex items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-primary">
                  <layout.icon className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/catalogs/${catalog.id}`}
                    className="text-base font-semibold tracking-tight after:absolute after:inset-0 after:rounded-xl"
                  >
                    {catalog.name}
                  </Link>
                  <div className="mt-0.5">
                    <Badge variant="secondary">{layout.label}</Badge>
                  </div>
                </div>
                <Button variant="ghost" size="icon-sm" asChild className="relative z-10">
                  <Link to={`/catalogs/${catalog.id}/edit`} aria-label={`Edit ${catalog.name}`}>
                    <Pencil />
                  </Link>
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={location}>
                  {location}
                </span>
                <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </div>
            </div>
          );
        })}
      </div>
    </Page>
  );
}
