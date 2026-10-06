import { useQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";

import { api } from "@/api/client";
import { JobsTable, SchedulesTable } from "@/components/JobsTable";
import { ErrorNotice, Page, PageHeader, Section } from "@/components/page";
import { Skeleton } from "@/components/ui/skeleton";
import { isActive } from "@/jobs";

export function JobsPage() {
  const jobs = useQuery({
    queryKey: ["jobs", "all"],
    queryFn: () => api.jobs(undefined, 200),
    refetchInterval: (query) => (query.state.data?.some(isActive) ? 1500 : 10_000),
  });
  const schedules = useQuery({ queryKey: ["schedules", "all"], queryFn: () => api.schedules() });
  const running = jobs.data?.filter(isActive).length ?? 0;
  return (
    <Page>
      <PageHeader
        icon={ListChecks}
        title="Jobs"
        meta={
          <span>
            Maintenance jobs across all tables. Start them from a table's Maintenance tab.
            {running > 0 && ` ${running} running now.`}
          </span>
        }
      />
      <Section title="Schedules">
        {schedules.isPending && <Skeleton className="h-16 rounded-xl" />}
        {schedules.isError && <ErrorNotice error={schedules.error} />}
        {schedules.data && <SchedulesTable schedules={schedules.data} showTable />}
      </Section>
      <Section title="History">
        {jobs.isPending && <Skeleton className="h-40 rounded-xl" />}
        {jobs.isError && <ErrorNotice error={jobs.error} />}
        {jobs.data && <JobsTable jobs={jobs.data} showTable />}
      </Section>
    </Page>
  );
}
