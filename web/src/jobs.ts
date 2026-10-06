// Plain-language descriptions of maintenance tasks and their outcomes.

import type { JobInfo } from "./api/generated/JobInfo";
import type { JobOutcome } from "./api/generated/JobOutcome";
import type { JobProgress } from "./api/generated/JobProgress";
import type { MaintenanceTask } from "./api/generated/MaintenanceTask";
import { formatBytes, formatNumber } from "./format";

export const TASK_LABELS: Record<MaintenanceTask["kind"], string> = {
  compact: "Compact data files",
  expire_snapshots: "Expire snapshots",
  remove_orphan_files: "Remove orphan files",
  rewrite_manifests: "Rewrite manifests",
};

const STRATEGY_LABELS = {
  auto: "small files and files with many deletes",
  small_files: "small files",
  files_with_deletes: "files with deletes",
  full: "all files",
};

export function describeTask(task: MaintenanceTask): string {
  switch (task.kind) {
    case "compact":
      return `Compact ${STRATEGY_LABELS[task.strategy]} into ${task.target_file_size_mb ?? 512} MiB files`;
    case "expire_snapshots":
      return (
        `Expire snapshots older than ${task.older_than_days} day${task.older_than_days === 1 ? "" : "s"}, ` +
        `keep ${task.retain_last}` +
        (task.clean_files ? ", delete their files" : "")
      );
    case "remove_orphan_files":
      return `${task.dry_run ? "Find" : "Remove"} orphan files older than ${task.older_than_days} day${task.older_than_days === 1 ? "" : "s"}`;
    case "rewrite_manifests":
      return "Rewrite manifests";
  }
}

export function describeOutcome(outcome: JobOutcome): string {
  switch (outcome.kind) {
    case "compact":
      if (!outcome.rewrote) return "Nothing to compact";
      return (
        `Rewrote ${formatNumber(outcome.input_data_files)} data files (${formatBytes(outcome.input_bytes)})` +
        (outcome.input_delete_files ? ` and ${formatNumber(outcome.input_delete_files)} delete files` : "") +
        ` into ${formatNumber(outcome.output_files)} (${formatBytes(outcome.output_bytes)})`
      );
    case "expire_snapshots": {
      const count = outcome.expired_snapshot_ids.length;
      if (count === 0) return "No snapshots to expire";
      return (
        `Expired ${formatNumber(count)} snapshot${count === 1 ? "" : "s"}, ${formatNumber(outcome.remaining_snapshots)} left` +
        (outcome.cleaned_files ? "; their files were deleted" : "")
      );
    }
    case "remove_orphan_files":
      if (outcome.count === 0) return "No orphan files";
      return `${outcome.dry_run ? "Found" : "Deleted"} ${formatNumber(outcome.count)} orphan file${outcome.count === 1 ? "" : "s"}`;
    case "rewrite_manifests":
      if (outcome.manifests_before === outcome.manifests_after) {
        return `Nothing to merge (${outcome.manifests_before} manifest${outcome.manifests_before === 1 ? "" : "s"})`;
      }
      return `Merged ${outcome.manifests_before} manifests into ${outcome.manifests_after}`;
  }
}

/** How much of a running job is done, in percent; undefined until known. */
export function progressPercent(progress: JobProgress): number | undefined {
  if (progress.phase === "committing") return 100;
  if (progress.phase === "planning" || progress.bytes_total === 0) return undefined;
  return Math.min(100, (100 * progress.bytes_done) / progress.bytes_total);
}

export function describeProgress(progress: JobProgress): string {
  switch (progress.phase) {
    case "planning":
      return "Finding files to rewrite";
    case "rewriting":
      return (
        `Read ${formatNumber(progress.files_done)} of ${formatNumber(progress.files_total)} data files, ` +
        `${formatBytes(progress.bytes_done)} of ${formatBytes(progress.bytes_total)}`
      );
    case "committing":
      return `Committing ${formatNumber(progress.files_total)} rewritten files`;
  }
}

export function isActive(job: JobInfo): boolean {
  return job.status === "queued" || job.status === "running";
}

/** Seconds between two ISO timestamps, as "12 s" or "3 min". */
export function formatDuration(start?: string, end?: string): string {
  if (!start) return "";
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds} s`;
  return `${Math.round(seconds / 60)} min`;
}

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Every day at 02:00", cron: "0 2 * * *" },
  { label: "Every Sunday at 03:00", cron: "0 3 * * 0" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
];
