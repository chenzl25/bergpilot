import { useQuery } from "@tanstack/react-query";
import { Folder, Lock, Pencil } from "lucide-react";
import { Link, useParams } from "react-router";

import { api } from "@/api/client";
import { ErrorNotice, FactList, Loading, Page, PageHeader, PageSkeleton, Panel, Section } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { namespacePath } from "@/format";
import { LAYOUTS } from "@/pages/catalogFields";

export function CatalogPage() {
  const params = useParams();
  const id = Number(params.id);
  const catalog = useQuery({ queryKey: ["catalog", id], queryFn: () => api.getCatalog(id) });
  const namespaces = useQuery({ queryKey: ["namespaces", id, []], queryFn: () => api.namespaces(id, []) });

  if (catalog.isPending) return <PageSkeleton />;
  if (catalog.isError) {
    return (
      <Page>
        <ErrorNotice error={catalog.error} />
      </Page>
    );
  }
  const data = catalog.data;
  const layout = LAYOUTS[data.kind];
  return (
    <Page>
      <PageHeader
        icon={layout.icon}
        title={data.name}
        meta={
          <>
            <Badge variant="secondary">{layout.label} catalog</Badge>
            {namespaces.data && (
              <span>
                {namespaces.data.namespaces.length} top-level namespace{namespaces.data.namespaces.length === 1 ? "" : "s"}
              </span>
            )}
          </>
        }
        actions={
          <Button variant="outline" asChild>
            <Link to={`/catalogs/${id}/edit`}>
              <Pencil />
              Edit connection
            </Link>
          </Button>
        }
      />
      <Section title="Namespaces">
        {namespaces.isPending && <Loading label="Listing namespaces…" />}
        {namespaces.isError && <ErrorNotice title="Cannot list namespaces" error={namespaces.error} />}
        {namespaces.data?.namespaces.length === 0 && <p className="text-sm text-muted-foreground">No namespaces.</p>}
        {(namespaces.data?.namespaces.length ?? 0) > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {namespaces.data?.namespaces.map((levels) => (
              <Link
                key={levels.join("\u001f")}
                to={namespacePath(id, levels)}
                className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm font-medium shadow-xs transition-colors hover:border-primary/40 hover:bg-accent/40"
              >
                <Folder className="size-4 text-muted-foreground" />
                <span className="truncate">{levels[levels.length - 1]}</span>
              </Link>
            ))}
          </div>
        )}
      </Section>
      <Section title="Connection">
        <Panel>
          <FactList
            facts={[
              ...Object.entries(data.properties).map(([key, value]) => ({ label: key, value: value ?? "", mono: true })),
              ...data.secret_keys.map((key) => ({
                label: key,
                value: (
                  <span className="flex items-center gap-1.5 font-sans text-muted-foreground">
                    <Lock className="size-3.5" />
                    Stored encrypted
                  </span>
                ),
              })),
            ]}
          />
        </Panel>
      </Section>
    </Page>
  );
}
