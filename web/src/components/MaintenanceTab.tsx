// The Maintenance tab: what looks off about the table, the four operations,
// and a side sheet per operation with its settings, a preview and a schedule.

import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Combine,
  Eraser,
  History,
  Layers,
  RefreshCw,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "@/api/client";
import type { CompactionStrategy } from "@/api/generated/CompactionStrategy";
import type { JobInfo } from "@/api/generated/JobInfo";
import type { MaintenancePreview } from "@/api/generated/MaintenancePreview";
import type { MaintenanceTask } from "@/api/generated/MaintenanceTask";
import type { ScheduleInfo } from "@/api/generated/ScheduleInfo";
import type { TableDetail } from "@/api/generated/TableDetail";
import type { TableRef } from "@/api/generated/TableRef";
import { type ConfirmOptions, useConfirm } from "@/components/confirm";
import { JobProgressView, JobStatusBadge } from "@/components/job-status";
import { JobsTable, SchedulesTable } from "@/components/JobsTable";
import { ErrorNotice, Panel, Section } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { formatAge, formatBytes, formatNumber } from "@/format";
import { SMALL_FILE_BYTES } from "@/health";
import { CRON_PRESETS, describeTask, isActive } from "@/jobs";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

type Kind = MaintenanceTask["kind"];

interface TaskDef {
  kind: Kind;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** Has a preview that changes nothing (orphan removal has a dry-run job instead). */
  preview: boolean;
  confirm: ConfirmOptions;
}

const TASKS: TaskDef[] = [
  {
    kind: "compact",
    title: "Compact data files",
    description: "Rewrite many small files, and files with deletes, into fewer large ones. Readers see the same rows.",
    icon: Combine,
    preview: true,
    confirm: {
      title: "Compact the selected data files now?",
      description: "BergPilot reads and rewrites the files on this machine, then commits a replace snapshot.",
      confirmLabel: "Run compaction",
    },
  },
  {
    kind: "expire_snapshots",
    title: "Expire snapshots",
    description: "Drop old snapshots from the metadata. Time travel to them stops working.",
    icon: History,
    preview: true,
    confirm: {
      title: "Expire these snapshots now?",
      description: "Time travel to expired snapshots stops working. This cannot be undone.",
      confirmLabel: "Expire snapshots",
      destructive: true,
    },
  },
  {
    kind: "remove_orphan_files",
    title: "Remove orphan files",
    description: "Delete files under the table location that no snapshot uses, such as leftovers of failed writes.",
    icon: Eraser,
    preview: false,
    confirm: {
      title: "Delete orphan files now?",
      description: "Run a dry run first to see the list. Deleted files cannot be recovered.",
      confirmLabel: "Delete files",
      destructive: true,
    },
  },
  {
    kind: "rewrite_manifests",
    title: "Rewrite manifests",
    description: "Merge the current snapshot's manifests so planning reads fewer files. Data files are untouched.",
    icon: Layers,
    preview: true,
    confirm: { title: "Rewrite manifests now?", confirmLabel: "Rewrite manifests" },
  },
];

function defaultTask(kind: Kind, strategy: CompactionStrategy = "auto"): MaintenanceTask {
  switch (kind) {
    case "compact":
      return {
        kind,
        strategy,
        target_file_size_mb: 512,
        small_file_threshold_mb: 32,
        min_delete_files: strategy === "files_with_deletes" ? 1 : 128,
      };
    case "expire_snapshots":
      return { kind, older_than_days: 7, retain_last: 5, clean_files: true };
    case "remove_orphan_files":
      return { kind, older_than_days: 3, dry_run: false };
    case "rewrite_manifests":
      return { kind };
  }
}

/** Drop compaction settings that do not apply to the chosen strategy. */
function normalize(task: MaintenanceTask): MaintenanceTask {
  if (task.kind !== "compact") return task;
  const { strategy } = task;
  return {
    ...task,
    small_file_threshold_mb: strategy === "auto" || strategy === "small_files" ? task.small_file_threshold_mb : undefined,
    min_delete_files: strategy === "auto" || strategy === "files_with_deletes" ? task.min_delete_files : undefined,
  };
}

interface Finding {
  id: string;
  title: string;
  detail: string;
  kind: Kind;
  strategy?: CompactionStrategy;
  action: string;
}

/** Same thresholds as the "worth a look" notes (health.ts), with an explanation and a fix. */
function findings(detail: TableDetail): Finding[] {
  const { data_files: files, bytes, delete_files: deletes } = detail.totals;
  const snapshots = detail.snapshots.length;
  const list: Finding[] = [];
  if (files >= 16 && bytes / files < SMALL_FILE_BYTES) {
    list.push({
      id: "small",
      title: `${formatNumber(files)} data files average ${formatBytes(bytes / files)}`,
      detail: "Many small files slow down planning and scans. Compaction merges them into larger files.",
      kind: "compact",
      strategy: "small_files",
      action: "Compact",
    });
  }
  if (deletes > 0) {
    list.push({
      id: "deletes",
      title: `${formatNumber(deletes)} delete file${deletes === 1 ? "" : "s"}`,
      detail:
        "Readers apply them on every scan. Compacting the affected files applies them; compacting all files also drops them from the table.",
      kind: "compact",
      strategy: "files_with_deletes",
      action: "Apply deletes",
    });
  }
  if (snapshots > 100) {
    list.push({
      id: "snapshots",
      title: `${formatNumber(snapshots)} snapshots`,
      detail: "Every snapshot keeps its files alive. Expiring old ones frees storage and shrinks the metadata.",
      kind: "expire_snapshots",
      action: "Expire",
    });
  }
  return list;
}

export function MaintenanceTab({ target, detail }: { target: TableRef; detail: TableDetail }) {
  const jobs = useQuery({
    queryKey: ["jobs", target],
    queryFn: () => api.jobs(target, 20),
    // Follow running jobs until they finish.
    refetchInterval: (query) => (query.state.data?.some(isActive) ? 1500 : false),
  });
  const schedules = useQuery({ queryKey: ["schedules", target], queryFn: () => api.schedules(target) });
  const [sheet, setSheet] = useState<{ kind: Kind; strategy?: CompactionStrategy; key: number } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const open = (kind: Kind, strategy?: CompactionStrategy) => {
    setSheet({ kind, strategy, key: Date.now() });
    setSheetOpen(true);
  };
  const issues = findings(detail);

  return (
    <div className="flex flex-col gap-8">
      <Section
        title="Health"
        description="Checks on the current snapshot. Each fix opens with a preview; nothing changes until you run it."
      >
        <Panel>
          {issues.length === 0 ? (
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success">
                <CircleCheck className="size-4" />
              </div>
              <div>
                <p className="text-sm font-medium">Nothing stands out</p>
                <p className="text-sm text-muted-foreground">File sizes, delete files and the snapshot count look fine.</p>
              </div>
            </div>
          ) : (
            <ul className="divide-y">
              {issues.map((issue) => (
                <li key={issue.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:flex-nowrap">
                  <div className="hidden size-8 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning sm:flex">
                    <TriangleAlert className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="text-sm font-medium">{issue.title}</p>
                    <p className="text-sm text-muted-foreground">{issue.detail}</p>
                  </div>
                  <Button size="sm" onClick={() => open(issue.kind, issue.strategy)}>
                    <Wrench />
                    {issue.action}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </Section>

      <Section
        title="Operations"
        description="Each runs as a job on this machine; the table stays readable while it runs."
      >
        <Panel>
          <ul className="divide-y">
            {TASKS.map((task) => (
              <OperationRow
                key={task.kind}
                task={task}
                lastJob={jobs.data?.find((job) => job.task.kind === task.kind)}
                schedules={schedules.data?.filter((schedule) => schedule.task.kind === task.kind) ?? []}
                onOpen={() => open(task.kind)}
              />
            ))}
          </ul>
        </Panel>
      </Section>

      <Section title="Schedules">
        {schedules.isPending && <Skeleton className="h-16 rounded-xl" />}
        {schedules.isError && <ErrorNotice error={schedules.error} />}
        {schedules.data && <SchedulesTable schedules={schedules.data} showTable={false} />}
      </Section>

      <Section title="Recent jobs">
        {jobs.isPending && <Skeleton className="h-24 rounded-xl" />}
        {jobs.isError && <ErrorNotice error={jobs.error} />}
        {jobs.data && <JobsTable jobs={jobs.data} showTable={false} />}
      </Section>

      {sheet && (
        <TaskSheet
          key={sheet.key}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          target={target}
          detail={detail}
          def={TASKS.find((task) => task.kind === sheet.kind)!}
          strategy={sheet.strategy}
        />
      )}
    </div>
  );
}

function OperationRow(props: { task: TaskDef; lastJob?: JobInfo; schedules: ScheduleInfo[]; onOpen: () => void }) {
  const { task, lastJob, schedules } = props;
  const enabled = schedules.filter((schedule) => schedule.enabled);
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:flex-nowrap">
      <div className="hidden size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-primary sm:flex">
        <task.icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm font-medium">{task.title}</p>
        <p className="text-sm text-muted-foreground">{task.description}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {lastJob ? (
            <span className="flex items-center gap-1.5">
              Last run {formatAge(Date.parse(lastJob.finished_at ?? lastJob.started_at ?? lastJob.created_at))}
              <JobStatusBadge status={lastJob.status} />
            </span>
          ) : (
            <span>Not run from BergPilot yet</span>
          )}
          {enabled.length > 0 && (
            <span className="flex items-center gap-1">
              <CalendarClock className="size-3.5" />
              {enabled[0].cron_description || enabled[0].cron}
              {enabled.length > 1 && ` and ${enabled.length - 1} more`}
            </span>
          )}
        </div>
        {lastJob?.status === "running" && lastJob.progress && (
          <JobProgressView progress={lastJob.progress} className="mt-2.5 max-w-md" />
        )}
      </div>
      <Button variant="outline" size="sm" onClick={props.onOpen}>
        {task.preview ? "Preview" : "Set up"}
        <ChevronRight />
      </Button>
    </li>
  );
}

function TaskSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: TableRef;
  detail: TableDetail;
  def: TaskDef;
  strategy?: CompactionStrategy;
}) {
  const { def, target } = props;
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [task, setTask] = useState<MaintenanceTask>(() => defaultTask(def.kind, props.strategy));
  const [previewed, setPreviewed] = useState<string | null>(null);
  const normalized = normalize(task);

  const refresh = () => {
    for (const key of ["jobs", "schedules", "table", "files"]) void queryClient.invalidateQueries({ queryKey: [key] });
  };
  const preview = useMutation({
    mutationFn: (next: MaintenanceTask) => api.preview(target, next),
    onSuccess: (_, next) => setPreviewed(JSON.stringify(next)),
  });
  const submit = useMutation({
    mutationFn: (next: MaintenanceTask) => api.submitJob(target, next),
    onSuccess: (job) => {
      toast.success(`Job #${job.id} queued`, { description: describeTask(job.task) });
      refresh();
      props.onOpenChange(false);
    },
  });

  // Previews change nothing, so show one right away.
  useEffect(() => {
    if (def.preview) preview.mutate(normalize(task));
    // Only on open; later previews are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stale = previewed !== null && previewed !== JSON.stringify(normalized);
  const deleteFiles = props.detail.totals.delete_files;
  const description =
    def.kind === "expire_snapshots"
      ? `${def.description} The table has ${formatNumber(props.detail.snapshots.length)} snapshot${props.detail.snapshots.length === 1 ? "" : "s"}.`
      : def.description;

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b pr-12">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-primary">
              <def.icon className="size-4" />
            </div>
            <div className="flex flex-col gap-1">
              <SheetTitle>{def.title}</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-4">
          <TaskSettings task={task} onChange={setTask} />
          {def.preview && (
            <div className="rounded-xl border bg-muted/30 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Preview</span>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={preview.isPending}
                  onClick={() => preview.mutate(normalized)}
                >
                  <RefreshCw className={cn(preview.isPending && "animate-spin")} />
                  {stale ? "Update preview" : "Refresh"}
                </Button>
              </div>
              {preview.isPending ? (
                <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                  <Spinner /> Checking what a run would do…
                </p>
              ) : preview.isError ? (
                <p className="text-sm text-destructive">{errorMessage(preview.error)}</p>
              ) : preview.data ? (
                <>
                  <PreviewView preview={preview.data} />
                  {stale && <p className="mt-2 text-xs text-warning">The settings changed since this preview.</p>}
                  {!stale &&
                    preview.data.kind === "compact" &&
                    preview.data.data_files === 0 &&
                    normalized.kind === "compact" &&
                    normalized.strategy === "files_with_deletes" &&
                    deleteFiles > 0 && (
                      <div className="mt-2 flex flex-col items-start gap-2 text-sm text-muted-foreground">
                        <p>
                          The table still lists {formatNumber(deleteFiles)} delete file{deleteFiles === 1 ? "" : "s"}, but no
                          data file qualifies. Delete files left over from an earlier compaction go away only when all
                          files are compacted.
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const next: MaintenanceTask = { ...normalized, strategy: "full" };
                            setTask(next);
                            preview.mutate(normalize(next));
                          }}
                        >
                          Preview compacting all files
                        </Button>
                      </div>
                    )}
                </>
              ) : null}
            </div>
          )}
          <ScheduleBox target={target} task={normalized} onSaved={refresh} />
          {submit.isError && <ErrorNotice title="Could not queue the job" error={submit.error} />}
        </div>
        <SheetFooter className="flex-row justify-end border-t">
          {def.kind === "remove_orphan_files" && (
            <Button
              variant="outline"
              disabled={submit.isPending}
              onClick={() => submit.mutate({ ...(normalized as Extract<MaintenanceTask, { kind: "remove_orphan_files" }>), dry_run: true })}
            >
              Dry run
            </Button>
          )}
          <Button
            variant={def.confirm.destructive ? "destructive" : "default"}
            disabled={submit.isPending}
            onClick={async () => {
              if (await confirm(def.confirm)) submit.mutate(normalized);
            }}
          >
            {submit.isPending && <Spinner />}
            {def.kind === "remove_orphan_files" ? "Delete files" : "Run now"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function TaskSettings({ task, onChange }: { task: MaintenanceTask; onChange: (task: MaintenanceTask) => void }) {
  switch (task.kind) {
    case "compact":
      return (
        <FieldGroup>
          <Field>
            <FieldLabel>Files to rewrite</FieldLabel>
            <Select
              value={task.strategy}
              onValueChange={(value) => {
                const strategy = value as CompactionStrategy;
                onChange({ ...task, strategy, min_delete_files: strategy === "files_with_deletes" ? 1 : 128 });
              }}
            >
              <SelectTrigger className="w-full" aria-label="Files to rewrite">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Small files and files with many deletes</SelectItem>
                <SelectItem value="small_files">Small files</SelectItem>
                <SelectItem value="files_with_deletes">Files with deletes</SelectItem>
                <SelectItem value="full">All files</SelectItem>
              </SelectContent>
            </Select>
            {task.strategy !== "full" && (
              <FieldDescription>
                Delete files of rewritten data stay listed (and are read) until a compaction of all files removes them.
              </FieldDescription>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <NumberField
              label="Target file size (MiB)"
              value={task.target_file_size_mb ?? 512}
              min={1}
              onChange={(value) => onChange({ ...task, target_file_size_mb: value })}
            />
            {(task.strategy === "auto" || task.strategy === "small_files") && (
              <NumberField
                label="Small means under (MiB)"
                value={task.small_file_threshold_mb ?? 32}
                min={1}
                onChange={(value) => onChange({ ...task, small_file_threshold_mb: value })}
              />
            )}
            {(task.strategy === "auto" || task.strategy === "files_with_deletes") && (
              <NumberField
                label="Delete files per data file"
                value={task.min_delete_files ?? 128}
                min={1}
                onChange={(value) => onChange({ ...task, min_delete_files: value })}
              />
            )}
          </div>
        </FieldGroup>
      );
    case "expire_snapshots":
      return (
        <FieldGroup>
          <div className="grid grid-cols-2 gap-4">
            <NumberField
              label="Older than (days)"
              value={task.older_than_days}
              min={0}
              onChange={(value) => onChange({ ...task, older_than_days: value })}
            />
            <NumberField
              label="Always keep the newest"
              value={task.retain_last}
              min={1}
              onChange={(value) => onChange({ ...task, retain_last: value })}
            />
          </div>
          <Field orientation="horizontal">
            <Checkbox
              id="clean-files"
              checked={task.clean_files}
              onCheckedChange={(checked) => onChange({ ...task, clean_files: checked === true })}
            />
            <FieldContent>
              <FieldLabel htmlFor="clean-files">Delete files only these snapshots used</FieldLabel>
              <FieldDescription>Frees storage. Without it, the files stay until an orphan cleanup.</FieldDescription>
            </FieldContent>
          </Field>
        </FieldGroup>
      );
    case "remove_orphan_files":
      return (
        <FieldGroup>
          <NumberField
            label="Older than (days)"
            value={task.older_than_days}
            min={1}
            hint="At least 1 day, so files of commits in progress are never touched."
            onChange={(value) => onChange({ ...task, older_than_days: value })}
          />
          <p className="text-sm text-muted-foreground">
            A dry run lists the files as a job without deleting anything. BergPilot refuses to delete when it cannot find
            the table's own current files in the listing.
          </p>
        </FieldGroup>
      );
    case "rewrite_manifests":
      return null;
  }
}

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  const id = `field-${props.label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <Input
        id={id}
        type="number"
        min={props.min}
        value={props.value}
        className="tabular-nums"
        onChange={(event) => props.onChange(Math.max(props.min, Number(event.target.value) || props.min))}
      />
      {props.hint && <FieldDescription>{props.hint}</FieldDescription>}
    </Field>
  );
}

function PreviewNumber({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function PreviewView({ preview }: { preview: MaintenancePreview }) {
  switch (preview.kind) {
    case "compact":
      if (preview.data_files === 0) return <p className="text-sm">No files match; a run would do nothing.</p>;
      return (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <PreviewNumber label="Data files" value={formatNumber(preview.data_files)} />
            <PreviewNumber label="Size" value={formatBytes(preview.bytes)} />
            <PreviewNumber label="Delete files" value={formatNumber(preview.delete_files)} />
            <PreviewNumber label="Groups" value={formatNumber(preview.groups.length)} />
          </div>
          <p className="text-sm text-muted-foreground">
            A run rewrites these files in {preview.groups.length} group{preview.groups.length === 1 ? "" : "s"}.
          </p>
        </div>
      );
    case "expire_snapshots":
      if (preview.expired_snapshot_ids.length === 0) {
        return <p className="text-sm">No snapshot is old enough; a run would do nothing.</p>;
      }
      return (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <PreviewNumber label="Would expire" value={formatNumber(preview.expired_snapshot_ids.length)} />
            <PreviewNumber label="Would keep" value={formatNumber(preview.remaining_snapshots)} />
          </div>
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDown className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
              Snapshot ids
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-1 max-h-40 overflow-y-auto font-mono text-xs">
                {preview.expired_snapshot_ids.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </div>
      );
    case "rewrite_manifests":
      return (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <PreviewNumber label="Data manifests" value={formatNumber(preview.data_manifests)} />
            <PreviewNumber label="Delete manifests" value={formatNumber(preview.delete_manifests)} />
          </div>
          <p className="text-sm text-muted-foreground">
            {preview.data_manifests <= 1
              ? "At most one data manifest; nothing to merge."
              : "A run merges the data manifests into fewer."}
          </p>
        </div>
      );
  }
}

function ScheduleBox({ target, task, onSaved }: { target: TableRef; task: MaintenanceTask; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [cron, setCron] = useState(CRON_PRESETS[0].cron);
  const preset = CRON_PRESETS.some((item) => item.cron === cron) ? cron : "custom";
  const schedule = useMutation({
    mutationFn: () => api.createSchedule({ ...target, task, cron: cron.trim(), enabled: true }),
    onSuccess: (created) => {
      toast.success("Schedule saved", {
        description: `${describeTask(created.task)}: ${created.cron_description || created.cron}`,
      });
      setOpen(false);
      onSaved();
    },
  });
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2.5 text-sm font-medium">
        <CalendarClock className="size-4 text-muted-foreground" />
        Run on a schedule
        <ChevronDown className={cn("ml-auto size-4 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 border-t p-3">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Select value={preset} onValueChange={(value) => value !== "custom" && setCron(value)}>
              <SelectTrigger className="w-full" aria-label="When">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CRON_PRESETS.map((item) => (
                  <SelectItem key={item.cron} value={item.cron}>
                    {item.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="w-36 font-mono"
              value={cron}
              onChange={(event) => setCron(event.target.value)}
              aria-label="Cron expression"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Cron: minute hour day month weekday, in this server's local time. The schedule runs the settings above.
          </p>
          {schedule.isError && <p className="text-sm text-destructive">{errorMessage(schedule.error)}</p>}
          <div>
            <Button variant="outline" size="sm" disabled={schedule.isPending} onClick={() => schedule.mutate()}>
              Save schedule
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
