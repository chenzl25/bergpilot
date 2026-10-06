// Job status badges, and toasts when a job finishes while the UI is open.

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CircleCheck, CircleX, Clock } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { api } from "@/api/client";
import type { JobInfo } from "@/api/generated/JobInfo";
import type { JobStatus } from "@/api/generated/JobStatus";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { tablePath } from "@/format";
import { describeOutcome, isActive, TASK_LABELS } from "@/jobs";
import { cn } from "@/lib/utils";

const STATUS: Record<JobStatus, { label: string; className: string }> = {
  queued: { label: "Queued", className: "text-muted-foreground" },
  running: { label: "Running", className: "text-primary" },
  succeeded: { label: "Succeeded", className: "text-success" },
  failed: { label: "Failed", className: "text-destructive" },
  cancelled: { label: "Cancelled", className: "text-muted-foreground" },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const config = STATUS[status];
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", config.className)}>
      {status === "queued" && <Clock />}
      {status === "running" && <Spinner className="size-3" />}
      {status === "succeeded" && <CircleCheck />}
      {status === "failed" && <CircleX />}
      {status === "cancelled" && <Ban />}
      {config.label}
    </Badge>
  );
}

function fullName(job: JobInfo): string {
  return `${job.catalog_name}.${job.namespace.join(".")}.${job.table}`;
}

/**
 * Polls recent jobs (fast while any is active) and announces the ones that
 * finish. Returns how many jobs are queued or running.
 */
export function useJobWatcher(): number {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mountedAt = useRef(Date.now());
  const seen = useRef<Map<number, JobStatus> | null>(null);
  const jobs = useQuery({
    queryKey: ["jobs", "watch"],
    queryFn: () => api.jobs(undefined, 25),
    refetchInterval: (query) => (query.state.data?.some(isActive) ? 2000 : 15_000),
  });

  useEffect(() => {
    if (!jobs.data) return;
    const previous = seen.current;
    seen.current = new Map(jobs.data.map((job) => [job.id, job.status]));
    if (!previous) return;
    let finished = false;
    for (const job of jobs.data) {
      if (isActive(job)) continue;
      const before = previous.get(job.id);
      const wasActive = before === "queued" || before === "running";
      const newSinceMount = before === undefined && Date.parse(job.finished_at ?? "") > mountedAt.current;
      if (!wasActive && !newSinceMount) continue;
      finished = true;
      const title = TASK_LABELS[job.task.kind];
      const view = {
        label: "View",
        onClick: () => navigate(`${tablePath(job.catalog_id, job.namespace, job.table)}?tab=maintenance`),
      };
      if (job.status === "succeeded") {
        toast.success(`${title} finished`, {
          description: `${fullName(job)}: ${job.outcome ? describeOutcome(job.outcome) : "done"}`,
          action: view,
        });
      } else if (job.status === "failed") {
        toast.error(`${title} failed`, { description: `${fullName(job)}: ${job.error ?? "unknown error"}`, action: view });
      } else {
        toast(`${title} cancelled`, { description: fullName(job) });
      }
    }
    if (finished) {
      for (const key of ["table", "files", "partitions", "namespace", "jobs"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    }
  }, [jobs.data, navigate, queryClient]);

  return jobs.data?.filter(isActive).length ?? 0;
}
