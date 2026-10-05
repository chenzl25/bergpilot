//! Live data and delete files of a snapshot, grouped by size.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use futures::{StreamExt, TryStreamExt};
use iceberg::spec::{DataContentType, ManifestFile};
use iceberg::table::Table;
use lru::LruCache;

use crate::error::{ApiError, ApiResult};
use crate::types::{FileStats, FileTotals, SizeBucket};

const MIB: u64 = 1024 * 1024;

/// Upper bounds (exclusive) of the size buckets; the last bucket is open.
const BUCKET_BOUNDS: [(u64, &str); 4] = [
    (8 * MIB, "< 8 MiB"),
    (32 * MIB, "8–32 MiB"),
    (128 * MIB, "32–128 MiB"),
    (512 * MIB, "128–512 MiB"),
];
const LAST_BUCKET_LABEL: &str = "≥ 512 MiB";

/// Manifests read concurrently per request.
const MANIFEST_CONCURRENCY: usize = 8;

/// Stats per (table uuid, snapshot id). Snapshots are immutable, so entries
/// never go stale; the cache is bounded only to cap memory.
#[derive(Clone)]
pub struct FileStatsCache {
    entries: Arc<Mutex<LruCache<(String, i64), FileStats>>>,
}

impl Default for FileStatsCache {
    fn default() -> Self {
        Self {
            entries: Arc::new(Mutex::new(LruCache::new(
                NonZeroUsize::new(512).expect("non-zero"),
            ))),
        }
    }
}

impl FileStatsCache {
    /// Stats of `snapshot_id`, or of the current snapshot when `None`.
    pub async fn stats(&self, table: &Table, snapshot_id: Option<i64>) -> ApiResult<FileStats> {
        let metadata = table.metadata();
        let snapshot = match snapshot_id {
            Some(id) => Some(metadata.snapshot_by_id(id).ok_or_else(|| {
                ApiError::NotFound(format!("snapshot {id} does not exist in this table"))
            })?),
            None => metadata.current_snapshot(),
        };
        let Some(snapshot) = snapshot else {
            return Ok(empty_stats());
        };

        let key = (metadata.uuid().to_string(), snapshot.snapshot_id());
        if let Some(hit) = self.lock().get(&key) {
            return Ok(hit.clone());
        }

        let manifest_list = table.manifest_list_reader(snapshot).load().await?;
        let mut stats = empty_stats();
        stats.snapshot_id = Some(snapshot.snapshot_id().to_string());
        stats.manifests = manifest_list.entries().len() as u32;

        let file_io = table.file_io().clone();
        let mut manifests = futures::stream::iter(manifest_list.entries().iter().cloned())
            .map(|manifest: ManifestFile| {
                let file_io = file_io.clone();
                async move { manifest.load_manifest(&file_io).await }
            })
            .buffer_unordered(MANIFEST_CONCURRENCY);
        while let Some(manifest) = manifests.try_next().await? {
            for entry in manifest.entries().iter().filter(|entry| entry.is_alive()) {
                add_file(
                    &mut stats,
                    entry.content_type(),
                    entry.file_size_in_bytes(),
                    entry.record_count(),
                );
            }
        }

        self.lock().put(key, stats.clone());
        Ok(stats)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LruCache<(String, i64), FileStats>> {
        // A poisoned lock only means another request panicked mid-update of a
        // cache; the cached values themselves are still whole.
        self.entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

fn empty_stats() -> FileStats {
    let mut buckets = Vec::with_capacity(BUCKET_BOUNDS.len() + 1);
    let mut min = 0;
    for (max, label) in BUCKET_BOUNDS {
        buckets.push(SizeBucket {
            label: label.to_owned(),
            min_bytes: min,
            max_bytes: Some(max),
            data_files: 0,
            delete_files: 0,
        });
        min = max;
    }
    buckets.push(SizeBucket {
        label: LAST_BUCKET_LABEL.to_owned(),
        min_bytes: min,
        max_bytes: None,
        data_files: 0,
        delete_files: 0,
    });
    FileStats {
        snapshot_id: None,
        manifests: 0,
        data: FileTotals::default(),
        position_deletes: FileTotals::default(),
        equality_deletes: FileTotals::default(),
        buckets,
    }
}

fn add_file(stats: &mut FileStats, content: DataContentType, bytes: u64, records: u64) {
    let totals = match content {
        DataContentType::Data => &mut stats.data,
        DataContentType::PositionDeletes => &mut stats.position_deletes,
        DataContentType::EqualityDeletes => &mut stats.equality_deletes,
    };
    totals.files += 1;
    totals.bytes += bytes;
    totals.records += records;

    let bucket = stats
        .buckets
        .iter_mut()
        .find(|bucket| bucket.max_bytes.is_none_or(|max| bytes < max))
        .expect("the last bucket is unbounded");
    match content {
        DataContentType::Data => bucket.data_files += 1,
        _ => bucket.delete_files += 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_files_by_size_and_content() {
        let mut stats = empty_stats();
        add_file(&mut stats, DataContentType::Data, 0, 1);
        add_file(&mut stats, DataContentType::Data, 8 * MIB - 1, 10);
        add_file(&mut stats, DataContentType::Data, 8 * MIB, 20);
        add_file(&mut stats, DataContentType::PositionDeletes, 100, 3);
        add_file(&mut stats, DataContentType::EqualityDeletes, 600 * MIB, 4);

        let counts: Vec<(u64, u64)> = stats
            .buckets
            .iter()
            .map(|bucket| (bucket.data_files, bucket.delete_files))
            .collect();
        assert_eq!(counts, vec![(2, 1), (1, 0), (0, 0), (0, 0), (0, 1)]);
        assert_eq!(stats.data.files, 3);
        assert_eq!(stats.data.records, 31);
        assert_eq!(stats.position_deletes.records, 3);
        assert_eq!(stats.equality_deletes.bytes, 600 * MIB);
    }
}
