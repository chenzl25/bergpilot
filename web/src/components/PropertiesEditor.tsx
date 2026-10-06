import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/api/client";
import type { TableDetail } from "@/api/generated/TableDetail";
import type { TableRef } from "@/api/generated/TableRef";
import { useConfirm } from "@/components/confirm";
import { ErrorNotice, Panel, Section } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Row = { key: string; value: string };

/** Table properties, with an edit mode that commits all changes at once. */
export function PropertiesEditor({ detail, target }: { detail: TableDetail; target: TableRef }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const entries = Object.entries(detail.properties) as [string, string][];

  const save = useMutation({
    mutationFn: () => {
      const set: Record<string, string> = {};
      const kept = new Set<string>();
      for (const row of rows) {
        const key = row.key.trim();
        if (!key) continue;
        kept.add(key);
        if (detail.properties[key] !== row.value) set[key] = row.value;
      }
      const remove = entries.map(([key]) => key).filter((key) => !kept.has(key));
      return api.updateProperties({ ...target, set, remove });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["table", target.catalog_id, target.namespace, target.table], updated);
      setEditing(false);
      toast.success("Properties saved", { description: "One commit to the table metadata." });
    },
  });

  const update = (index: number, patch: Partial<Row>) =>
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <Section
      title="Properties"
      actions={
        !editing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setRows(entries.map(([key, value]) => ({ key, value })));
              setEditing(true);
            }}
          >
            <Pencil />
            Edit
          </Button>
        )
      }
    >
      {!editing ? (
        <Panel>
          {entries.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No properties.</p>
          ) : (
            <dl className="divide-y text-[13px]">
              {entries.map(([key, value]) => (
                <div key={key} className="grid grid-cols-1 gap-1 px-4 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-4">
                  <dt className="font-mono break-all text-muted-foreground">{key}</dt>
                  <dd className="font-mono break-all">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </Panel>
      ) : (
        <Panel className="flex flex-col gap-2 p-4">
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                className="font-mono text-[13px]"
                value={row.key}
                placeholder="property"
                aria-label="Property"
                onChange={(event) => update(index, { key: event.target.value })}
              />
              <Input
                className="font-mono text-[13px]"
                value={row.value}
                placeholder="value"
                aria-label="Value"
                onChange={(event) => update(index, { value: event.target.value })}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${row.key || "property"}`}
                onClick={() => setRows(rows.filter((_, i) => i !== index))}
              >
                <X />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setRows([...rows, { key: "", value: "" }])}>
              <Plus />
              Add property
            </Button>
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={save.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: "Commit these property changes?",
                    description:
                      "The changes are one commit to the table metadata; data files are untouched. Engines read some properties (for example write.target-file-size-bytes) on their next write.",
                    confirmLabel: "Commit",
                  });
                  if (ok) save.mutate();
                }}
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
          {save.isError && <ErrorNotice title="Could not save" error={save.error} />}
        </Panel>
      )}
    </Section>
  );
}
