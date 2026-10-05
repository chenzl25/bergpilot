import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { JobsTable, SchedulesTable } from "../components/JobsTable";
import { errorMessage } from "../components/Layout";
import { isActive } from "../jobs";

export function JobsPage() {
  const jobs = useQuery({
    queryKey: ["jobs", "all"],
    queryFn: () => api.jobs(undefined, 200),
    refetchInterval: (query) => (query.state.data?.some(isActive) ? 1500 : 10_000),
  });
  const schedules = useQuery({ queryKey: ["schedules", "all"], queryFn: () => api.schedules() });
  return (
    <div className="page">
      <div className="page-header">
        <h1>Jobs</h1>
      </div>
      <p className="muted">
        Maintenance jobs across all tables. Start them from a table's Maintenance tab.
      </p>
      <h2>Schedules</h2>
      {schedules.isError && <p className="error">{errorMessage(schedules.error)}</p>}
      {schedules.data && <SchedulesTable schedules={schedules.data} showTable />}
      <h2>History</h2>
      {jobs.isPending && <p className="muted">Loading…</p>}
      {jobs.isError && <p className="error">{errorMessage(jobs.error)}</p>}
      {jobs.data && <JobsTable jobs={jobs.data} showTable />}
    </div>
  );
}
