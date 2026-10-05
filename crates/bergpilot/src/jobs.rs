//! Maintenance jobs and schedules.
//!
//! Jobs live in SQLite. A worker loop starts queued jobs, at most one per
//! table and `MaintenanceLimits::max_running_jobs` overall, and records their
//! outcome. A scheduler
//! loop queues jobs for due schedules; it advances a schedule's next run
//! before queueing, so a slow job is never queued twice for the same tick.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use chrono::{Local, Utc};
use croner::Cron;
use iceberg::{NamespaceIdent, TableIdent};
use sqlx::{Row, SqlitePool};
use tokio::sync::{Mutex, Notify};
use tokio::task::AbortHandle;

use crate::catalogs::CatalogRegistry;
use crate::error::{ApiError, ApiResult};
use crate::maintenance::{self, MaintenanceLimits};
use crate::types::{
    JobInfo, JobOutcome, JobStatus, MaintenanceTask, ScheduleInfo, ScheduleInput, TableRef,
};

const DISPATCH_INTERVAL: Duration = Duration::from_secs(2);
const SCHEDULE_INTERVAL: Duration = Duration::from_secs(20);

const JOB_COLUMNS: &str = "j.id, j.catalog_id, c.name as catalog_name, j.namespace, j.table_name, \
     j.task, j.status, j.schedule_id, j.created_at, j.started_at, j.finished_at, j.outcome, j.error";
const SCHEDULE_COLUMNS: &str = "s.id, s.catalog_id, c.name as catalog_name, s.namespace, \
     s.table_name, s.task, s.cron, s.enabled, s.next_run_ms, s.last_job_id, s.created_at";

#[derive(Clone)]
pub struct Jobs {
    pool: SqlitePool,
    registry: CatalogRegistry,
    limits: MaintenanceLimits,
    wake: Arc<Notify>,
    running: Arc<Mutex<HashMap<i64, Running>>>,
}

struct Running {
    table: TableKey,
    abort: AbortHandle,
}

type TableKey = (i64, Vec<String>, String);

#[derive(Debug, Clone, Default)]
pub struct JobFilter {
    pub target: Option<TableRef>,
    pub limit: Option<u32>,
}

impl Jobs {
    pub fn new(pool: SqlitePool, registry: CatalogRegistry, limits: MaintenanceLimits) -> Self {
        Self {
            pool,
            registry,
            limits,
            wake: Arc::new(Notify::new()),
            running: Arc::default(),
        }
    }

    pub fn limits(&self) -> &MaintenanceLimits {
        &self.limits
    }

    /// Mark jobs interrupted by a restart, then start the worker and the
    /// scheduler.
    pub async fn start(&self) -> anyhow::Result<()> {
        sqlx::query(
            "update jobs set status = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
             error = 'BergPilot stopped while this job was running' where status = 'running'",
        )
        .execute(&self.pool)
        .await?;
        let worker = self.clone();
        tokio::spawn(async move {
            loop {
                if let Err(error) = worker.dispatch().await {
                    tracing::warn!(%error, "job dispatch failed");
                }
                tokio::select! {
                    _ = worker.wake.notified() => {}
                    _ = tokio::time::sleep(DISPATCH_INTERVAL) => {}
                }
            }
        });
        let scheduler = self.clone();
        tokio::spawn(async move {
            loop {
                if let Err(error) = scheduler.queue_due_schedules().await {
                    tracing::warn!(%error, "schedule check failed");
                }
                tokio::time::sleep(SCHEDULE_INTERVAL).await;
            }
        });
        Ok(())
    }

    pub async fn submit(
        &self,
        target: &TableRef,
        task: &MaintenanceTask,
        schedule_id: Option<i64>,
    ) -> ApiResult<JobInfo> {
        maintenance::validate(task)?;
        // Fails early for a missing catalog.
        self.registry.store().get_catalog(target.catalog_id).await?;
        let id = sqlx::query(
            "insert into jobs (catalog_id, namespace, table_name, kind, task, status, schedule_id) \
             values (?, ?, ?, ?, ?, 'queued', ?)",
        )
        .bind(target.catalog_id)
        .bind(json(&target.namespace)?)
        .bind(&target.table)
        .bind(task.kind())
        .bind(json(task)?)
        .bind(schedule_id)
        .execute(&self.pool)
        .await?
        .last_insert_rowid();
        self.wake.notify_one();
        self.get(id).await
    }

    pub async fn get(&self, id: i64) -> ApiResult<JobInfo> {
        let row = sqlx::query(&format!(
            "select {JOB_COLUMNS} from jobs j join catalogs c on c.id = j.catalog_id where j.id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("job {id} does not exist")))?;
        decode_job(&row)
    }

    pub async fn list(&self, filter: &JobFilter) -> ApiResult<Vec<JobInfo>> {
        let limit = filter.limit.unwrap_or(100).clamp(1, 500);
        let rows = match &filter.target {
            Some(target) => {
                sqlx::query(&format!(
                    "select {JOB_COLUMNS} from jobs j join catalogs c on c.id = j.catalog_id \
                     where j.catalog_id = ? and j.namespace = ? and j.table_name = ? \
                     order by j.id desc limit ?"
                ))
                .bind(target.catalog_id)
                .bind(json(&target.namespace)?)
                .bind(&target.table)
                .bind(limit)
                .fetch_all(&self.pool)
                .await?
            }
            None => {
                sqlx::query(&format!(
                    "select {JOB_COLUMNS} from jobs j join catalogs c on c.id = j.catalog_id \
                     order by j.id desc limit ?"
                ))
                .bind(limit)
                .fetch_all(&self.pool)
                .await?
            }
        };
        rows.iter().map(decode_job).collect()
    }

    /// Cancel a queued job, or stop a running one. A stopped compaction may
    /// leave unreferenced files behind; orphan-file removal cleans them up.
    pub async fn cancel(&self, id: i64) -> ApiResult<JobInfo> {
        let queued = sqlx::query(
            "update jobs set status = 'cancelled', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
             where id = ? and status = 'queued'",
        )
        .bind(id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if queued == 0
            && let Some(running) = self.running.lock().await.remove(&id)
        {
            running.abort.abort();
            sqlx::query(
                "update jobs set status = 'cancelled', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                 error = 'Stopped by the user; files written so far may remain as orphans' \
                 where id = ? and status = 'running'",
            )
            .bind(id)
            .execute(&self.pool)
            .await?;
            self.wake.notify_one();
        }
        self.get(id).await
    }

    /// Start queued jobs while there is room, oldest first, skipping tables
    /// that already have a running job.
    async fn dispatch(&self) -> ApiResult<()> {
        let queued = sqlx::query(&format!(
            "select {JOB_COLUMNS} from jobs j join catalogs c on c.id = j.catalog_id \
             where j.status = 'queued' order by j.id limit 50"
        ))
        .fetch_all(&self.pool)
        .await?;
        for row in &queued {
            let job = decode_job(row)?;
            let key: TableKey = (
                job.target.catalog_id,
                job.target.namespace.clone(),
                job.target.table.clone(),
            );
            let mut running = self.running.lock().await;
            if running.len() >= self.limits.max_running_jobs.max(1) {
                break;
            }
            if running.values().any(|other| other.table == key) {
                continue;
            }
            let claimed = sqlx::query(
                "update jobs set status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 where id = ? and status = 'queued'",
            )
            .bind(job.id)
            .execute(&self.pool)
            .await?
            .rows_affected();
            if claimed == 0 {
                continue;
            }
            let runner = self.clone();
            let id = job.id;
            let handle = tokio::spawn(async move { runner.execute(job).await });
            running.insert(
                id,
                Running {
                    table: key,
                    abort: handle.abort_handle(),
                },
            );
        }
        Ok(())
    }

    async fn execute(&self, job: JobInfo) {
        let id = job.id;
        tracing::info!(job = id, kind = job.task.kind(), table = %job.target.table, "job started");
        let result = self.run_task(&job).await;
        // A cancelled job was already removed from `running` and recorded.
        if self.running.lock().await.remove(&id).is_none() {
            return;
        }
        let update = match &result {
            Ok(outcome) => sqlx::query(
                "update jobs set status = 'succeeded', outcome = ?, \
                 finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = ?",
            )
            .bind(serde_json::to_string(outcome).unwrap_or_default())
            .bind(id),
            Err(error) => sqlx::query(
                "update jobs set status = 'failed', error = ?, \
                 finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = ?",
            )
            .bind(error.to_string())
            .bind(id),
        };
        if let Err(error) = update.execute(&self.pool).await {
            tracing::error!(job = id, %error, "failed to record the job result");
        }
        match &result {
            Ok(_) => tracing::info!(job = id, "job succeeded"),
            Err(error) => tracing::warn!(job = id, %error, "job failed"),
        }
        self.wake.notify_one();
    }

    async fn run_task(&self, job: &JobInfo) -> ApiResult<JobOutcome> {
        let connected = self.registry.get(job.target.catalog_id).await?;
        let ident = TableIdent::new(
            NamespaceIdent::from_vec(job.target.namespace.clone())?,
            job.target.table.clone(),
        );
        maintenance::run(
            connected.catalog,
            &connected.record.name,
            &ident,
            &job.task,
            &self.limits,
        )
        .await
    }

    // -- Schedules ---------------------------------------------------------

    pub async fn list_schedules(&self, target: Option<&TableRef>) -> ApiResult<Vec<ScheduleInfo>> {
        let rows = match target {
            Some(target) => sqlx::query(&format!(
                "select {SCHEDULE_COLUMNS} from schedules s join catalogs c on c.id = s.catalog_id \
                     where s.catalog_id = ? and s.namespace = ? and s.table_name = ? order by s.id"
            ))
            .bind(target.catalog_id)
            .bind(json(&target.namespace)?)
            .bind(&target.table)
            .fetch_all(&self.pool)
            .await?,
            None => sqlx::query(&format!(
                "select {SCHEDULE_COLUMNS} from schedules s join catalogs c on c.id = s.catalog_id \
                     order by s.id"
            ))
            .fetch_all(&self.pool)
            .await?,
        };
        rows.iter().map(decode_schedule).collect()
    }

    pub async fn get_schedule(&self, id: i64) -> ApiResult<ScheduleInfo> {
        let row = sqlx::query(&format!(
            "select {SCHEDULE_COLUMNS} from schedules s join catalogs c on c.id = s.catalog_id \
             where s.id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("schedule {id} does not exist")))?;
        decode_schedule(&row)
    }

    pub async fn create_schedule(&self, input: &ScheduleInput) -> ApiResult<ScheduleInfo> {
        let next = validate_schedule(input)?;
        self.registry
            .store()
            .get_catalog(input.target.catalog_id)
            .await?;
        let id = sqlx::query(
            "insert into schedules (catalog_id, namespace, table_name, kind, task, cron, enabled, next_run_ms) \
             values (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(input.target.catalog_id)
        .bind(json(&input.target.namespace)?)
        .bind(&input.target.table)
        .bind(input.task.kind())
        .bind(json(&input.task)?)
        .bind(input.cron.trim())
        .bind(input.enabled)
        .bind(next)
        .execute(&self.pool)
        .await?
        .last_insert_rowid();
        self.get_schedule(id).await
    }

    pub async fn update_schedule(&self, id: i64, input: &ScheduleInput) -> ApiResult<ScheduleInfo> {
        let next = validate_schedule(input)?;
        let updated = sqlx::query(
            "update schedules set catalog_id = ?, namespace = ?, table_name = ?, kind = ?, task = ?, \
             cron = ?, enabled = ?, next_run_ms = ? where id = ?",
        )
        .bind(input.target.catalog_id)
        .bind(json(&input.target.namespace)?)
        .bind(&input.target.table)
        .bind(input.task.kind())
        .bind(json(&input.task)?)
        .bind(input.cron.trim())
        .bind(input.enabled)
        .bind(next)
        .bind(id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if updated == 0 {
            return Err(ApiError::NotFound(format!("schedule {id} does not exist")));
        }
        self.get_schedule(id).await
    }

    pub async fn delete_schedule(&self, id: i64) -> ApiResult<()> {
        let deleted = sqlx::query("delete from schedules where id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if deleted == 0 {
            return Err(ApiError::NotFound(format!("schedule {id} does not exist")));
        }
        Ok(())
    }

    /// Queue a job for every enabled schedule whose time has come. A
    /// schedule whose previous job is still queued or running is skipped for
    /// this tick. The scheduler loop calls this; it is public for tests.
    pub async fn queue_due_schedules(&self) -> ApiResult<()> {
        let now = Utc::now().timestamp_millis();
        let due = sqlx::query(&format!(
            "select {SCHEDULE_COLUMNS} from schedules s join catalogs c on c.id = s.catalog_id \
             where s.enabled = 1 and s.next_run_ms is not null and s.next_run_ms <= ?"
        ))
        .bind(now)
        .fetch_all(&self.pool)
        .await?;
        for row in &due {
            let schedule = decode_schedule(row)?;
            let next = next_run_ms(&schedule.cron)?;
            sqlx::query("update schedules set next_run_ms = ? where id = ?")
                .bind(next)
                .bind(schedule.id)
                .execute(&self.pool)
                .await?;
            let busy: i64 = sqlx::query_scalar(
                "select count(*) from jobs where schedule_id = ? and status in ('queued', 'running')",
            )
            .bind(schedule.id)
            .fetch_one(&self.pool)
            .await?;
            if busy > 0 {
                tracing::info!(
                    schedule = schedule.id,
                    "previous run still in progress; skipping"
                );
                continue;
            }
            let job = self
                .submit(&schedule.target, &schedule.task, Some(schedule.id))
                .await?;
            sqlx::query("update schedules set last_job_id = ? where id = ?")
                .bind(job.id)
                .bind(schedule.id)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }
}

/// Validate a schedule and return its first run time.
fn validate_schedule(input: &ScheduleInput) -> ApiResult<Option<i64>> {
    maintenance::validate(&input.task)?;
    if let MaintenanceTask::RemoveOrphanFiles {
        dry_run: false,
        older_than_days,
        ..
    } = &input.task
        && *older_than_days < 1
    {
        return Err(ApiError::BadRequest(
            "scheduled orphan removal needs at least 1 day".into(),
        ));
    }
    let next = next_run_ms(input.cron.trim())?;
    Ok(input.enabled.then_some(next))
}

/// The next time `cron` fires after now, in local time.
pub fn next_run_ms(cron: &str) -> ApiResult<i64> {
    let parsed = parse_cron(cron)?;
    let next = parsed
        .find_next_occurrence(&Local::now(), false)
        .map_err(|error| ApiError::BadRequest(format!("invalid schedule {cron:?}: {error}")))?;
    Ok(next.timestamp_millis())
}

fn parse_cron(cron: &str) -> ApiResult<Cron> {
    if cron.split_whitespace().count() != 5 {
        return Err(ApiError::BadRequest(format!(
            "use a five-field cron expression (minute hour day month weekday), not {cron:?}"
        )));
    }
    Cron::from_str(cron)
        .map_err(|error| ApiError::BadRequest(format!("invalid schedule {cron:?}: {error}")))
}

/// croner's description of `cron` without its closing period, e.g.
/// "At 02:00".
pub fn describe_cron(cron: &str) -> String {
    parse_cron(cron)
        .map(|parsed| parsed.describe().trim_end_matches('.').to_owned())
        .unwrap_or_default()
}

fn json<T: serde::Serialize>(value: &T) -> ApiResult<String> {
    serde_json::to_string(value).map_err(|error| ApiError::Internal(error.to_string()))
}

fn parse_json<T: serde::de::DeserializeOwned>(value: &str) -> ApiResult<T> {
    serde_json::from_str(value)
        .map_err(|error| ApiError::Internal(format!("corrupt record: {error}")))
}

fn decode_job(row: &sqlx::sqlite::SqliteRow) -> ApiResult<JobInfo> {
    let status: String = row.try_get("status")?;
    let outcome: Option<String> = row.try_get("outcome")?;
    Ok(JobInfo {
        id: row.try_get("id")?,
        target: TableRef {
            catalog_id: row.try_get("catalog_id")?,
            namespace: parse_json(&row.try_get::<String, _>("namespace")?)?,
            table: row.try_get("table_name")?,
        },
        catalog_name: row.try_get("catalog_name")?,
        task: parse_json(&row.try_get::<String, _>("task")?)?,
        status: JobStatus::parse(&status)
            .ok_or_else(|| ApiError::Internal(format!("unknown job status {status:?}")))?,
        schedule_id: row.try_get("schedule_id")?,
        created_at: row.try_get("created_at")?,
        started_at: row.try_get("started_at")?,
        finished_at: row.try_get("finished_at")?,
        outcome: outcome.as_deref().map(parse_json).transpose()?,
        error: row.try_get("error")?,
    })
}

fn decode_schedule(row: &sqlx::sqlite::SqliteRow) -> ApiResult<ScheduleInfo> {
    let cron: String = row.try_get("cron")?;
    let enabled: i64 = row.try_get("enabled")?;
    Ok(ScheduleInfo {
        id: row.try_get("id")?,
        target: TableRef {
            catalog_id: row.try_get("catalog_id")?,
            namespace: parse_json(&row.try_get::<String, _>("namespace")?)?,
            table: row.try_get("table_name")?,
        },
        catalog_name: row.try_get("catalog_name")?,
        task: parse_json(&row.try_get::<String, _>("task")?)?,
        cron_description: describe_cron(&cron),
        cron,
        enabled: enabled != 0,
        next_run_ms: row.try_get("next_run_ms")?,
        last_job_id: row.try_get("last_job_id")?,
        created_at: row.try_get("created_at")?,
    })
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    #[test]
    fn parses_five_field_cron_only() {
        assert!(next_run_ms("0 2 * * *").is_ok());
        assert!(next_run_ms("*/15 * * * *").unwrap() > Utc::now().timestamp_millis());
        assert!(next_run_ms("0 0 2 * * *").is_err());
        assert!(next_run_ms("every day").is_err());
        let description = describe_cron("0 2 * * *");
        assert!(
            !description.is_empty() && !description.ends_with('.'),
            "{description}"
        );
    }

    #[test]
    fn local_time_is_used() {
        // 23:59 local today or tomorrow, never more than a day away.
        let next = next_run_ms("59 23 * * *").unwrap();
        let next = Local.timestamp_millis_opt(next).unwrap();
        assert_eq!(next.format("%H:%M").to_string(), "23:59");
        assert!(next - Local::now() <= chrono::Duration::days(1));
    }
}
