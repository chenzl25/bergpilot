//! Table maintenance: compaction, snapshot expiry, orphan-file removal and
//! manifest rewrites, plus side-effect-free previews of them.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use iceberg::spec::ManifestContentType;
use iceberg::table::Table;
use iceberg::transaction::{ApplyTransactionAction, Transaction};
use iceberg::{
    Catalog, Error, ErrorKind, Namespace, NamespaceIdent, TableCommit, TableCreation, TableIdent,
    TableUpdate,
};

use crate::error::{ApiError, ApiResult};
use crate::io_counter::IoCounter;
use crate::types::{JobOutcome, JobProgress, MaintenancePreview, MaintenanceTask};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Orphan paths kept in a job outcome; the count is always exact.
const MAX_REPORTED_FILES: usize = 500;

/// Resource limits for maintenance on this machine.
#[derive(Clone, Debug)]
pub struct MaintenanceLimits {
    /// DataFusion memory budget for one compaction before it spills.
    pub compaction_memory_bytes: usize,
    /// Jobs that may run at the same time (at most one per table).
    pub max_running_jobs: usize,
}

impl Default for MaintenanceLimits {
    fn default() -> Self {
        Self {
            compaction_memory_bytes: 2 * 1024 * 1024 * 1024,
            max_running_jobs: 2,
        }
    }
}

/// Where a running job reports how far it has got, and the I/O counter of
/// the catalog client it runs with, if that client counts.
#[derive(Clone, Default)]
pub struct Progress {
    report: Option<Arc<dyn Fn(JobProgress) + Send + Sync>>,
    io: Option<Arc<IoCounter>>,
}

impl Progress {
    pub fn new(
        report: impl Fn(JobProgress) + Send + Sync + 'static,
        io: Option<Arc<IoCounter>>,
    ) -> Self {
        Self {
            report: Some(Arc::new(report)),
            io,
        }
    }

    /// Nobody is listening.
    pub fn none() -> Self {
        Self::default()
    }

    pub fn report(&self, progress: JobProgress) {
        if let Some(report) = &self.report {
            report(progress);
        }
    }

    pub fn io(&self) -> Option<&IoCounter> {
        self.io.as_deref()
    }
}

/// Reject settings that are invalid or unsafe before anything runs.
pub fn validate(task: &MaintenanceTask) -> ApiResult<()> {
    match task {
        MaintenanceTask::Compact {
            target_file_size_mb,
            small_file_threshold_mb,
            ..
        } => {
            if target_file_size_mb.is_some_and(|mb| mb == 0) {
                return Err(ApiError::BadRequest(
                    "target file size must be positive".into(),
                ));
            }
            if small_file_threshold_mb.is_some_and(|mb| mb == 0) {
                return Err(ApiError::BadRequest(
                    "small-file threshold must be positive".into(),
                ));
            }
        }
        MaintenanceTask::ExpireSnapshots { retain_last, .. } => {
            if *retain_last == 0 {
                return Err(ApiError::BadRequest(
                    "keep at least one snapshot per branch".into(),
                ));
            }
        }
        MaintenanceTask::RemoveOrphanFiles {
            older_than_days,
            dry_run,
        } => {
            if *older_than_days == 0 && !dry_run {
                return Err(ApiError::BadRequest(
                    "orphan files must be at least 1 day old before they are deleted, so files \
                     of commits still in progress are never removed"
                        .into(),
                ));
            }
        }
        MaintenanceTask::RewriteManifests => {}
    }
    Ok(())
}

pub async fn preview(
    catalog: Arc<dyn Catalog>,
    ident: &TableIdent,
    task: &MaintenanceTask,
    limits: &MaintenanceLimits,
) -> ApiResult<MaintenancePreview> {
    validate(task)?;
    match task {
        MaintenanceTask::Compact { .. } => {
            crate::compaction::preview(catalog, ident, task, limits).await
        }
        MaintenanceTask::ExpireSnapshots {
            older_than_days,
            retain_last,
            ..
        } => {
            let table = catalog.load_table(ident).await?;
            let before = table.metadata().snapshots().len() as u32;
            let tx = Transaction::new(&table);
            let tx = tx
                .expire_snapshots()
                .expire_older_than_ms(cutoff_ms(*older_than_days))
                .retain_last(*retain_last as usize)
                .apply(tx)?;
            let updates = DryRunCatalog::capture(catalog, tx).await?;
            let expired: Vec<String> = updates
                .iter()
                .filter_map(|update| match update {
                    TableUpdate::RemoveSnapshots { snapshot_ids } => Some(snapshot_ids),
                    _ => None,
                })
                .flatten()
                .map(|id| id.to_string())
                .collect();
            Ok(MaintenancePreview::ExpireSnapshots {
                remaining_snapshots: before.saturating_sub(expired.len() as u32),
                expired_snapshot_ids: expired,
            })
        }
        MaintenanceTask::RewriteManifests => {
            let table = catalog.load_table(ident).await?;
            let (data_manifests, delete_manifests) = manifest_counts(&table).await?;
            Ok(MaintenancePreview::RewriteManifests {
                data_manifests,
                delete_manifests,
            })
        }
        MaintenanceTask::RemoveOrphanFiles { .. } => Err(ApiError::BadRequest(
            "run orphan-file removal as a dry run to preview it".into(),
        )),
    }
}

pub async fn run(
    catalog: Arc<dyn Catalog>,
    catalog_name: &str,
    ident: &TableIdent,
    task: &MaintenanceTask,
    limits: &MaintenanceLimits,
    progress: &Progress,
) -> ApiResult<JobOutcome> {
    validate(task)?;
    match task {
        MaintenanceTask::Compact { .. } => {
            crate::compaction::run(catalog, catalog_name, ident, task, limits, progress).await
        }
        MaintenanceTask::ExpireSnapshots {
            older_than_days,
            retain_last,
            clean_files,
        } => {
            let table = catalog.load_table(ident).await?;
            let before = table.metadata_ref();
            let before_ids: HashSet<i64> = before.snapshots().map(|s| s.snapshot_id()).collect();
            let tx = Transaction::new(&table);
            let tx = tx
                .expire_snapshots()
                .expire_older_than_ms(cutoff_ms(*older_than_days))
                .retain_last(*retain_last as usize)
                .apply(tx)?;
            let updated = tx.commit(catalog.as_ref()).await?;
            let after_ids: HashSet<i64> = updated
                .metadata()
                .snapshots()
                .map(|s| s.snapshot_id())
                .collect();
            let mut expired: Vec<i64> = before_ids.difference(&after_ids).copied().collect();
            expired.sort_unstable();
            let cleaned = *clean_files && !expired.is_empty();
            if cleaned {
                updated.cleanup_expired_files(&before).await?;
            }
            Ok(JobOutcome::ExpireSnapshots {
                expired_snapshot_ids: expired.iter().map(i64::to_string).collect(),
                remaining_snapshots: after_ids.len() as u32,
                cleaned_files: cleaned,
            })
        }
        MaintenanceTask::RemoveOrphanFiles {
            older_than_days,
            dry_run,
        } => {
            let table = catalog.load_table(ident).await?;
            let scan = crate::orphans::scan(&table, cutoff_ms(*older_than_days)).await?;
            if !dry_run {
                let failed = crate::orphans::delete(&table, &scan.orphans).await;
                if failed > 0 {
                    return Err(ApiError::Upstream(format!(
                        "deleted {} of {} orphan files; {failed} deletions failed",
                        scan.orphans.len() - failed,
                        scan.orphans.len()
                    )));
                }
            }
            Ok(JobOutcome::RemoveOrphanFiles {
                dry_run: *dry_run,
                count: scan.orphans.len() as u64,
                files: scan.orphans.into_iter().take(MAX_REPORTED_FILES).collect(),
            })
        }
        MaintenanceTask::RewriteManifests => {
            let table = catalog.load_table(ident).await?;
            let (before, _) = manifest_counts(&table).await?;
            if before <= 1 {
                return Ok(JobOutcome::RewriteManifests {
                    manifests_before: before,
                    manifests_after: before,
                });
            }
            let tx = Transaction::new(&table);
            // Without a cluster function the action keeps every manifest. One
            // shared key merges data manifests per partition spec, split at
            // `commit.manifest.target-size-bytes`, like Java's default.
            let tx = tx
                .rewrite_manifests()
                .cluster_by(Box::new(|_: &iceberg::spec::DataFile| String::new()))
                .apply(tx)?;
            let updated = tx.commit(catalog.as_ref()).await?;
            let (after, _) = manifest_counts(&updated).await?;
            Ok(JobOutcome::RewriteManifests {
                manifests_before: before,
                manifests_after: after,
            })
        }
    }
}

fn cutoff_ms(older_than_days: u32) -> i64 {
    chrono::Utc::now().timestamp_millis() - i64::from(older_than_days) * DAY_MS
}

/// Data and delete manifests of the current snapshot.
async fn manifest_counts(table: &Table) -> ApiResult<(u32, u32)> {
    let Some(snapshot) = table.metadata().current_snapshot() else {
        return Ok((0, 0));
    };
    let list = table.manifest_list_reader(snapshot).load().await?;
    let data = list
        .entries()
        .iter()
        .filter(|manifest| manifest.content == ManifestContentType::Data)
        .count() as u32;
    Ok((data, list.entries().len() as u32 - data))
}

/// A catalog that answers reads from the real catalog but records the first
/// commit and declines it. Running a transaction against it shows exactly
/// which updates the transaction would make.
struct DryRunCatalog {
    inner: Arc<dyn Catalog>,
    captured: Mutex<Option<Vec<TableUpdate>>>,
}

const DRY_RUN_MESSAGE: &str = "bergpilot dry run: commit declined";

impl DryRunCatalog {
    async fn capture(inner: Arc<dyn Catalog>, tx: Transaction) -> ApiResult<Vec<TableUpdate>> {
        let catalog = DryRunCatalog {
            inner,
            captured: Mutex::new(None),
        };
        match tx.commit(&catalog).await {
            Ok(_) => Err(ApiError::Internal(
                "dry-run commit unexpectedly succeeded".into(),
            )),
            Err(error) => {
                let captured = catalog
                    .captured
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .take();
                match captured {
                    Some(updates) => Ok(updates),
                    // The transaction failed before reaching the commit.
                    None => Err(error.into()),
                }
            }
        }
    }
}

impl fmt::Debug for DryRunCatalog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DryRunCatalog").finish_non_exhaustive()
    }
}

#[async_trait]
impl Catalog for DryRunCatalog {
    async fn list_namespaces(
        &self,
        parent: Option<&NamespaceIdent>,
    ) -> iceberg::Result<Vec<NamespaceIdent>> {
        self.inner.list_namespaces(parent).await
    }

    async fn create_namespace(
        &self,
        _: &NamespaceIdent,
        _: HashMap<String, String>,
    ) -> iceberg::Result<Namespace> {
        Err(declined())
    }

    async fn get_namespace(&self, namespace: &NamespaceIdent) -> iceberg::Result<Namespace> {
        self.inner.get_namespace(namespace).await
    }

    async fn namespace_exists(&self, namespace: &NamespaceIdent) -> iceberg::Result<bool> {
        self.inner.namespace_exists(namespace).await
    }

    async fn update_namespace(
        &self,
        _: &NamespaceIdent,
        _: HashMap<String, String>,
    ) -> iceberg::Result<()> {
        Err(declined())
    }

    async fn drop_namespace(&self, _: &NamespaceIdent) -> iceberg::Result<()> {
        Err(declined())
    }

    async fn list_tables(&self, namespace: &NamespaceIdent) -> iceberg::Result<Vec<TableIdent>> {
        self.inner.list_tables(namespace).await
    }

    async fn create_table(
        &self,
        _: &NamespaceIdent,
        _: TableCreation,
    ) -> iceberg::Result<iceberg::table::Table> {
        Err(declined())
    }

    async fn load_table(&self, table: &TableIdent) -> iceberg::Result<iceberg::table::Table> {
        self.inner.load_table(table).await
    }

    async fn drop_table(&self, _: &TableIdent) -> iceberg::Result<()> {
        Err(declined())
    }

    async fn purge_table(&self, _: &TableIdent) -> iceberg::Result<()> {
        Err(declined())
    }

    async fn table_exists(&self, table: &TableIdent) -> iceberg::Result<bool> {
        self.inner.table_exists(table).await
    }

    async fn rename_table(&self, _: &TableIdent, _: &TableIdent) -> iceberg::Result<()> {
        Err(declined())
    }

    async fn register_table(
        &self,
        _: &TableIdent,
        _: String,
    ) -> iceberg::Result<iceberg::table::Table> {
        Err(declined())
    }

    async fn update_table(
        &self,
        mut commit: TableCommit,
    ) -> iceberg::Result<iceberg::table::Table> {
        *self
            .captured
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(commit.take_updates());
        Err(declined())
    }
}

/// Not retryable, so the transaction stops after the first attempt.
fn declined() -> Error {
    Error::new(ErrorKind::FeatureUnsupported, DRY_RUN_MESSAGE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_settings() {
        assert!(
            validate(&MaintenanceTask::RemoveOrphanFiles {
                older_than_days: 0,
                dry_run: false
            })
            .is_err()
        );
        assert!(
            validate(&MaintenanceTask::RemoveOrphanFiles {
                older_than_days: 0,
                dry_run: true
            })
            .is_ok()
        );
        assert!(
            validate(&MaintenanceTask::ExpireSnapshots {
                older_than_days: 3,
                retain_last: 0,
                clean_files: true
            })
            .is_err()
        );
    }
}
