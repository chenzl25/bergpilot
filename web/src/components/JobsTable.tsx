import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ChevronDown, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";

import { api } from "@/api/client";
import type { JobInfo } from "@/api/generated/JobInfo";
import type { ScheduleInfo } from "@/api/generated/ScheduleInfo";
import { useConfirm } from "@/components/confirm";
import { JobProgressView, JobStatusBadge } from "@/components/job-status";
import { Panel } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTime, tablePath } from "@/format";
import { describeOutcome, describeTask, formatDuration, isActive } from "@/jobs";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

function TableLink({ item }: { item: { catalog_id: number; catalog_name: string; namespace: string[]; table: string } }) {
  return (
    <Link
      className="font-mono text-[13px] text-foreground hover:text-primary hover:underline"
      to={`${tablePath(item.catalog_id, item.namespace, item.table)}?tab=maintenance`}
    >
      {item.catalog_name}.{item.namespace.join(".")}.{item.table}
    </Link>
  );
}

export function JobsTable({ jobs, showTable }: { jobs: JobInfo[]; showTable: boolean }) {
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: (id: number) => api.cancelJob(id),
    onError: (error) => toast.error("Could not stop the job", { description: errorMessage(error) }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });
  if (jobs.length === 0) {
    return (
      <Panel>
        <p className="px-4 py-3 text-sm text-muted-foreground">No jobs yet.</p>
      </Panel>
    );
  }
  return (
    <Panel>
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className="w-20">Job</TableHead>
            {showTable && <TableHead>Table</TableHead>}
            <TableHead>Task</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Started</TableHead>
            <TableHead className="text-right">Took</TableHead>
            <TableHead>Result</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <TableRow key={job.id}>
              <TableCell className="text-muted-foreground tabular-nums">
                <span className="flex items-center gap-1.5">
                  #{job.id}
                  {job.schedule_id !== undefined && (
                    <CalendarClock className="size-3.5" aria-label="Started by a schedule" />
                  )}
                </span>
              </TableCell>
              {showTable && (
                <TableCell>
                  <TableLink item={job} />
                </TableCell>
              )}
              <TableCell className="max-w-72 whitespace-normal">{describeTask(job.task)}</TableCell>
              <TableCell>
                <JobStatusBadge status={job.status} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {job.started_at ? formatTime(Date.parse(job.started_at)) : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatDuration(job.started_at, job.finished_at)}</TableCell>
              <TableCell className={cn("max-w-96 whitespace-normal", job.error && "text-destructive")}>
                {job.status === "running" && job.progress && <JobProgressView progress={job.progress} />}
                {job.outcome ? describeOutcome(job.outcome) : (job.error ?? "")}
                {job.outcome?.kind === "remove_orphan_files" && job.outcome.files.length > 0 && (
                  <Collapsible>
                    <CollapsibleTrigger className="group mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                      <ChevronDown className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
                      Show files
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ul className="mt-1 max-h-48 overflow-y-auto font-mono text-xs break-all">
                        {job.outcome.files.map((file) => (
                          <li key={file}>{file}</li>
                        ))}
                      </ul>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </TableCell>
              <TableCell className="text-right">
                {isActive(job) && (
                  <Button variant="ghost" size="xs" disabled={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
                    {job.status === "running" ? "Stop" : "Cancel"}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

export function SchedulesTable({ schedules, showTable }: { schedules: ScheduleInfo[]; showTable: boolean }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
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
    onError: (error) => toast.error("Could not change the schedule", { description: errorMessage(error) }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteSchedule(id),
    onSuccess: () => toast.success("Schedule deleted"),
    onError: (error) => toast.error("Could not delete the schedule", { description: errorMessage(error) }),
    onSettled: refresh,
  });
  if (schedules.length === 0) {
    return (
      <Empty className="rounded-xl border border-dashed py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarClock />
          </EmptyMedia>
          <EmptyTitle>No schedules</EmptyTitle>
          <EmptyDescription>
            Open an operation on a table's Maintenance tab and choose “Run on a schedule”.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Panel>
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className="w-14">On</TableHead>
            {showTable && <TableHead>Table</TableHead>}
            <TableHead>Task</TableHead>
            <TableHead>When</TableHead>
            <TableHead>Next run</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {schedules.map((schedule) => (
            <TableRow key={schedule.id} className={cn(!schedule.enabled && "text-muted-foreground")}>
              <TableCell>
                <Switch
                  size="sm"
                  checked={schedule.enabled}
                  aria-label={schedule.enabled ? "Pause" : "Resume"}
                  onCheckedChange={() => toggle.mutate(schedule)}
                />
              </TableCell>
              {showTable && (
                <TableCell>
                  <TableLink item={schedule} />
                </TableCell>
              )}
              <TableCell className="max-w-72 whitespace-normal">{describeTask(schedule.task)}</TableCell>
              <TableCell>
                <div>{schedule.cron_description || schedule.cron}</div>
                <div className="font-mono text-xs text-muted-foreground">{schedule.cron}</div>
              </TableCell>
              <TableCell>
                {schedule.enabled && schedule.next_run_ms ? (
                  formatTime(schedule.next_run_ms)
                ) : (
                  <Badge variant="secondary">Paused</Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete schedule"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Delete this schedule?",
                      description: "Jobs it already ran are kept.",
                      confirmLabel: "Delete",
                      destructive: true,
                    });
                    if (ok) remove.mutate(schedule.id);
                  }}
                >
                  <Trash2 />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}
