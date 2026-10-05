//! Request and response types of the HTTP API.
//!
//! Every type derives [`TS`], and `cargo test` writes the matching TypeScript
//! definitions to `web/src/api/generated/` (see `.cargo/config.toml`). Commit
//! the regenerated files together with any change here.
//!
//! Snapshot ids are 64-bit and exceed JavaScript's safe integer range, so they
//! travel as strings.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Catalog implementations BergPilot can connect to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum CatalogKind {
    /// Iceberg REST catalog.
    Rest,
    /// AWS Glue Data Catalog.
    Glue,
    /// Amazon S3 Tables.
    S3tables,
    /// A database catalog in the Java `JdbcCatalog` layout (PostgreSQL,
    /// MySQL or SQLite).
    Sql,
}

impl CatalogKind {
    pub const ALL: [CatalogKind; 4] = [
        CatalogKind::Rest,
        CatalogKind::Glue,
        CatalogKind::S3tables,
        CatalogKind::Sql,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            CatalogKind::Rest => "rest",
            CatalogKind::Glue => "glue",
            CatalogKind::S3tables => "s3tables",
            CatalogKind::Sql => "sql",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }
}

/// A configured catalog. Secret values are never returned; only their keys.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct CatalogSummary {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    pub kind: CatalogKind,
    pub properties: BTreeMap<String, String>,
    pub secret_keys: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Create or update a catalog.
///
/// On update, `secrets` replaces the listed keys, `clear_secrets` removes
/// keys, and stored secrets that are not mentioned are kept.
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct CatalogInput {
    pub name: String,
    pub kind: CatalogKind,
    #[serde(default)]
    pub properties: BTreeMap<String, String>,
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
    #[serde(default)]
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clear_secrets: Option<Vec<String>>,
}

/// Test a connection, optionally reusing the stored secrets of catalog `id`.
#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct CatalogTestRequest {
    #[serde(default)]
    #[ts(optional, type = "number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub catalog: CatalogInput,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct CatalogTestResult {
    pub ok: bool,
    /// Number of top-level namespaces, when the connection worked.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespaces: Option<u32>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct NamespaceList {
    /// Child namespaces, each as its full list of levels.
    pub namespaces: Vec<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct TableList {
    pub tables: Vec<String>,
}

/// One column of the current schema. Nested fields follow their parent with
/// a larger `depth`.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct SchemaField {
    pub id: i32,
    pub name: String,
    /// Dotted path from the top-level column, e.g. `address.city`.
    pub path: String,
    pub depth: u32,
    #[serde(rename = "type")]
    pub data_type: String,
    pub required: bool,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct PartitionFieldInfo {
    pub name: String,
    pub source: String,
    pub transform: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct SortFieldInfo {
    pub source: String,
    pub transform: String,
    pub direction: String,
    pub null_order: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct SnapshotInfo {
    pub snapshot_id: String,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[ts(type = "number")]
    pub sequence_number: i64,
    #[ts(type = "number")]
    pub timestamp_ms: i64,
    pub operation: String,
    pub summary: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Debug, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum RefKind {
    Branch,
    Tag,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct RefInfo {
    pub name: String,
    pub kind: RefKind,
    pub snapshot_id: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct TableDetail {
    pub catalog: String,
    pub namespace: Vec<String>,
    pub name: String,
    pub location: String,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_location: Option<String>,
    pub format_version: u8,
    pub uuid: String,
    #[ts(type = "number")]
    pub last_updated_ms: i64,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_snapshot_id: Option<String>,
    pub schema_id: i32,
    pub schema: Vec<SchemaField>,
    pub partition_fields: Vec<PartitionFieldInfo>,
    pub sort_fields: Vec<SortFieldInfo>,
    pub properties: BTreeMap<String, String>,
    /// Oldest first.
    pub snapshots: Vec<SnapshotInfo>,
    pub refs: Vec<RefInfo>,
}

/// Count, bytes and records of one kind of file.
#[derive(Clone, Debug, Default, Serialize, TS)]
#[ts(export)]
pub struct FileTotals {
    #[ts(type = "number")]
    pub files: u64,
    #[ts(type = "number")]
    pub bytes: u64,
    #[ts(type = "number")]
    pub records: u64,
}

/// Files whose size falls in `[min_bytes, max_bytes)`.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct SizeBucket {
    pub label: String,
    #[ts(type = "number")]
    pub min_bytes: u64,
    #[ts(optional, type = "number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    #[ts(type = "number")]
    pub data_files: u64,
    #[ts(type = "number")]
    pub delete_files: u64,
}

/// Live files of one snapshot, grouped by size and content.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct FileStats {
    /// `None` when the table has no snapshot yet.
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    pub manifests: u32,
    pub data: FileTotals,
    pub position_deletes: FileTotals,
    pub equality_deletes: FileTotals,
    pub buckets: Vec<SizeBucket>,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct QueryRequest {
    pub sql: String,
    /// Maximum rows to return; defaults to 1,000 and is capped at 10,000.
    #[serde(default)]
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct QueryColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub data_type: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct QueryResult {
    pub columns: Vec<QueryColumn>,
    /// Values formatted as text; `null` for SQL NULL.
    pub rows: Vec<Vec<Option<String>>>,
    /// True when more rows were available than `limit`.
    pub truncated: bool,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct ServerInfo {
    pub version: String,
    /// Whether API requests must carry the access token.
    pub auth_required: bool,
    /// Catalog types compiled into this build.
    pub catalog_kinds: Vec<CatalogKind>,
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/// Which data files a compaction rewrites.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CompactionStrategy {
    /// Small files and files with many deletes.
    Auto,
    /// Files below the small-file threshold.
    SmallFiles,
    /// Files with at least `min_delete_files` delete files attached.
    FilesWithDeletes,
    /// Every data file.
    Full,
}

/// A maintenance operation and its settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum MaintenanceTask {
    /// Rewrite data files into fewer, larger ones and apply deletes.
    Compact {
        strategy: CompactionStrategy,
        /// Output file size; defaults to 512 MiB.
        #[serde(default)]
        #[ts(optional)]
        target_file_size_mb: Option<u32>,
        /// "Small" for `auto` and `small_files`; defaults to 32 MiB.
        #[serde(default)]
        #[ts(optional)]
        small_file_threshold_mb: Option<u32>,
        /// Delete files per data file that trigger a rewrite; defaults to 128
        /// (`auto`) or 1 (`files_with_deletes`).
        #[serde(default)]
        #[ts(optional)]
        min_delete_files: Option<u32>,
    },
    /// Remove old snapshots from the metadata.
    ExpireSnapshots {
        /// Expire snapshots older than this many days (0 = all but the
        /// retained ones).
        older_than_days: u32,
        /// Snapshots to keep on each branch regardless of age (at least 1).
        retain_last: u32,
        /// Also delete data, manifest and manifest-list files that only the
        /// expired snapshots referenced.
        clean_files: bool,
    },
    /// Delete files under the table location that no snapshot references.
    RemoveOrphanFiles {
        /// Only files last modified more than this many days ago; at least 1
        /// unless `dry_run`, so in-flight writes are never touched.
        older_than_days: u32,
        /// Only report what would be deleted.
        dry_run: bool,
    },
    /// Merge the current snapshot's data manifests.
    RewriteManifests,
}

impl MaintenanceTask {
    pub fn kind(&self) -> &'static str {
        match self {
            MaintenanceTask::Compact { .. } => "compact",
            MaintenanceTask::ExpireSnapshots { .. } => "expire_snapshots",
            MaintenanceTask::RemoveOrphanFiles { .. } => "remove_orphan_files",
            MaintenanceTask::RewriteManifests => "rewrite_manifests",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            JobStatus::Queued => "queued",
            JobStatus::Running => "running",
            JobStatus::Succeeded => "succeeded",
            JobStatus::Failed => "failed",
            JobStatus::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        [
            JobStatus::Queued,
            JobStatus::Running,
            JobStatus::Succeeded,
            JobStatus::Failed,
            JobStatus::Cancelled,
        ]
        .into_iter()
        .find(|status| status.as_str() == value)
    }
}

/// What a finished job did.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum JobOutcome {
    Compact {
        /// False when no files matched the strategy.
        rewrote: bool,
        #[ts(type = "number")]
        input_data_files: u64,
        #[ts(type = "number")]
        input_delete_files: u64,
        #[ts(type = "number")]
        input_bytes: u64,
        #[ts(type = "number")]
        output_files: u64,
        #[ts(type = "number")]
        output_bytes: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        snapshot_id: Option<String>,
    },
    ExpireSnapshots {
        expired_snapshot_ids: Vec<String>,
        remaining_snapshots: u32,
        cleaned_files: bool,
    },
    RemoveOrphanFiles {
        dry_run: bool,
        #[ts(type = "number")]
        count: u64,
        /// The first 500 paths.
        files: Vec<String>,
    },
    RewriteManifests {
        manifests_before: u32,
        manifests_after: u32,
    },
}

/// The table a job or schedule works on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TableRef {
    #[ts(type = "number")]
    pub catalog_id: i64,
    pub namespace: Vec<String>,
    pub table: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct JobInfo {
    #[ts(type = "number")]
    pub id: i64,
    #[serde(flatten)]
    pub target: TableRef,
    pub catalog_name: String,
    pub task: MaintenanceTask,
    pub status: JobStatus,
    /// Set when a schedule queued the job.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub schedule_id: Option<i64>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub outcome: Option<JobOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct JobRequest {
    #[serde(flatten)]
    pub target: TableRef,
    pub task: MaintenanceTask,
}

/// One group of files a compaction would rewrite together.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct CompactionGroup {
    #[ts(type = "number")]
    pub data_files: u64,
    #[ts(type = "number")]
    pub delete_files: u64,
    #[ts(type = "number")]
    pub bytes: u64,
}

/// What `MaintenanceTask` would do, computed without changing the table.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum MaintenancePreview {
    Compact {
        groups: Vec<CompactionGroup>,
        #[ts(type = "number")]
        data_files: u64,
        #[ts(type = "number")]
        delete_files: u64,
        #[ts(type = "number")]
        bytes: u64,
    },
    ExpireSnapshots {
        expired_snapshot_ids: Vec<String>,
        remaining_snapshots: u32,
    },
    RewriteManifests {
        data_manifests: u32,
        delete_manifests: u32,
    },
}

#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct PreviewRequest {
    #[serde(flatten)]
    pub target: TableRef,
    pub task: MaintenanceTask,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct ScheduleInfo {
    #[ts(type = "number")]
    pub id: i64,
    #[serde(flatten)]
    pub target: TableRef,
    pub catalog_name: String,
    pub task: MaintenanceTask,
    /// Five-field cron expression in the server's local time.
    pub cron: String,
    /// Plain-language reading of `cron`.
    pub cron_description: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub next_run_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub last_job_id: Option<i64>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[ts(export)]
pub struct ScheduleInput {
    #[serde(flatten)]
    pub target: TableRef,
    pub task: MaintenanceTask,
    pub cron: String,
    pub enabled: bool,
}

/// Key numbers of a table from its current snapshot summary (no manifest
/// reads), for overviews.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct TableSummary {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub format_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub records: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub data_files: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub data_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub delete_files: Option<u64>,
    pub snapshots: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub last_updated_ms: Option<i64>,
    /// Set when the table could not be loaded.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct NamespaceDetail {
    pub namespace: Vec<String>,
    pub properties: BTreeMap<String, String>,
    pub child_namespaces: Vec<Vec<String>>,
    pub tables: Vec<TableSummary>,
    /// True when only the first tables were summarized.
    pub truncated: bool,
}

/// Namespaces and table names of a catalog, for SQL completion.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct CatalogNames {
    pub namespaces: Vec<NamespaceNames>,
    /// True when the walk stopped early (very large catalogs).
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct NamespaceNames {
    pub namespace: Vec<String>,
    pub tables: Vec<String>,
}
