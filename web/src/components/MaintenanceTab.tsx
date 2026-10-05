import { type ReactNode, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import type { CompactionStrategy } from "../api/generated/CompactionStrategy";
import type { MaintenancePreview } from "../api/generated/MaintenancePreview";
import type { MaintenanceTask } from "../api/generated/MaintenanceTask";
import type { TableDetail } from "../api/generated/TableDetail";
import type { TableRef } from "../api/generated/TableRef";
import { formatBytes, formatNumber } from "../format";
import { CRON_PRESETS, describeTask, isActive } from "../jobs";
import { JobsTable, SchedulesTable } from "./JobsTable";
import { errorMessage } from "./Layout";

export function MaintenanceTab({ target, detail }: { target: TableRef; detail: TableDetail }) {
  const jobs = useQuery({
    queryKey: ["jobs", target],
    queryFn: () => api.jobs(target, 20),
    // Follow running jobs until they finish.
    refetchInterval: (query) => (query.state.data?.some(isActive) ? 1500 : false),
  });
  const schedules = useQuery({ queryKey: ["schedules", target], queryFn: () => api.schedules(target) });

  return (
    <div className="maintenance">
      <p className="muted">
        These operations change the table. Each runs as a job on this machine; the table stays
        readable while it runs. Preview first to see what a run would do.
      </p>
      <div className="task-grid">
        <CompactCard target={target} />
        <ExpireCard target={target} snapshots={detail.snapshots.length} />
        <OrphanCard target={target} />
        <RewriteManifestsCard target={target} />
      </div>
      <h2>Schedules</h2>
      {schedules.isError && <p className="error">{errorMessage(schedules.error)}</p>}
      {schedules.data && <SchedulesTable schedules={schedules.data} showTable={false} />}
      <h2>Recent jobs</h2>
      {jobs.isError && <p className="error">{errorMessage(jobs.error)}</p>}
      {jobs.data && <JobsTable jobs={jobs.data} showTable={false} />}
    </div>
  );
}

function CompactCard({ target }: { target: TableRef }) {
  const [strategy, setStrategy] = useState<CompactionStrategy>("auto");
  const [targetMb, setTargetMb] = useState(512);
  const [smallMb, setSmallMb] = useState(32);
  const [minDeletes, setMinDeletes] = useState(strategy === "files_with_deletes" ? 1 : 128);
  const task: MaintenanceTask = {
    kind: "compact",
    strategy,
    target_file_size_mb: targetMb,
    small_file_threshold_mb: strategy === "auto" || strategy === "small_files" ? smallMb : undefined,
    min_delete_files: strategy === "auto" || strategy === "files_with_deletes" ? minDeletes : undefined,
  };
  return (
    <TaskCard
      title="Compact data files"
      description="Rewrite many small files, and files with deletes, into fewer large ones. Readers see the same rows."
      target={target}
      task={task}
      canPreview
      confirmText="Rewrite the selected data files now?"
    >
      <label>
        <span>Files to rewrite</span>
        <select
          value={strategy}
          onChange={(event) => {
            const next = event.target.value as CompactionStrategy;
            setStrategy(next);
            setMinDeletes(next === "files_with_deletes" ? 1 : 128);
          }}
        >
          <option value="auto">Small files and files with many deletes</option>
          <option value="small_files">Small files</option>
          <option value="files_with_deletes">Files with deletes</option>
          <option value="full">All files</option>
        </select>
      </label>
      <NumberField label="Target file size (MiB)" value={targetMb} min={1} onChange={setTargetMb} />
      {(strategy === "auto" || strategy === "small_files") && (
        <NumberField label="Small means under (MiB)" value={smallMb} min={1} onChange={setSmallMb} />
      )}
      {(strategy === "auto" || strategy === "files_with_deletes") && (
        <NumberField
          label="Delete files per data file"
          value={minDeletes}
          min={1}
          onChange={setMinDeletes}
        />
      )}
    </TaskCard>
  );
}

function ExpireCard({ target, snapshots }: { target: TableRef; snapshots: number }) {
  const [days, setDays] = useState(7);
  const [keep, setKeep] = useState(5);
  const [clean, setClean] = useState(true);
  const task: MaintenanceTask = {
    kind: "expire_snapshots",
    older_than_days: days,
    retain_last: keep,
    clean_files: clean,
  };
  return (
    <TaskCard
      title="Expire snapshots"
      description={`Drop old snapshots from the metadata. Time travel to them stops working. The table has ${snapshots} snapshot${snapshots === 1 ? "" : "s"}.`}
      target={target}
      task={task}
      canPreview
      confirmText="Expire these snapshots now? This cannot be undone."
    >
      <NumberField label="Older than (days)" value={days} min={0} onChange={setDays} />
      <NumberField label="Always keep the newest" value={keep} min={1} onChange={setKeep} />
      <label className="checkbox">
        <input type="checkbox" checked={clean} onChange={(event) => setClean(event.target.checked)} />
        <span>Delete files only these snapshots used</span>
      </label>
    </TaskCard>
  );
}

function OrphanCard({ target }: { target: TableRef }) {
  const [days, setDays] = useState(3);
  return (
    <TaskCard
      title="Remove orphan files"
      description="Delete files under the table location that no snapshot uses, such as leftovers of failed writes."
      target={target}
      task={{ kind: "remove_orphan_files", older_than_days: days, dry_run: false }}
      dryRunTask={{ kind: "remove_orphan_files", older_than_days: days, dry_run: true }}
      confirmText="Delete orphan files now? Run the dry run first to see the list."
      runLabel="Delete files"
    >
      <NumberField label="Older than (days)" value={days} min={1} onChange={setDays} />
      <p className="muted small">At least 1 day, so files of commits in progress are never touched.</p>
    </TaskCard>
  );
}

function RewriteManifestsCard({ target }: { target: TableRef }) {
  return (
    <TaskCard
      title="Rewrite manifests"
      description="Merge the current snapshot's manifests so planning reads fewer files. Data files are untouched."
      target={target}
      task={{ kind: "rewrite_manifests" }}
      canPreview
      confirmText="Rewrite manifests now?"
    />
  );
}

function TaskCard(props: {
  title: string;
  description: string;
  target: TableRef;
  task: MaintenanceTask;
  canPreview?: boolean;
  /** Runs as a job instead of a preview (orphan files). */
  dryRunTask?: MaintenanceTask;
  confirmText: string;
  runLabel?: string;
  children?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<MaintenancePreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [cron, setCron] = useState(CRON_PRESETS[0].cron);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
    queryClient.invalidateQueries({ queryKey: ["schedules"] });
    queryClient.invalidateQueries({ queryKey: ["table"] });
    queryClient.invalidateQueries({ queryKey: ["files"] });
  };

  const previewMutation = useMutation({
    mutationFn: () => api.preview(props.target, props.task),
    onSuccess: (result) => {
      setPreview(result);
      setNotice(null);
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  const submit = useMutation({
    mutationFn: (task: MaintenanceTask) => api.submitJob(props.target, task),
    onSuccess: (job) => {
      setNotice(`Job #${job.id} queued. Its result appears under Recent jobs.`);
      refresh();
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  const schedule = useMutation({
    mutationFn: () =>
      api.createSchedule({ ...props.target, task: props.task, cron: cron.trim(), enabled: true }),
    onSuccess: (created) => {
      setScheduling(false);
      setNotice(`Scheduled: ${describeTask(created.task)} — ${created.cron_description || created.cron}.`);
      refresh();
    },
    onError: (error) => setNotice(errorMessage(error)),
  });

  return (
    <section className="task-card">
      <h3>{props.title}</h3>
      <p className="muted small">{props.description}</p>
      {props.children && <div className="task-settings">{props.children}</div>}
      <div className="actions">
        {props.canPreview && (
          <button className="secondary" disabled={previewMutation.isPending} onClick={() => previewMutation.mutate()}>
            {previewMutation.isPending ? "Checking…" : "Preview"}
          </button>
        )}
        {props.dryRunTask && (
          <button className="secondary" disabled={submit.isPending} onClick={() => submit.mutate(props.dryRunTask!)}>
            Dry run
          </button>
        )}
        <button
          className="primary"
          disabled={submit.isPending}
          onClick={() => {
            if (confirm(props.confirmText)) submit.mutate(props.task);
          }}
        >
          {props.runLabel ?? "Run now"}
        </button>
        <button className="link" onClick={() => setScheduling(!scheduling)}>
          Schedule…
        </button>
      </div>
      {scheduling && (
        <div className="schedule-form">
          <select
            value={CRON_PRESETS.some((preset) => preset.cron === cron) ? cron : ""}
            onChange={(event) => event.target.value && setCron(event.target.value)}
          >
            {CRON_PRESETS.map((preset) => (
              <option key={preset.cron} value={preset.cron}>
                {preset.label}
              </option>
            ))}
            <option value="">Custom…</option>
          </select>
          <input
            className="mono"
            value={cron}
            onChange={(event) => setCron(event.target.value)}
            aria-label="Cron expression"
          />
          <button className="secondary" disabled={schedule.isPending} onClick={() => schedule.mutate()}>
            Save schedule
          </button>
          <p className="muted small">
            Cron: minute hour day month weekday, in this server's local time. The schedule runs the
            settings above.
          </p>
        </div>
      )}
      {preview && <PreviewView preview={preview} />}
      {notice && <div className="notice">{notice}</div>}
    </section>
  );
}

function PreviewView({ preview }: { preview: MaintenancePreview }) {
  switch (preview.kind) {
    case "compact":
      return (
        <div className="notice ok">
          {preview.data_files === 0
            ? "No files match; a run would do nothing."
            : `Would rewrite ${formatNumber(preview.data_files)} data files (${formatBytes(preview.bytes)})` +
              (preview.delete_files ? ` and ${formatNumber(preview.delete_files)} delete files` : "") +
              ` in ${preview.groups.length} group${preview.groups.length === 1 ? "" : "s"}.`}
        </div>
      );
    case "expire_snapshots":
      return (
        <div className="notice ok">
          {preview.expired_snapshot_ids.length === 0
            ? "No snapshot is old enough; a run would do nothing."
            : `Would expire ${preview.expired_snapshot_ids.length} snapshot${preview.expired_snapshot_ids.length === 1 ? "" : "s"} and keep ${preview.remaining_snapshots}.`}
          {preview.expired_snapshot_ids.length > 0 && (
            <details className="paths">
              <summary>Snapshot ids</summary>
              <ul className="mono">
                {preview.expired_snapshot_ids.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      );
    case "rewrite_manifests":
      return (
        <div className="notice ok">
          {preview.data_manifests <= 1
            ? "The current snapshot has at most one data manifest; nothing to merge."
            : `The current snapshot has ${preview.data_manifests} data manifests; a run merges them.`}
        </div>
      );
  }
}

function NumberField(props: { label: string; value: number; min: number; onChange: (value: number) => void }) {
  return (
    <label>
      <span>{props.label}</span>
      <input
        type="number"
        min={props.min}
        value={props.value}
        onChange={(event) => props.onChange(Math.max(props.min, Number(event.target.value) || props.min))}
      />
    </label>
  );
}
