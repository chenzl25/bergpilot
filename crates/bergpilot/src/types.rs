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
