//! Links between snapshots that parent ids do not record.
//!
//! RisingWave's copy-on-write upsert sinks commit to an `ingestion` branch.
//! RisingWave's compactor then plans a rewrite from one ingestion snapshot
//! and publishes the result to `main` as an `overwrite` whose parent is the
//! previous `main` snapshot, so the two histories never share a parent link.
//! Every snapshot in that flow carries the sink's `risingwave.commit.epoch`,
//! and the publish copies the epoch of the snapshot it was planned from.

use std::collections::HashMap;

/// The snapshot summary key RisingWave writes on every commit.
pub const RISINGWAVE_EPOCH: &str = "risingwave.commit.epoch";

/// What [`published_from`] needs to know about one snapshot.
pub struct SnapshotLink<'a> {
    pub id: i64,
    pub parent: Option<i64>,
    pub sequence_number: i64,
    pub epoch: Option<&'a str>,
}

/// Maps a snapshot to the snapshot on another line of history it was
/// published from: the oldest snapshot with the same RisingWave epoch that is
/// not one of its own ancestors. RisingWave's own compaction on `main` and on
/// `ingestion` also repeats the epoch, but there the earlier snapshot is an
/// ancestor, so only cross-branch publishes match. When an expired parent
/// hides whether the earlier snapshot is an ancestor, there is no link. Format
/// v1 tables have no sequence numbers to order snapshots by, so they never
/// match.
pub fn published_from(snapshots: &[SnapshotLink<'_>]) -> HashMap<i64, i64> {
    let by_id: HashMap<i64, &SnapshotLink<'_>> = snapshots.iter().map(|s| (s.id, s)).collect();
    let mut by_epoch: HashMap<&str, Vec<&SnapshotLink<'_>>> = HashMap::new();
    for snapshot in snapshots {
        if let Some(epoch) = snapshot.epoch {
            by_epoch.entry(epoch).or_default().push(snapshot);
        }
    }

    let mut out = HashMap::new();
    for group in by_epoch.values_mut().filter(|group| group.len() > 1) {
        group.sort_by_key(|s| s.sequence_number);
        for (index, snapshot) in group.iter().enumerate() {
            let source = group[..index].iter().find(|candidate| {
                candidate.sequence_number > 0
                    && candidate.sequence_number < snapshot.sequence_number
                    && is_ancestor(&by_id, snapshot, candidate) == Some(false)
            });
            if let Some(source) = source {
                out.insert(snapshot.id, source.id);
            }
        }
    }
    out
}

/// Whether `ancestor` is on `snapshot`'s parent chain, or `None` when an
/// expired parent cuts the chain off first. Parents always have lower
/// sequence numbers, so the walk stops once it passes `ancestor`'s.
fn is_ancestor(
    by_id: &HashMap<i64, &SnapshotLink<'_>>,
    snapshot: &SnapshotLink<'_>,
    ancestor: &SnapshotLink<'_>,
) -> Option<bool> {
    let mut next = snapshot.parent;
    while let Some(id) = next {
        if id == ancestor.id {
            return Some(true);
        }
        let parent = by_id.get(&id)?;
        if parent.sequence_number < ancestor.sequence_number {
            return Some(false);
        }
        next = parent.parent;
    }
    Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(id: i64, parent: Option<i64>, epoch: Option<&'static str>) -> SnapshotLink<'static> {
        SnapshotLink {
            id,
            parent,
            sequence_number: id,
            epoch,
        }
    }

    /// The shape RisingWave 3.2 wrote for a copy-on-write sink: appends on
    /// `ingestion`, a compaction `replace` that keeps the planned snapshot's
    /// epoch, and `overwrite` publishes on `main` with the same epoch.
    #[test]
    fn copy_on_write_publishes_link_to_the_planned_ingestion_snapshot() {
        let snapshots = [
            link(1, None, Some("e1")),
            link(2, Some(1), Some("e2")),
            link(3, Some(2), Some("e2")), // replace on ingestion, planned from 2
            link(4, None, Some("e2")),    // first publish to main
            link(5, Some(3), Some("e5")), // append on ingestion
            link(6, Some(5), Some("e6")), // append, committed while 7 was planned from 5
            link(7, Some(6), Some("e5")), // replace planned from 5, rebased on 6
            link(8, Some(4), Some("e5")), // publish planned from 5
        ];
        let links = published_from(&snapshots);
        assert_eq!(links.get(&4), Some(&2));
        assert_eq!(links.get(&8), Some(&5));
        // Compactions on the same branch repeat the epoch of an ancestor.
        assert_eq!(links.get(&3), None);
        assert_eq!(links.get(&7), None);
        assert_eq!(links.len(), 2);
    }

    #[test]
    fn plain_tables_and_v1_tables_have_no_links() {
        let merge_on_read = [
            link(1, None, Some("e1")),
            link(2, Some(1), Some("e2")),
            link(3, Some(2), Some("e2")), // RisingWave's own compaction on main
            link(4, Some(3), None),       // BergPilot's compaction carries no epoch
        ];
        assert!(published_from(&merge_on_read).is_empty());

        let v1 = [
            SnapshotLink {
                id: 10,
                parent: None,
                sequence_number: 0,
                epoch: Some("e"),
            },
            SnapshotLink {
                id: 11,
                parent: None,
                sequence_number: 0,
                epoch: Some("e"),
            },
        ];
        assert!(published_from(&v1).is_empty());
    }

    /// When an expired parent hides whether the earlier snapshot is an
    /// ancestor, no link is drawn; an older retained parent settles it.
    #[test]
    fn expired_parents_leave_the_link_out() {
        let hidden = [link(2, Some(1), Some("e")), link(5, Some(4), Some("e"))];
        assert!(published_from(&hidden).is_empty());

        let settled = [
            link(1, None, None),
            link(2, Some(1), Some("e")),
            link(5, Some(1), Some("e")),
        ];
        assert_eq!(published_from(&settled).get(&5), Some(&2));
    }
}
