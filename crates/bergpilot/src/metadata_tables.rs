//! Iceberg metadata tables for SQL: `table$snapshots`, `$history`, `$refs`,
//! `$manifests`, `$files` and `$partitions`.
//!
//! The fork's DataFusion integration has only snapshots, manifests and
//! history, and they cannot be built outside the crate, so BergPilot builds
//! these as in-memory tables from the table's metadata. `$manifests`,
//! `$files` and `$partitions` describe the current snapshot.

use std::collections::BTreeMap;
use std::sync::Arc;

use datafusion::arrow::array::{
    ArrayRef, BooleanArray, Int32Array, Int64Array, RecordBatch, StringArray,
    TimestampMillisecondArray,
};
use datafusion::arrow::datatypes::{DataType, Field, Schema, SchemaRef, TimeUnit};
use datafusion::catalog::MemTable;
use futures::{StreamExt, TryStreamExt};
use iceberg::spec::{DataContentType, DataFile, ManifestContentType, ManifestFile, TableMetadata};
use iceberg::table::Table;

use crate::error::{ApiError, ApiResult};

pub const KINDS: [&str; 6] = [
    "snapshots",
    "history",
    "refs",
    "manifests",
    "files",
    "partitions",
];
const LOAD_CONCURRENCY: usize = 8;

/// A metadata table as a DataFusion table.
pub async fn build(table: &Table, kind: &str) -> ApiResult<MemTable> {
    let batch = match kind {
        "snapshots" => snapshots(table.metadata())?,
        "history" => history(table.metadata())?,
        "refs" => refs(table.metadata())?,
        "manifests" => manifests(table).await?,
        "files" => files(table).await?,
        "partitions" => {
            let stats = partition_stats(table).await?;
            partitions_batch(&stats)?
        }
        other => {
            return Err(ApiError::BadRequest(format!(
                "unknown metadata table ${other}; available: {}",
                KINDS.map(|kind| format!("${kind}")).join(", ")
            )));
        }
    };
    MemTable::try_new(batch.schema(), vec![vec![batch]])
        .map_err(|error| ApiError::Internal(error.to_string()))
}

fn utc_ms() -> DataType {
    DataType::Timestamp(TimeUnit::Millisecond, Some("UTC".into()))
}

fn batch(fields: Vec<Field>, columns: Vec<ArrayRef>) -> ApiResult<RecordBatch> {
    let schema: SchemaRef = Arc::new(Schema::new(fields));
    RecordBatch::try_new(schema, columns).map_err(|error| ApiError::Internal(error.to_string()))
}

fn snapshots(metadata: &TableMetadata) -> ApiResult<RecordBatch> {
    let mut rows: Vec<_> = metadata.snapshots().collect();
    rows.sort_by_key(|snapshot| (snapshot.timestamp_ms(), snapshot.sequence_number()));
    batch(
        vec![
            Field::new("committed_at", utc_ms(), false),
            Field::new("snapshot_id", DataType::Int64, false),
            Field::new("parent_id", DataType::Int64, true),
            Field::new("sequence_number", DataType::Int64, false),
            Field::new("operation", DataType::Utf8, false),
            Field::new("manifest_list", DataType::Utf8, false),
            Field::new("summary", DataType::Utf8, false),
        ],
        vec![
            Arc::new(
                TimestampMillisecondArray::from_iter_values(rows.iter().map(|s| s.timestamp_ms()))
                    .with_timezone("UTC"),
            ),
            Arc::new(Int64Array::from_iter_values(
                rows.iter().map(|s| s.snapshot_id()),
            )),
            Arc::new(Int64Array::from_iter(
                rows.iter().map(|s| s.parent_snapshot_id()),
            )),
            Arc::new(Int64Array::from_iter_values(
                rows.iter().map(|s| s.sequence_number()),
            )),
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|s| s.summary().operation.as_str()),
            )),
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|s| s.manifest_list()),
            )),
            Arc::new(StringArray::from_iter_values(rows.iter().map(|s| {
                let sorted: BTreeMap<_, _> = s.summary().additional_properties.iter().collect();
                serde_json::to_string(&sorted).unwrap_or_default()
            }))),
        ],
    )
}

fn history(metadata: &TableMetadata) -> ApiResult<RecordBatch> {
    let mut ancestors = std::collections::HashSet::new();
    let mut cursor = metadata.current_snapshot_id();
    while let Some(id) = cursor {
        if !ancestors.insert(id) {
            break;
        }
        cursor = metadata
            .snapshot_by_id(id)
            .and_then(|snapshot| snapshot.parent_snapshot_id());
    }
    let log = metadata.history();
    batch(
        vec![
            Field::new("made_current_at", utc_ms(), false),
            Field::new("snapshot_id", DataType::Int64, false),
            Field::new("parent_id", DataType::Int64, true),
            Field::new("is_current_ancestor", DataType::Boolean, false),
        ],
        vec![
            Arc::new(
                TimestampMillisecondArray::from_iter_values(log.iter().map(|e| e.timestamp_ms))
                    .with_timezone("UTC"),
            ),
            Arc::new(Int64Array::from_iter_values(
                log.iter().map(|e| e.snapshot_id),
            )),
            Arc::new(Int64Array::from_iter(log.iter().map(|e| {
                metadata
                    .snapshot_by_id(e.snapshot_id)
                    .and_then(|snapshot| snapshot.parent_snapshot_id())
            }))),
            Arc::new(BooleanArray::from_iter(
                log.iter().map(|e| Some(ancestors.contains(&e.snapshot_id))),
            )),
        ],
    )
}

fn refs(metadata: &TableMetadata) -> ApiResult<RecordBatch> {
    // `TableMetadata` keeps refs private; read them from the spec JSON.
    let value = serde_json::to_value(metadata).map_err(|e| ApiError::Internal(e.to_string()))?;
    let mut rows: Vec<(String, serde_json::Value)> = value
        .get("refs")
        .and_then(|refs| refs.as_object())
        .map(|refs| refs.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    let int = |row: &serde_json::Value, key: &str| row.get(key).and_then(|v| v.as_i64());
    batch(
        vec![
            Field::new("name", DataType::Utf8, false),
            Field::new("type", DataType::Utf8, false),
            Field::new("snapshot_id", DataType::Int64, false),
            Field::new("max_reference_age_ms", DataType::Int64, true),
            Field::new("min_snapshots_to_keep", DataType::Int64, true),
            Field::new("max_snapshot_age_ms", DataType::Int64, true),
        ],
        vec![
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|(name, _)| name),
            )),
            Arc::new(StringArray::from_iter_values(rows.iter().map(
                |(_, row)| {
                    row.get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("branch")
                        .to_owned()
                },
            ))),
            Arc::new(Int64Array::from_iter_values(
                rows.iter()
                    .map(|(_, row)| int(row, "snapshot-id").unwrap_or_default()),
            )),
            Arc::new(Int64Array::from_iter(
                rows.iter().map(|(_, row)| int(row, "max-ref-age-ms")),
            )),
            Arc::new(Int64Array::from_iter(
                rows.iter()
                    .map(|(_, row)| int(row, "min-snapshots-to-keep")),
            )),
            Arc::new(Int64Array::from_iter(
                rows.iter().map(|(_, row)| int(row, "max-snapshot-age-ms")),
            )),
        ],
    )
}

async fn current_manifests(table: &Table) -> ApiResult<Vec<ManifestFile>> {
    let Some(snapshot) = table.metadata().current_snapshot() else {
        return Ok(Vec::new());
    };
    Ok(table
        .manifest_list_reader(snapshot)
        .load()
        .await?
        .entries()
        .to_vec())
}

async fn manifests(table: &Table) -> ApiResult<RecordBatch> {
    let rows = current_manifests(table).await?;
    let count = |value: Option<u32>| value.map(i64::from);
    let rows_count = |value: Option<u64>| value.map(|v| v as i64);
    batch(
        vec![
            Field::new("content", DataType::Utf8, false),
            Field::new("path", DataType::Utf8, false),
            Field::new("length", DataType::Int64, false),
            Field::new("partition_spec_id", DataType::Int32, false),
            Field::new("added_snapshot_id", DataType::Int64, false),
            Field::new("sequence_number", DataType::Int64, false),
            Field::new("added_files_count", DataType::Int64, true),
            Field::new("existing_files_count", DataType::Int64, true),
            Field::new("deleted_files_count", DataType::Int64, true),
            Field::new("added_rows_count", DataType::Int64, true),
            Field::new("existing_rows_count", DataType::Int64, true),
            Field::new("deleted_rows_count", DataType::Int64, true),
        ],
        vec![
            Arc::new(StringArray::from_iter_values(rows.iter().map(
                |m| match m.content {
                    ManifestContentType::Data => "data",
                    ManifestContentType::Deletes => "deletes",
                },
            ))),
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|m| m.manifest_path.as_str()),
            )),
            Arc::new(Int64Array::from_iter_values(
                rows.iter().map(|m| m.manifest_length),
            )),
            Arc::new(Int32Array::from_iter_values(
                rows.iter().map(|m| m.partition_spec_id),
            )),
            Arc::new(Int64Array::from_iter_values(
                rows.iter().map(|m| m.added_snapshot_id),
            )),
            Arc::new(Int64Array::from_iter_values(
                rows.iter().map(|m| m.sequence_number),
            )),
            Arc::new(Int64Array::from_iter(
                rows.iter().map(|m| count(m.added_files_count)),
            )),
            Arc::new(Int64Array::from_iter(
                rows.iter().map(|m| count(m.existing_files_count)),
            )),
            Arc::new(Int64Array::from_iter(
                rows.iter().map(|m| count(m.deleted_files_count)),
            )),
            Arc::new(Int64Array::from_iter(
                rows.iter().map(|m| rows_count(m.added_rows_count)),
            )),
            Arc::new(Int64Array::from_iter(
                rows.iter().map(|m| rows_count(m.existing_rows_count)),
            )),
            Arc::new(Int64Array::from_iter(
                rows.iter().map(|m| rows_count(m.deleted_rows_count)),
            )),
        ],
    )
}

/// A live data or delete file of the current snapshot.
pub struct LiveFile {
    pub file: DataFile,
    pub spec_id: i32,
    /// `name=value/...` in Iceberg's partition-path format.
    pub partition: String,
}

/// Live files of the current snapshot, with readable partition values.
pub async fn live_files(table: &Table) -> ApiResult<Vec<LiveFile>> {
    let manifests = current_manifests(table).await?;
    let file_io = table.file_io().clone();
    let loaded: Vec<(i32, Vec<DataFile>)> = futures::stream::iter(manifests)
        .map(|manifest| {
            let file_io = file_io.clone();
            async move {
                let spec_id = manifest.partition_spec_id;
                let loaded = manifest.load_manifest(&file_io).await?;
                let files = loaded
                    .entries()
                    .iter()
                    .filter(|entry| entry.is_alive())
                    .map(|entry| entry.data_file().clone())
                    .collect();
                Ok::<_, iceberg::Error>((spec_id, files))
            }
        })
        .buffer_unordered(LOAD_CONCURRENCY)
        .try_collect()
        .await?;
    let metadata = table.metadata();
    let schema = metadata.current_schema();
    let mut out = Vec::new();
    for (spec_id, files) in loaded {
        let spec = metadata.partition_spec_by_id(spec_id);
        let partition_type = spec.and_then(|spec| spec.partition_type(schema).ok());
        for file in files {
            let partition = match (spec, &partition_type) {
                (Some(spec), Some(partition_type)) if !spec.fields().is_empty() => spec
                    .fields()
                    .iter()
                    .zip(partition_type.fields())
                    .zip(file.partition().iter())
                    .map(|((field, typed), value)| {
                        format!(
                            "{}={}",
                            field.name,
                            field.transform.to_human_string(&typed.field_type, value)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("/"),
                (Some(_), _) => String::new(),
                (None, _) => format!("spec {spec_id}"),
            };
            out.push(LiveFile {
                file,
                spec_id,
                partition,
            });
        }
    }
    out.sort_by(|a, b| {
        (a.partition.as_str(), a.file.file_path()).cmp(&(b.partition.as_str(), b.file.file_path()))
    });
    Ok(out)
}

fn content_name(content: DataContentType) -> &'static str {
    match content {
        DataContentType::Data => "data",
        DataContentType::PositionDeletes => "position_deletes",
        DataContentType::EqualityDeletes => "equality_deletes",
    }
}

async fn files(table: &Table) -> ApiResult<RecordBatch> {
    let rows = live_files(table).await?;
    batch(
        vec![
            Field::new("content", DataType::Utf8, false),
            Field::new("file_path", DataType::Utf8, false),
            Field::new("file_format", DataType::Utf8, false),
            Field::new("partition", DataType::Utf8, false),
            Field::new("spec_id", DataType::Int32, false),
            Field::new("record_count", DataType::Int64, false),
            Field::new("file_size_in_bytes", DataType::Int64, false),
        ],
        vec![
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|r| content_name(r.file.content_type())),
            )),
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|r| r.file.file_path()),
            )),
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|r| r.file.file_format().to_string()),
            )),
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|r| r.partition.as_str()),
            )),
            Arc::new(Int32Array::from_iter_values(rows.iter().map(|r| r.spec_id))),
            Arc::new(Int64Array::from_iter_values(
                rows.iter().map(|r| r.file.record_count() as i64),
            )),
            Arc::new(Int64Array::from_iter_values(
                rows.iter().map(|r| r.file.file_size_in_bytes() as i64),
            )),
        ],
    )
}

/// Totals of the current snapshot's live files in one partition.
#[derive(Clone, Debug, Default, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct PartitionStat {
    pub partition: String,
    #[ts(type = "number")]
    pub record_count: u64,
    #[ts(type = "number")]
    pub data_files: u64,
    #[ts(type = "number")]
    pub data_bytes: u64,
    #[ts(type = "number")]
    pub delete_files: u64,
    #[ts(type = "number")]
    pub delete_bytes: u64,
}

pub async fn partition_stats(table: &Table) -> ApiResult<Vec<PartitionStat>> {
    let mut by_partition: BTreeMap<String, PartitionStat> = BTreeMap::new();
    for live in live_files(table).await? {
        let stat = by_partition
            .entry(live.partition.clone())
            .or_insert_with(|| PartitionStat {
                partition: live.partition.clone(),
                ..Default::default()
            });
        let bytes = live.file.file_size_in_bytes();
        match live.file.content_type() {
            DataContentType::Data => {
                stat.data_files += 1;
                stat.data_bytes += bytes;
                stat.record_count += live.file.record_count();
            }
            _ => {
                stat.delete_files += 1;
                stat.delete_bytes += bytes;
            }
        }
    }
    Ok(by_partition.into_values().collect())
}

fn partitions_batch(stats: &[PartitionStat]) -> ApiResult<RecordBatch> {
    batch(
        vec![
            Field::new("partition", DataType::Utf8, false),
            Field::new("record_count", DataType::Int64, false),
            Field::new("data_files", DataType::Int64, false),
            Field::new("data_bytes", DataType::Int64, false),
            Field::new("delete_files", DataType::Int64, false),
            Field::new("delete_bytes", DataType::Int64, false),
        ],
        vec![
            Arc::new(StringArray::from_iter_values(
                stats.iter().map(|s| s.partition.as_str()),
            )),
            Arc::new(Int64Array::from_iter_values(
                stats.iter().map(|s| s.record_count as i64),
            )),
            Arc::new(Int64Array::from_iter_values(
                stats.iter().map(|s| s.data_files as i64),
            )),
            Arc::new(Int64Array::from_iter_values(
                stats.iter().map(|s| s.data_bytes as i64),
            )),
            Arc::new(Int64Array::from_iter_values(
                stats.iter().map(|s| s.delete_files as i64),
            )),
            Arc::new(Int64Array::from_iter_values(
                stats.iter().map(|s| s.delete_bytes as i64),
            )),
        ],
    )
}
