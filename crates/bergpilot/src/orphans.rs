//! Finding and deleting files under a table location that no snapshot
//! references.
//!
//! iceberg-rust has `RemoveOrphanFilesAction`, but it compares the storage
//! listing with metadata paths as plain strings. Local listings come back as
//! `file:/path` while metadata says `file:///path`, so it reports every live
//! file as an orphan; mixed `s3://` and `s3a://` paths would do the same.
//! This module compares normalized paths instead, and refuses to delete
//! anything when it cannot match the table's own current files.

use std::collections::{HashMap, HashSet};

use futures::{StreamExt, TryStreamExt};
use iceberg::spec::ManifestFile;
use iceberg::table::Table;

use crate::error::{ApiError, ApiResult};

const LOAD_CONCURRENCY: usize = 8;
const DELETE_CONCURRENCY: usize = 16;

/// Orphan files of a table, as paths the storage layer accepts.
#[derive(Debug)]
pub struct OrphanScan {
    pub orphans: Vec<String>,
    /// Files listed under the table location.
    pub listed: usize,
}

/// List the table location and return files that no snapshot, metadata file
/// or statistics file references and that were last modified before
/// `older_than_ms`. Files without a modification time are kept.
pub async fn scan(table: &Table, older_than_ms: i64) -> ApiResult<OrphanScan> {
    let reachable = reachable_files(table).await?;
    let location = table.metadata().location();
    let listed: Vec<iceberg::io::ListEntry> = table
        .file_io()
        .list(location, true)
        .await?
        .try_collect()
        .await?;
    let files: Vec<&iceberg::io::ListEntry> = listed.iter().filter(|entry| !entry.is_dir).collect();
    let listed_paths: HashSet<String> = files.iter().map(|entry| normalize(&entry.path)).collect();

    // The guard against path-format mismatches: the table's own current
    // metadata file and manifest list must be found in the listing. If they
    // are not, the comparison below cannot be trusted.
    let mut anchors = Vec::new();
    if let Some(metadata_location) = table.metadata_location() {
        anchors.push(metadata_location.to_owned());
    }
    if let Some(snapshot) = table.metadata().current_snapshot() {
        anchors.push(snapshot.manifest_list().to_owned());
    }
    for anchor in &anchors {
        let normalized = normalize(anchor);
        if normalized.starts_with(&normalize(location)) && !listed_paths.contains(&normalized) {
            return Err(ApiError::Upstream(format!(
                "refusing to look for orphan files: the storage listing of {location} does not \
                 contain the table's current file {anchor}, so paths cannot be compared reliably"
            )));
        }
    }

    let mut orphans: Vec<String> = files
        .iter()
        .filter(|entry| !reachable.contains(&normalize(&entry.path)))
        .filter(|entry| entry.last_modified_ms.is_some_and(|ms| ms < older_than_ms))
        .map(|entry| entry.path.clone())
        .collect();
    orphans.sort_unstable();
    Ok(OrphanScan {
        orphans,
        listed: files.len(),
    })
}

/// Delete `paths`; returns how many deletions failed.
pub async fn delete(table: &Table, paths: &[String]) -> usize {
    let file_io = table.file_io().clone();
    futures::stream::iter(paths.iter().cloned())
        .map(|path| {
            let file_io = file_io.clone();
            async move {
                let result = file_io.delete(&path).await;
                if let Err(error) = &result {
                    tracing::warn!(%path, %error, "failed to delete orphan file");
                }
                result.is_err()
            }
        })
        .buffer_unordered(DELETE_CONCURRENCY)
        .filter(|failed| futures::future::ready(*failed))
        .count()
        .await
}

/// Normalized paths of every file the table's metadata references: metadata
/// files (current and logged), statistics, and for every snapshot its
/// manifest list, manifests and data/delete files.
async fn reachable_files(table: &Table) -> ApiResult<HashSet<String>> {
    let metadata = table.metadata();
    let mut reachable = HashSet::new();
    if let Some(location) = table.metadata_location() {
        reachable.insert(normalize(location));
    }
    for entry in metadata.metadata_log() {
        reachable.insert(normalize(&entry.metadata_file));
    }
    for file in metadata.statistics_iter() {
        reachable.insert(normalize(&file.statistics_path));
    }
    for file in metadata.partition_statistics_iter() {
        reachable.insert(normalize(&file.statistics_path));
    }

    let snapshots: Vec<_> = metadata.snapshots().cloned().collect();
    let lists: Vec<_> = futures::stream::iter(snapshots)
        .map(|snapshot| async move { reachable_list(table, &snapshot).await })
        .buffer_unordered(LOAD_CONCURRENCY)
        .try_collect()
        .await?;
    let mut manifests: HashMap<String, ManifestFile> = HashMap::new();
    for (list_path, entries) in lists {
        if let Some(path) = list_path {
            reachable.insert(normalize(&path));
        }
        for manifest in entries {
            reachable.insert(normalize(&manifest.manifest_path));
            manifests
                .entry(manifest.manifest_path.clone())
                .or_insert(manifest);
        }
    }

    let file_io = table.file_io().clone();
    let content: Vec<Vec<String>> = futures::stream::iter(manifests.into_values())
        .map(|manifest| {
            let file_io = file_io.clone();
            async move {
                let loaded = manifest.load_manifest(&file_io).await?;
                // Every entry, deleted ones included: being conservative here
                // can only keep a file, never delete a live one.
                Ok::<_, iceberg::Error>(
                    loaded
                        .entries()
                        .iter()
                        .map(|entry| normalize(entry.file_path()))
                        .collect(),
                )
            }
        })
        .buffer_unordered(LOAD_CONCURRENCY)
        .try_collect()
        .await?;
    reachable.extend(content.into_iter().flatten());
    Ok(reachable)
}

async fn reachable_list(
    table: &Table,
    snapshot: &iceberg::spec::SnapshotRef,
) -> ApiResult<(Option<String>, Vec<ManifestFile>)> {
    let list_path =
        (!snapshot.manifest_list().is_empty()).then(|| snapshot.manifest_list().to_owned());
    let list = table.manifest_list_reader(snapshot).load().await?;
    Ok((list_path, list.entries().to_vec()))
}

/// A comparable form of a storage path: equivalent schemes merged
/// (`s3a`/`s3n` → `s3`, `gcs` → `gs`), a missing scheme treated as `file`,
/// and repeated or leading slashes collapsed, so `file:/a/b`, `file:///a/b`
/// and `/a/b` are equal.
pub fn normalize(path: &str) -> String {
    let (scheme, rest) = match path.split_once(':') {
        Some((scheme, rest))
            if scheme.len() > 1
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') =>
        {
            (scheme.to_ascii_lowercase(), rest)
        }
        _ => ("file".to_owned(), path),
    };
    let scheme = match scheme.as_str() {
        "s3a" | "s3n" => "s3",
        "gcs" => "gs",
        "abfss" => "abfs",
        "wasbs" => "wasb",
        other => other,
    };
    let segments: Vec<&str> = rest
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    format!("{scheme}://{}", segments.join("/"))
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn treats_equivalent_paths_as_equal() {
        let same = [
            "file:/tmp/w/t/data/a.parquet",
            "file:///tmp/w/t/data/a.parquet",
            "/tmp/w/t/data/a.parquet",
            "file://tmp/w//t/data/a.parquet",
        ];
        for path in same {
            assert_eq!(normalize(path), "file://tmp/w/t/data/a.parquet", "{path}");
        }
        assert_eq!(normalize("s3a://bucket/t/a"), normalize("s3://bucket/t/a"));
        assert_eq!(normalize("S3N://bucket//t/a"), normalize("s3://bucket/t/a"));
        assert_ne!(normalize("s3://bucket/t/a"), normalize("gs://bucket/t/a"));
        assert_ne!(normalize("s3://bucket-a/t"), normalize("s3://bucket-b/t"));
    }
}
