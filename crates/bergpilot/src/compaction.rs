//! Compaction. iceberg-compaction plans the file groups and rewrites them;
//! BergPilot commits the result itself.
//!
//! iceberg-compaction's own commit goes wrong when another writer commits
//! while a compaction runs, which is the normal case for a table fed by
//! RisingWave or Flink:
//!
//! - It does not look for position deletes added to the data files it
//!   rewrites, so the rewritten files bring those rows back
//!   (nimtable/iceberg-compaction#198, risingwavelabs/iceberg-rust#258).
//! - It copies the custom summary properties of the snapshot it started
//!   from, so the new snapshot can claim an older RisingWave epoch or Flink
//!   checkpoint than its parent (nimtable/iceberg-compaction#197).
//!
//! Here the commit is one transaction. Its retries rebase onto the latest
//! snapshot and reuse the manifests already written, and the catalog it
//! commits through checks every snapshot it hands out: if a position delete
//! added since the compaction started may hit a rewritten file, the commit
//! stops and nothing changes. The new snapshot carries no custom properties,
//! like Java's `RewriteDataFiles`; RisingWave and Flink look past `replace`
//! snapshots for their own. As in Java, the new data files get the starting
//! snapshot's sequence number, so equality deletes committed meanwhile still
//! apply to them.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::FuturesUnordered;
use futures::{StreamExt, TryStreamExt};
use iceberg::spec::{
    DataContentType, DataFile, MAIN_BRANCH, ManifestContentType, ManifestFile, ManifestStatus,
    PrimitiveLiteral, SnapshotRef,
};
use iceberg::table::Table;
use iceberg::transaction::{ApplyTransactionAction, Transaction};
use iceberg::{
    Catalog, Error, ErrorKind, Namespace, NamespaceIdent, TableCommit, TableCreation, TableIdent,
};
use iceberg_compaction_core::compaction::{
    Compaction, CompactionBuilder, CompactionPlan, RewriteResult,
};
use iceberg_compaction_core::config::{
    AutoCompactionConfig, BinPackConfig, CompactionConfig, CompactionExecutionConfig,
    CompactionPlanningConfig, FilesWithDeletesConfig, FullCompactionConfig, GroupingStrategy,
    SmallFilesConfig,
};

use crate::error::{ApiError, ApiResult};
use crate::maintenance::{MaintenanceLimits, Progress};
use crate::types::{
    CompactionGroup, CompactionStrategy, JobOutcome, JobPhase, JobProgress, MaintenancePreview,
    MaintenanceTask,
};

const MIB: u64 = 1024 * 1024;
/// Transactions tried before giving up on a table that keeps changing. Each
/// transaction retries several times on its own.
const MAX_COMMIT_ATTEMPTS: u32 = 5;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);
/// Position delete files keep the data file path in this reserved field.
const DELETE_FILE_PATH_FIELD_ID: i32 = 2147483546;
/// Manifests read concurrently.
const MANIFEST_CONCURRENCY: usize = 8;

pub async fn preview(
    catalog: Arc<dyn Catalog>,
    ident: &TableIdent,
    task: &MaintenanceTask,
    limits: &MaintenanceLimits,
) -> ApiResult<MaintenancePreview> {
    let compaction = CompactionBuilder::new(catalog, ident.clone())
        .with_config(Arc::new(config(task, limits)))
        .build();
    let plans = compaction
        .plan_compaction()
        .await
        .map_err(compaction_error)?;
    let groups: Vec<CompactionGroup> = plans
        .iter()
        .filter(|plan| plan.has_files())
        .map(|plan| CompactionGroup {
            data_files: plan.file_group.data_files.len() as u64,
            delete_files: (plan.file_group.position_delete_files.len()
                + plan.file_group.equality_delete_files.len()) as u64,
            bytes: plan.total_bytes(),
        })
        .collect();
    Ok(MaintenancePreview::Compact {
        data_files: groups.iter().map(|g| g.data_files).sum(),
        delete_files: groups.iter().map(|g| g.delete_files).sum(),
        bytes: groups.iter().map(|g| g.bytes).sum(),
        groups,
    })
}

pub async fn run(
    catalog: Arc<dyn Catalog>,
    catalog_name: &str,
    ident: &TableIdent,
    task: &MaintenanceTask,
    limits: &MaintenanceLimits,
    progress: &Progress,
) -> ApiResult<JobOutcome> {
    let config = Arc::new(config(task, limits));
    let compaction = CompactionBuilder::new(catalog.clone(), ident.clone())
        .with_config(config.clone())
        .with_catalog_name(catalog_name.to_owned())
        .build();

    progress.report(JobProgress::starting(JobPhase::Planning));
    let plans: Vec<CompactionPlan> = compaction
        .plan_compaction()
        .await
        .map_err(compaction_error)?
        .into_iter()
        .filter(CompactionPlan::has_files)
        .collect();
    let Some(first) = plans.first() else {
        return Ok(JobOutcome::Compact {
            rewrote: false,
            input_data_files: 0,
            input_delete_files: 0,
            input_bytes: 0,
            output_files: 0,
            output_bytes: 0,
            snapshot_id: None,
        });
    };
    let table = catalog.load_table(ident).await?;
    let start = table
        .metadata()
        .snapshot_by_id(first.snapshot_id)
        .cloned()
        .ok_or_else(|| {
            ApiError::Conflict(format!(
                "snapshot {} that compaction planned from is gone; run it again",
                first.snapshot_id
            ))
        })?;
    let schema_id = table.metadata().current_schema_id();
    let tracker = Tracker::new(&plans);
    let rewritten_paths: HashSet<String> = plans
        .iter()
        .flat_map(|plan| plan.file_group.data_files.iter())
        .map(|task| task.data_file_path.clone())
        .collect();

    // Rewrite the groups while looking up what the commit needs from the
    // starting snapshot.
    let rewrite = async {
        let limit = config.execution.max_concurrent_compaction_plans.max(1);
        let mut waiting = plans.into_iter().enumerate();
        let mut running = FuturesUnordered::new();
        let mut results: Vec<RewriteResult> = Vec::new();
        let mut ticker = tokio::time::interval(PROGRESS_INTERVAL);
        loop {
            while running.len() < limit {
                let Some((index, plan)) = waiting.next() else {
                    break;
                };
                running.push(rewrite_group(
                    &compaction,
                    &config.execution,
                    &table,
                    index,
                    plan,
                ));
            }
            if running.is_empty() {
                break;
            }
            tokio::select! {
                Some((index, result)) = running.next() => {
                    results.push(result.map_err(compaction_error)?);
                    tracker.finish(index);
                    progress.report(tracker.progress(progress));
                }
                _ = ticker.tick() => progress.report(tracker.progress(progress)),
            }
        }
        Ok::<_, ApiError>(results)
    };
    let prepare = async {
        tokio::try_join!(
            data_files_at(&table, &start, &rewritten_paths),
            delete_cleanup_sequence(&table, start.snapshot_id()),
        )
    };
    let (results, (rewritten, cleanup_sequence)) = tokio::try_join!(rewrite, prepare)?;

    let mut done = tracker.progress(progress);
    done.phase = JobPhase::Committing;
    progress.report(done);
    let added: Vec<DataFile> = results
        .iter()
        .flat_map(|result| result.output_data_files.iter().cloned())
        .collect();
    let committed = commit(
        catalog,
        ident,
        &start,
        schema_id,
        Rewrite {
            added,
            rewritten,
            cleanup_sequence,
        },
    )
    .await?;

    let stats = results.iter().map(|result| &result.stats);
    Ok(JobOutcome::Compact {
        rewrote: true,
        input_data_files: stats.clone().map(|s| s.input_data_file_count as u64).sum(),
        input_delete_files: stats
            .clone()
            .map(|s| {
                (s.input_position_delete_file_count + s.input_equality_delete_file_count) as u64
            })
            .sum(),
        input_bytes: stats.clone().map(|s| s.input_total_bytes).sum(),
        output_files: stats.clone().map(|s| s.output_files_count as u64).sum(),
        output_bytes: stats.map(|s| s.output_total_bytes).sum(),
        snapshot_id: committed
            .metadata()
            .current_snapshot_id()
            .map(|id| id.to_string()),
    })
}

async fn rewrite_group(
    compaction: &Compaction,
    execution: &CompactionExecutionConfig,
    table: &Table,
    index: usize,
    plan: CompactionPlan,
) -> (usize, iceberg_compaction_core::Result<RewriteResult>) {
    (index, compaction.rewrite_plan(plan, execution, table).await)
}

fn config(task: &MaintenanceTask, limits: &MaintenanceLimits) -> CompactionConfig {
    let MaintenanceTask::Compact {
        strategy,
        target_file_size_mb,
        small_file_threshold_mb,
        min_delete_files,
    } = task
    else {
        unreachable!("compaction::config is only called for compaction")
    };
    let target = u64::from(target_file_size_mb.unwrap_or(512)) * MIB;
    let small = u64::from(small_file_threshold_mb.unwrap_or(32)) * MIB;
    let bin_pack = GroupingStrategy::BinPack(BinPackConfig::default());
    let planning = match strategy {
        CompactionStrategy::Auto => CompactionPlanningConfig::Auto(AutoCompactionConfig {
            target_file_size_bytes: target,
            small_file_threshold_bytes: small,
            min_delete_file_count_threshold: min_delete_files.unwrap_or(128) as usize,
            grouping_strategy: bin_pack,
            ..Default::default()
        }),
        CompactionStrategy::SmallFiles => CompactionPlanningConfig::SmallFiles(SmallFilesConfig {
            target_file_size_bytes: target,
            small_file_threshold_bytes: small,
            grouping_strategy: bin_pack,
            ..Default::default()
        }),
        CompactionStrategy::FilesWithDeletes => {
            CompactionPlanningConfig::FilesWithDeletes(FilesWithDeletesConfig {
                target_file_size_bytes: target,
                min_delete_file_count_threshold: min_delete_files.unwrap_or(1).max(1) as usize,
                grouping_strategy: bin_pack,
                ..Default::default()
            })
        }
        CompactionStrategy::Full => CompactionPlanningConfig::Full(FullCompactionConfig {
            target_file_size_bytes: target,
            grouping_strategy: bin_pack,
            ..Default::default()
        }),
    };
    let execution = CompactionExecutionConfig {
        target_file_size_bytes: target,
        max_memory_bytes: Some(limits.compaction_memory_bytes),
        spill_dir: Some(std::env::temp_dir().join("bergpilot-spill")),
        ..Default::default()
    };
    CompactionConfig::new(planning, execution)
}

fn compaction_error(error: iceberg_compaction_core::CompactionError) -> ApiError {
    ApiError::Upstream(format!("compaction failed: {error}"))
}

// -- Progress ---------------------------------------------------------------

/// The input files of each group and how far reading them has got.
struct Tracker {
    /// Data file paths and sizes, per group.
    groups: Vec<Vec<(String, u64)>>,
    /// Every distinct input file, data and delete, with its size.
    sizes: HashMap<String, u64>,
    finished: std::sync::Mutex<Vec<bool>>,
}

impl Tracker {
    fn new(plans: &[CompactionPlan]) -> Self {
        let mut sizes = HashMap::new();
        let groups = plans
            .iter()
            .map(|plan| {
                let group = &plan.file_group;
                for task in group
                    .position_delete_files
                    .iter()
                    .chain(&group.equality_delete_files)
                {
                    sizes.insert(task.data_file_path.clone(), task.file_size_in_bytes);
                }
                group
                    .data_files
                    .iter()
                    .map(|task| {
                        sizes.insert(task.data_file_path.clone(), task.file_size_in_bytes);
                        (task.data_file_path.clone(), task.file_size_in_bytes)
                    })
                    .collect()
            })
            .collect::<Vec<Vec<_>>>();
        let finished = std::sync::Mutex::new(vec![false; groups.len()]);
        Self {
            groups,
            sizes,
            finished,
        }
    }

    fn finish(&self, index: usize) {
        self.finished.lock().unwrap_or_else(|p| p.into_inner())[index] = true;
    }

    /// Files count as done when their group is, or when nearly all their
    /// bytes have been read (Parquet readers skip the 4-byte header). Bytes
    /// count what has been read of each input file, capped at its size.
    fn progress(&self, progress: &Progress) -> JobProgress {
        let finished = self
            .finished
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let read = |path: &str| progress.io().map_or(0, |io| io.bytes_read(path));
        let mut done_paths: HashSet<&str> = HashSet::new();
        let mut files_done = 0;
        for (group, files) in self.groups.iter().enumerate() {
            for (path, size) in files {
                if finished[group] || read(path).saturating_mul(100) >= size.saturating_mul(95) {
                    files_done += 1;
                }
                if finished[group] {
                    done_paths.insert(path);
                }
            }
        }
        let all_finished = finished.iter().all(|f| *f);
        let bytes_done = self
            .sizes
            .iter()
            .map(|(path, size)| {
                if all_finished || done_paths.contains(path.as_str()) {
                    *size
                } else {
                    read(path).min(*size)
                }
            })
            .sum();
        JobProgress {
            phase: JobPhase::Rewriting,
            files_done,
            files_total: self.groups.iter().map(|g| g.len() as u64).sum(),
            bytes_done,
            bytes_total: self.sizes.values().sum(),
            bytes_written: progress.io().map_or(0, |io| io.bytes_written()),
        }
    }
}

// -- Commit -----------------------------------------------------------------

struct Rewrite {
    added: Vec<DataFile>,
    rewritten: Vec<DataFile>,
    cleanup_sequence: Option<i64>,
}

async fn commit(
    catalog: Arc<dyn Catalog>,
    ident: &TableIdent,
    start: &SnapshotRef,
    schema_id: i32,
    rewrite: Rewrite,
) -> ApiResult<Table> {
    let guarded = GuardedCatalog {
        inner: catalog,
        ident: ident.clone(),
        schema_id,
        start_id: start.snapshot_id(),
        rewritten: rewrite
            .rewritten
            .iter()
            .map(|file| file.file_path().to_owned())
            .collect(),
        checked: tokio::sync::Mutex::new(start.snapshot_id()),
        conflict: std::sync::Mutex::new(None),
    };
    for attempt in 1..=MAX_COMMIT_ATTEMPTS {
        let result = async {
            let table = guarded.load_table(ident).await?;
            let tx = Transaction::new(&table);
            let mut action = tx
                .rewrite_files()
                .set_enable_delete_filter_manager(true)
                .add_data_files(rewrite.added.clone())
                .delete_files(rewrite.rewritten.clone())
                .set_target_branch(MAIN_BRANCH.to_owned())
                .set_new_data_file_sequence_number(start.sequence_number())
                .set_check_file_existence(true);
            if let Some(sequence) = rewrite.cleanup_sequence {
                action = action.set_delete_file_cleanup_min_data_sequence_number(sequence);
            }
            action.apply(tx)?.commit(&guarded).await
        }
        .await;
        match result {
            Ok(table) => return Ok(table),
            Err(error) => {
                if let Some(conflict) = guarded.conflict() {
                    return Err(ApiError::Conflict(conflict));
                }
                match error.kind() {
                    ErrorKind::CatalogCommitConflicts => {
                        tracing::info!(table = %ident, attempt, %error, "table kept changing during commit; retrying");
                        tokio::time::sleep(Duration::from_millis(200 * u64::from(attempt))).await;
                    }
                    ErrorKind::DataInvalid => {
                        return Err(ApiError::Conflict(format!(
                            "the table changed in a way this compaction cannot commit over \
                             ({error}); nothing was changed. Run the compaction again."
                        )));
                    }
                    _ => return Err(error.into()),
                }
            }
        }
    }
    Err(ApiError::Conflict(format!(
        "the table kept changing; gave up committing after {MAX_COMMIT_ATTEMPTS} attempts"
    )))
}

/// Forwards to the real catalog and checks every version of the table it
/// loads before handing it out. A transaction loads the table before each
/// attempt and builds the commit on what it gets, with the snapshot it got as
/// a requirement, so the check covers exactly the base each commit lands on.
struct GuardedCatalog {
    inner: Arc<dyn Catalog>,
    ident: TableIdent,
    schema_id: i32,
    start_id: i64,
    rewritten: BTreeSet<String>,
    /// The latest snapshot checked; its ancestors back to the start were
    /// checked too.
    checked: tokio::sync::Mutex<i64>,
    conflict: std::sync::Mutex<Option<String>>,
}

impl GuardedCatalog {
    fn conflict(&self) -> Option<String> {
        self.conflict
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// Why committing on top of `table` would be wrong, if it would.
    async fn check(&self, table: &Table) -> iceberg::Result<Option<String>> {
        let metadata = table.metadata();
        if metadata.current_schema_id() != self.schema_id {
            return Ok(Some(
                "the table's schema changed while compacting; nothing was changed. Run the \
                 compaction again."
                    .into(),
            ));
        }
        let Some(base) = metadata.snapshot_for_ref(MAIN_BRANCH).cloned() else {
            return Ok(Some("the table's main branch is gone".into()));
        };
        let mut checked = self.checked.lock().await;
        let mut snapshot = base.clone();
        while snapshot.snapshot_id() != *checked && snapshot.snapshot_id() != self.start_id {
            if let Some(delete_file) =
                added_position_delete_for(table, &snapshot, &self.rewritten).await?
            {
                return Ok(Some(format!(
                    "another writer committed a position delete for a data file this \
                     compaction rewrote ({delete_file}); committing would bring deleted rows \
                     back, so nothing was changed. Run the compaction again."
                )));
            }
            let Some(parent) = snapshot
                .parent_snapshot_id()
                .and_then(|id| metadata.snapshot_by_id(id))
            else {
                return Ok(Some(
                    "the snapshot this compaction started from is no longer in the main \
                     branch's history; nothing was changed"
                        .into(),
                ));
            };
            snapshot = parent.clone();
        }
        *checked = base.snapshot_id();
        Ok(None)
    }
}

/// A position delete file added by `snapshot` that may delete rows of a
/// rewritten data file. A file that names its data file is matched exactly;
/// otherwise the bounds of its file-path column decide, and a file without
/// bounds is assumed to match.
async fn added_position_delete_for(
    table: &Table,
    snapshot: &SnapshotRef,
    rewritten: &BTreeSet<String>,
) -> iceberg::Result<Option<String>> {
    let list = table.manifest_list_reader(snapshot).load().await?;
    let added: Vec<ManifestFile> = list
        .entries()
        .iter()
        .filter(|manifest| {
            manifest.content == ManifestContentType::Deletes
                && manifest.added_snapshot_id == snapshot.snapshot_id()
        })
        .cloned()
        .collect();
    for manifest in added {
        let manifest = manifest.load_manifest(table.file_io()).await?;
        for entry in manifest.entries() {
            if entry.status() == ManifestStatus::Added
                && entry.content_type() == DataContentType::PositionDeletes
                && may_delete_from(entry.data_file(), rewritten)
            {
                return Ok(Some(entry.data_file().file_path().to_owned()));
            }
        }
    }
    Ok(None)
}

fn may_delete_from(delete_file: &DataFile, data_paths: &BTreeSet<String>) -> bool {
    if let Some(referenced) = delete_file.referenced_data_file() {
        return data_paths.contains(&referenced);
    }
    let bound = |bounds: &HashMap<i32, iceberg::spec::Datum>| match bounds
        .get(&DELETE_FILE_PATH_FIELD_ID)
        .map(|datum| datum.literal())
    {
        Some(PrimitiveLiteral::String(path)) => Some(path.clone()),
        _ => None,
    };
    match (
        bound(delete_file.lower_bounds()),
        bound(delete_file.upper_bounds()),
    ) {
        (Some(lower), Some(upper)) if lower <= upper => {
            data_paths.range(lower..=upper).next().is_some()
        }
        _ => true,
    }
}

/// The live data files of `snapshot` among `paths`.
async fn data_files_at(
    table: &Table,
    snapshot: &SnapshotRef,
    paths: &HashSet<String>,
) -> ApiResult<Vec<DataFile>> {
    let list = table.manifest_list_reader(snapshot).load().await?;
    let file_io = table.file_io().clone();
    // Collected first: a filtering iterator held across the awaits below
    // would make the future not `Send`.
    let data_manifests: Vec<ManifestFile> = list
        .entries()
        .iter()
        .filter(|manifest| manifest.content == ManifestContentType::Data)
        .cloned()
        .collect();
    let mut manifests = futures::stream::iter(data_manifests)
        .map(|manifest| {
            let file_io = file_io.clone();
            async move { manifest.load_manifest(&file_io).await }
        })
        .buffer_unordered(MANIFEST_CONCURRENCY);
    let mut found = Vec::with_capacity(paths.len());
    while let Some(manifest) = manifests.try_next().await? {
        found.extend(
            manifest
                .entries()
                .iter()
                .filter(|entry| entry.is_alive() && paths.contains(entry.data_file().file_path()))
                .map(|entry| entry.data_file().clone()),
        );
    }
    if found.len() != paths.len() {
        return Err(ApiError::Internal(format!(
            "found {} of the {} data files to rewrite in snapshot {}",
            found.len(),
            paths.len(),
            snapshot.snapshot_id()
        )));
    }
    Ok(found)
}

/// The smallest data sequence number among files that have deletes in
/// `snapshot_id`. Delete files older than every such file apply to nothing
/// once the rewrite lands, so the commit can drop them. This is how
/// iceberg-compaction's planner computes the same bound.
async fn delete_cleanup_sequence(table: &Table, snapshot_id: i64) -> ApiResult<Option<i64>> {
    let mut tasks = table
        .scan()
        .snapshot_id(snapshot_id)
        .build()?
        .plan_files()
        .await?;
    let mut min: Option<i64> = None;
    while let Some(task) = tasks.try_next().await? {
        if task.deletes.is_empty() {
            continue;
        }
        let Some(sequence) = task.data_sequence_number.filter(|s| *s >= 0) else {
            return Ok(None);
        };
        min = Some(min.map_or(sequence, |min| min.min(sequence)));
    }
    Ok(min)
}

impl fmt::Debug for GuardedCatalog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GuardedCatalog")
            .field("ident", &self.ident)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl Catalog for GuardedCatalog {
    async fn list_namespaces(
        &self,
        parent: Option<&NamespaceIdent>,
    ) -> iceberg::Result<Vec<NamespaceIdent>> {
        self.inner.list_namespaces(parent).await
    }

    async fn create_namespace(
        &self,
        namespace: &NamespaceIdent,
        properties: HashMap<String, String>,
    ) -> iceberg::Result<Namespace> {
        self.inner.create_namespace(namespace, properties).await
    }

    async fn get_namespace(&self, namespace: &NamespaceIdent) -> iceberg::Result<Namespace> {
        self.inner.get_namespace(namespace).await
    }

    async fn namespace_exists(&self, namespace: &NamespaceIdent) -> iceberg::Result<bool> {
        self.inner.namespace_exists(namespace).await
    }

    async fn update_namespace(
        &self,
        namespace: &NamespaceIdent,
        properties: HashMap<String, String>,
    ) -> iceberg::Result<()> {
        self.inner.update_namespace(namespace, properties).await
    }

    async fn drop_namespace(&self, namespace: &NamespaceIdent) -> iceberg::Result<()> {
        self.inner.drop_namespace(namespace).await
    }

    async fn list_tables(&self, namespace: &NamespaceIdent) -> iceberg::Result<Vec<TableIdent>> {
        self.inner.list_tables(namespace).await
    }

    async fn create_table(
        &self,
        namespace: &NamespaceIdent,
        creation: TableCreation,
    ) -> iceberg::Result<Table> {
        self.inner.create_table(namespace, creation).await
    }

    async fn load_table(&self, ident: &TableIdent) -> iceberg::Result<Table> {
        let table = self.inner.load_table(ident).await?;
        if *ident != self.ident {
            return Ok(table);
        }
        match self.check(&table).await? {
            None => Ok(table),
            Some(conflict) => {
                let error = Error::new(ErrorKind::PreconditionFailed, conflict.clone())
                    .with_retryable(false);
                *self
                    .conflict
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) = Some(conflict);
                Err(error)
            }
        }
    }

    async fn drop_table(&self, ident: &TableIdent) -> iceberg::Result<()> {
        self.inner.drop_table(ident).await
    }

    async fn purge_table(&self, ident: &TableIdent) -> iceberg::Result<()> {
        self.inner.purge_table(ident).await
    }

    async fn table_exists(&self, ident: &TableIdent) -> iceberg::Result<bool> {
        self.inner.table_exists(ident).await
    }

    async fn rename_table(&self, src: &TableIdent, dest: &TableIdent) -> iceberg::Result<()> {
        self.inner.rename_table(src, dest).await
    }

    async fn register_table(
        &self,
        ident: &TableIdent,
        metadata_location: String,
    ) -> iceberg::Result<Table> {
        self.inner.register_table(ident, metadata_location).await
    }

    async fn update_table(&self, commit: TableCommit) -> iceberg::Result<Table> {
        self.inner.update_table(commit).await
    }
}

#[cfg(test)]
mod tests {
    use iceberg::spec::{DataFileBuilder, DataFileFormat, Datum, Struct};

    use super::*;

    fn position_delete(referenced: Option<&str>, bounds: Option<(&str, &str)>) -> DataFile {
        let mut builder = DataFileBuilder::default();
        builder
            .content(DataContentType::PositionDeletes)
            .file_path("s3://b/t/data/del.parquet".to_owned())
            .file_format(DataFileFormat::Parquet)
            .file_size_in_bytes(10)
            .record_count(1)
            .partition(Struct::empty())
            .partition_spec_id(0)
            .referenced_data_file(referenced.map(str::to_owned));
        if let Some((lower, upper)) = bounds {
            builder
                .lower_bounds(HashMap::from([(
                    DELETE_FILE_PATH_FIELD_ID,
                    Datum::string(lower),
                )]))
                .upper_bounds(HashMap::from([(
                    DELETE_FILE_PATH_FIELD_ID,
                    Datum::string(upper),
                )]));
        }
        builder.build().unwrap()
    }

    #[test]
    fn maps_compaction_settings() {
        let task = MaintenanceTask::Compact {
            strategy: CompactionStrategy::SmallFiles,
            target_file_size_mb: Some(128),
            small_file_threshold_mb: Some(16),
            min_delete_files: None,
        };
        let config = config(&task, &MaintenanceLimits::default());
        assert_eq!(config.planning.target_file_size_bytes(), 128 * MIB);
        assert_eq!(config.execution.target_file_size_bytes, 128 * MIB);
        assert!(matches!(
            config.planning,
            CompactionPlanningConfig::SmallFiles(SmallFilesConfig {
                small_file_threshold_bytes,
                ..
            }) if small_file_threshold_bytes == 16 * MIB
        ));
    }

    #[test]
    fn matches_position_deletes_to_rewritten_files() {
        let rewritten: BTreeSet<String> = ["s3://b/t/data/a.parquet", "s3://b/t/data/m.parquet"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let matches = |file: DataFile| may_delete_from(&file, &rewritten);
        assert!(matches(position_delete(
            Some("s3://b/t/data/m.parquet"),
            None
        )));
        assert!(!matches(position_delete(
            Some("s3://b/t/data/z.parquet"),
            None
        )));
        assert!(matches(position_delete(
            None,
            Some(("s3://b/t/data/k.parquet", "s3://b/t/data/n.parquet"))
        )));
        assert!(!matches(position_delete(
            None,
            Some(("s3://b/t/data/n.parquet", "s3://b/t/data/z.parquet"))
        )));
        assert!(
            matches(position_delete(None, None)),
            "no bounds: assume it matches"
        );
    }
}
