create table schedules (
    id integer primary key autoincrement,
    catalog_id integer not null references catalogs(id) on delete cascade,
    namespace text not null,
    table_name text not null,
    kind text not null,
    task text not null,
    cron text not null,
    enabled integer not null default 1,
    next_run_ms integer,
    last_job_id integer,
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table jobs (
    id integer primary key autoincrement,
    catalog_id integer not null references catalogs(id) on delete cascade,
    -- JSON array of namespace levels.
    namespace text not null,
    table_name text not null,
    kind text not null,
    -- JSON MaintenanceTask.
    task text not null,
    status text not null,
    schedule_id integer references schedules(id) on delete set null,
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    started_at text,
    finished_at text,
    -- JSON JobOutcome.
    outcome text,
    error text
);

create index jobs_status_idx on jobs(status, id);
create index jobs_table_idx on jobs(catalog_id, table_name, id);
