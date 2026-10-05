import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";

import { api } from "../api/client";
import type { JobInfo } from "../api/generated/JobInfo";
import type { ScheduleInfo } from "../api/generated/ScheduleInfo";
import { formatTime, tablePath } from "../format";
import { describeOutcome, describeTask, formatDuration, isActive } from "../jobs";
import { errorMessage } from "./Layout";

export function JobsTable({ jobs, showTable }: { jobs: JobInfo[]; showTable: boolean }) {
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: (id: number) => api.cancelJob(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });
  if (jobs.length === 0) return <p className="muted">No jobs yet.</p>;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Job</th>
          {showTable && <th>Table</th>}
          <th>Task</th>
          <th>Status</th>
          <th>Started</th>
          <th className="right">Took</th>
          <th>Result</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr key={job.id}>
            <td className="muted nowrap">
              #{job.id}
              {job.schedule_id !== undefined && <span className="badge">scheduled</span>}
            </td>
            {showTable && (
              <td className="nowrap">
                <Link to={`${tablePath(job.catalog_id, job.namespace, job.table)}?tab=maintenance`}>
                  {job.catalog_name}.{job.namespace.join(".")}.{job.table}
                </Link>
              </td>
            )}
            <td>{describeTask(job.task)}</td>
            <td>
              <span className={`status status-${job.status}`}>{job.status}</span>
            </td>
            <td className="nowrap">{job.started_at ? formatTime(Date.parse(job.started_at)) : "—"}</td>
            <td className="right nowrap">{formatDuration(job.started_at, job.finished_at)}</td>
            <td className={job.error ? "error" : ""}>
              {job.outcome ? describeOutcome(job.outcome) : job.error ?? ""}
              {job.outcome?.kind === "remove_orphan_files" && job.outcome.files.length > 0 && (
                <details className="paths">
                  <summary>Show files</summary>
                  <ul className="mono">
                    {job.outcome.files.map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                </details>
              )}
            </td>
            <td className="right">
              {isActive(job) && (
                <button className="link" disabled={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
                  {job.status === "running" ? "Stop" : "Cancel"}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
      {cancel.isError && (
        <caption className="error">{errorMessage(cancel.error)}</caption>
      )}
    </table>
  );
}

export function SchedulesTable({ schedules, showTable }: { schedules: ScheduleInfo[]; showTable: boolean }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["schedules"] });
  const toggle = useMutation({
    mutationFn: (schedule: ScheduleInfo) =>
      api.updateSchedule(schedule.id, {
        catalog_id: schedule.catalog_id,
        namespace: schedule.namespace,
        table: schedule.table,
        task: schedule.task,
        cron: schedule.cron,
        enabled: !schedule.enabled,
      }),
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: (id: number) => api.deleteSchedule(id), onSettled: refresh });
  if (schedules.length === 0) return <p className="muted">No schedules.</p>;
  return (
    <table className="grid">
      <thead>
        <tr>
          {showTable && <th>Table</th>}
          <th>Task</th>
          <th>When</th>
          <th>Next run</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {schedules.map((schedule) => (
          <tr key={schedule.id} className={schedule.enabled ? "" : "disabled-row"}>
            {showTable && (
              <td className="nowrap">
                <Link to={`${tablePath(schedule.catalog_id, schedule.namespace, schedule.table)}?tab=maintenance`}>
                  {schedule.catalog_name}.{schedule.namespace.join(".")}.{schedule.table}
                </Link>
              </td>
            )}
            <td>{describeTask(schedule.task)}</td>
            <td>
              {schedule.cron_description || schedule.cron}
              <div className="muted small mono">{schedule.cron}</div>
            </td>
            <td className="nowrap">
              {schedule.enabled && schedule.next_run_ms ? formatTime(schedule.next_run_ms) : "Paused"}
            </td>
            <td className="right nowrap">
              <button className="link" onClick={() => toggle.mutate(schedule)}>
                {schedule.enabled ? "Pause" : "Resume"}
              </button>
              <button
                className="link"
                onClick={() => {
                  if (confirm("Delete this schedule? Jobs it already ran are kept.")) remove.mutate(schedule.id);
                }}
              >
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
