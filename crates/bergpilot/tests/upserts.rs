//! Tables written the way RisingWave's upsert sink writes them: equality
//! deletes on the primary key, position deletes for rows changed twice in
//! one commit. Reads must apply both, compaction must keep the same rows,
//! and a compaction must stay correct when the writer commits while it runs.

#![cfg(feature = "sql")]

mod common;

use axum::Router;
use std::sync::{Arc, Mutex};

use bergpilot::io_counter::{CountingStorageFactory, IoCounter};
use bergpilot::maintenance::{self, MaintenanceLimits, Progress};
use bergpilot::server::{AppState, app};
use bergpilot::store::Store;
use bergpilot::types::{CompactionStrategy, JobPhase, JobProgress, MaintenanceTask};
use common::racing::RacingCatalog;
use common::upsert::{COMMIT_EPOCH, Change, UpsertTable, commit_files, position_delete_file};
use common::{LocalCatalog, call, run_job};
use futures::FutureExt;
use iceberg::spec::DataContentType;
use serde_json::{Value, json};

use Change::{Delete, Upsert};

struct Fixture {
    _dir: tempfile::TempDir,
    local: LocalCatalog,
    table: UpsertTable,
    router: Router,
    catalog_id: i64,
    /// The data file of the first commit, ids 1 to 6 at positions 0 to 5.
    first_data_file: String,
}

/// Three commits: inserts, then updates and deletes of earlier rows
/// (equality deletes) mixed with rows changed twice in the same commit
/// (position deletes).
async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let local = LocalCatalog::new(dir.path()).await;
    let mut table = UpsertTable::create(local.catalog.clone(), "sales").await;
    let first = table
        .commit(&[
            Upsert(1, "ann", 10.0),
            Upsert(2, "bob", 20.0),
            Upsert(3, "cid", 30.0),
            Upsert(4, "dan", 40.0),
            Upsert(5, "eve", 50.0),
            Upsert(6, "fay", 60.0),
        ])
        .await;
    table
        .commit(&[
            Upsert(2, "bob", 21.0),
            Delete(3),
            Upsert(7, "gus", 70.0),
            Upsert(8, "hal", 80.0),
            Delete(8),
            Upsert(7, "gus", 71.0),
        ])
        .await;
    table
        .commit(&[Upsert(2, "bob", 22.0), Delete(1), Upsert(5, "eve", 51.0)])
        .await;
    let first_data_file = first
        .iter()
        .find(|file| file.content_type() == DataContentType::Data)
        .unwrap()
        .file_path()
        .to_owned();

    let store = Store::open(&dir.path().join("bergpilot")).await.unwrap();
    let state = AppState::new(store, None);
    state.start().await.unwrap();
    let router = app(state);
    let (_, created) = call(
        &router,
        "POST",
        "/api/catalogs",
        Some(local.registration("local")),
    )
    .await;
    let catalog_id = created["id"].as_i64().unwrap();
    Fixture {
        _dir: dir,
        local,
        table,
        router,
        catalog_id,
        first_data_file,
    }
}

impl Fixture {
    async fn rows(&self) -> Value {
        let (_, result) = call(
            &self.router,
            "POST",
            "/api/query",
            Some(json!({ "sql": UpsertTable::SELECT_ALL })),
        )
        .await;
        result["rows"].clone()
    }

    /// Live (data, position delete, equality delete) file counts.
    async fn file_counts(&self) -> (u64, u64, u64) {
        let (_, files) = call(
            &self.router,
            "GET",
            &format!(
                "/api/catalogs/{}/table/files?namespace=sales&name=accounts",
                self.catalog_id
            ),
            None,
        )
        .await;
        let count = |key: &str| files[key]["files"].as_u64().unwrap();
        (
            count("data"),
            count("position_deletes"),
            count("equality_deletes"),
        )
    }

    fn job(&self, task: Value) -> Value {
        json!({
            "catalog_id": self.catalog_id,
            "namespace": ["sales"],
            "table": "accounts",
            "task": task,
        })
    }

    async fn current_epoch(&self) -> Option<String> {
        let table = self
            .local
            .catalog
            .load_table(&self.table.ident)
            .await
            .unwrap();
        table
            .metadata()
            .current_snapshot()
            .unwrap()
            .summary()
            .additional_properties
            .get(COMMIT_EPOCH)
            .cloned()
    }
}

fn full_compaction() -> MaintenanceTask {
    MaintenanceTask::Compact {
        strategy: CompactionStrategy::Full,
        target_file_size_mb: None,
        small_file_threshold_mb: None,
        min_delete_files: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_and_compacts_equality_deletes() {
    let fixture = fixture().await;
    let expected = fixture.table.expected_rows();
    assert_eq!(
        expected,
        json!([
            ["2", "bob", "22.0"],
            ["4", "dan", "40.0"],
            ["5", "eve", "51.0"],
            ["6", "fay", "60.0"],
            ["7", "gus", "71.0"],
        ])
    );
    assert_eq!(fixture.rows().await, expected);
    let (data, position, equality) = fixture.file_counts().await;
    assert_eq!(data, 3, "one data file per commit");
    assert_eq!(
        position, 1,
        "rows 7 and 8 changed twice in the second commit"
    );
    assert_eq!(
        equality, 2,
        "the second and third commits change earlier rows"
    );

    let job = run_job(
        &fixture.router,
        fixture.job(json!({
            "kind": "compact",
            "strategy": "files_with_deletes",
            "min_delete_files": 1,
        })),
    )
    .await;
    assert_eq!(job["outcome"]["rewrote"], true, "{job}");
    assert_eq!(fixture.rows().await, expected);

    let job = run_job(
        &fixture.router,
        fixture.job(json!({ "kind": "compact", "strategy": "full" })),
    )
    .await;
    assert_eq!(job["outcome"]["rewrote"], true, "{job}");
    assert_eq!(fixture.rows().await, expected);
    assert_eq!(
        fixture.file_counts().await,
        (1, 0, 0),
        "a full compaction leaves one data file and no deletes"
    );
}

/// The writer commits updates and deletes of rows the compaction is
/// rewriting, after the compaction read them. The compaction's output must
/// not bring those rows back, and the snapshot it adds must not claim an
/// older RisingWave epoch than the writer's latest commit.
#[tokio::test(flavor = "multi_thread")]
async fn compaction_keeps_equality_deletes_committed_while_it_runs() {
    let mut fixture = fixture().await;
    let (files, epoch) = fixture
        .table
        .write(&[Delete(4), Upsert(6, "fay", 61.0), Upsert(9, "ivy", 90.0)])
        .await;
    let catalog = fixture.local.catalog.clone();
    let ident = fixture.table.ident.clone();
    let racing = RacingCatalog::new(
        fixture.local.catalog.clone(),
        async move { commit_files(catalog.as_ref(), &ident, files, epoch).await }.boxed(),
    );

    maintenance::run(
        racing.clone(),
        "local",
        &fixture.table.ident,
        &full_compaction(),
        &MaintenanceLimits::default(),
        &Progress::none(),
    )
    .await
    .unwrap();
    assert!(racing.raced().await);

    assert_eq!(fixture.rows().await, fixture.table.expected_rows());
    let current = fixture.current_epoch().await;
    assert!(
        current.is_none() || current.as_deref() == Some("4"),
        "the compaction snapshot claims epoch {current:?} after epoch 4 was committed"
    );
}

/// Another engine deletes a row by position in a data file the compaction
/// is rewriting. Committing the rewrite would bring the row back, so the
/// compaction must fail instead.
#[tokio::test(flavor = "multi_thread")]
async fn compaction_fails_when_rewritten_files_get_new_position_deletes() {
    let mut fixture = fixture().await;
    let table = fixture
        .local
        .catalog
        .load_table(&fixture.table.ident)
        .await
        .unwrap();
    // Id 4 sits at position 3 of the first data file.
    let files = position_delete_file(&table, &fixture.first_data_file, &[3]).await;
    fixture.table.forget(4);
    let catalog = fixture.local.catalog.clone();
    let ident = fixture.table.ident.clone();
    let racing = RacingCatalog::new(
        fixture.local.catalog.clone(),
        async move { commit_files(catalog.as_ref(), &ident, files, 99).await }.boxed(),
    );

    let result = maintenance::run(
        racing.clone(),
        "local",
        &fixture.table.ident,
        &full_compaction(),
        &MaintenanceLimits::default(),
        &Progress::none(),
    )
    .await;
    assert!(racing.raced().await);
    assert_eq!(
        fixture.rows().await,
        fixture.table.expected_rows(),
        "compaction result: {result:?}"
    );
    let error = result
        .expect_err("the compaction must not commit")
        .to_string();
    assert!(error.contains("position delete"), "{error}");
}

/// A compaction reports planning, rewriting and committing, ends with every
/// input file and byte counted, and its storage sees the input files read.
#[tokio::test(flavor = "multi_thread")]
async fn compaction_reports_progress() {
    let fixture = fixture().await;
    let io = Arc::new(IoCounter::default());
    let catalog = fixture
        .local
        .client(Arc::new(CountingStorageFactory::new(
            bergpilot::catalogs::default_storage(),
            io.clone(),
        )))
        .await;
    let reports = Arc::new(Mutex::new(Vec::<JobProgress>::new()));
    let progress = {
        let reports = reports.clone();
        Progress::new(
            move |progress| reports.lock().unwrap().push(progress),
            Some(io.clone()),
        )
    };
    maintenance::run(
        catalog,
        "local",
        &fixture.table.ident,
        &full_compaction(),
        &MaintenanceLimits::default(),
        &progress,
    )
    .await
    .unwrap();

    let reports = reports.lock().unwrap();
    let phases: Vec<JobPhase> = reports.iter().map(|report| report.phase).collect();
    assert_eq!(phases.first(), Some(&JobPhase::Planning), "{reports:?}");
    assert!(phases.contains(&JobPhase::Rewriting), "{reports:?}");
    let last = reports.last().unwrap();
    assert_eq!(last.phase, JobPhase::Committing);
    assert_eq!(last.files_total, 3);
    assert_eq!(last.files_done, 3);
    assert!(last.bytes_total > 0);
    assert_eq!(last.bytes_done, last.bytes_total);
    assert!(last.bytes_written > 0, "{last:?}");
    assert!(io.bytes_read(&fixture.first_data_file) > 0);
}
