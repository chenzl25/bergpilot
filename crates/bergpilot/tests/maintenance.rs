//! Maintenance through the HTTP API and the job worker, against a SQLite SQL
//! catalog with a local warehouse: compaction, snapshot expiry with file
//! cleanup, orphan-file removal, manifest rewrite and schedules.

#![cfg(feature = "sql")]

mod common;

use std::time::{Duration, SystemTime};

use axum::http::StatusCode;
use bergpilot::server::{AppState, app};
use bergpilot::store::Store;
use common::{LocalCatalog, call, run_job};
use serde_json::{Value, json};

const BATCHES: [&str; 5] = [
    "(1, 'eu', 10.0), (2, 'us', 20.0)",
    "(3, 'eu', 30.0), (4, 'us', 40.0)",
    "(5, 'eu', 50.0), (6, 'us', 60.0)",
    "(7, 'eu', 70.0), (8, 'us', NULL)",
    "(9, 'eu', NULL), (10, 'us', 100.0)",
];

#[tokio::test(flavor = "multi_thread")]
async fn maintains_a_table_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let local = LocalCatalog::new(dir.path()).await;
    local.create_orders().await;
    local.append_orders(&BATCHES).await;
    // Five appends into two partitions.
    assert_eq!(local.data_files_on_disk().len(), 10);

    let store = Store::open(&dir.path().join("bergpilot")).await.unwrap();
    let state = AppState::new(store, None);
    state.start().await.unwrap();
    let router = app(state);
    let (status, created) = call(
        &router,
        "POST",
        "/api/catalogs",
        Some(local.registration("local")),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["id"].as_i64().unwrap();
    let target = json!({ "catalog_id": id, "namespace": ["sales"], "table": "orders" });
    let with_task = |task: Value| {
        let mut body = target.clone();
        body["task"] = task;
        body
    };
    let totals = || async {
        let (_, result) = call(
            &router,
            "POST",
            "/api/query",
            Some(json!({ "sql": "SELECT count(*), sum(amount) FROM local.sales.orders" })),
        )
        .await;
        result["rows"].clone()
    };
    let before_totals = totals().await;
    assert_eq!(before_totals, json!([["10", "380.0"]]));

    // Compaction: preview, then run.
    let compact = json!({ "kind": "compact", "strategy": "small_files" });
    let (status, preview) = call(
        &router,
        "POST",
        "/api/maintenance/preview",
        Some(with_task(compact.clone())),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["data_files"], 10);
    let job = run_job(&router, with_task(compact)).await;
    assert_eq!(job["outcome"]["rewrote"], true, "{job}");
    assert_eq!(job["outcome"]["input_data_files"], 10);
    assert_eq!(job["outcome"]["output_files"], 2, "one file per partition");
    assert_eq!(totals().await, before_totals);
    let (_, files) = call(
        &router,
        "GET",
        &format!("/api/catalogs/{id}/table/files?namespace=sales&name=orders"),
        None,
    )
    .await;
    assert_eq!(files["data"]["files"], 2);
    // The rewritten files are still on disk until snapshots expire.
    assert_eq!(local.data_files_on_disk().len(), 12);

    // Expiry: the preview names exactly what the run removes.
    let expire = json!({
        "kind": "expire_snapshots",
        "older_than_days": 0,
        "retain_last": 1,
        "clean_files": true,
    });
    let (_, preview) = call(
        &router,
        "POST",
        "/api/maintenance/preview",
        Some(with_task(expire.clone())),
    )
    .await;
    assert_eq!(preview["remaining_snapshots"], 1, "{preview}");
    let job = run_job(&router, with_task(expire)).await;
    assert_eq!(
        job["outcome"]["expired_snapshot_ids"], preview["expired_snapshot_ids"],
        "{job}"
    );
    assert_eq!(
        job["outcome"]["expired_snapshot_ids"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    assert_eq!(job["outcome"]["cleaned_files"], true);
    assert_eq!(
        local.data_files_on_disk().len(),
        2,
        "old data files are deleted"
    );
    assert_eq!(totals().await, before_totals);

    // Orphans: a stray file is reported by a dry run and deleted once old
    // enough. A real run on files younger than a day is refused.
    let stray = local.warehouse_dir.join("sales/orders/data/stray.parquet");
    std::fs::write(&stray, b"not referenced").unwrap();
    let job = run_job(
        &router,
        with_task(json!({ "kind": "remove_orphan_files", "older_than_days": 0, "dry_run": true })),
    )
    .await;
    assert_eq!(job["outcome"]["count"], 1, "{job}");
    assert!(
        job["outcome"]["files"][0]
            .as_str()
            .unwrap()
            .ends_with("stray.parquet")
    );
    assert!(stray.exists());
    let (status, refused) = call(
        &router,
        "POST",
        "/api/jobs",
        Some(with_task(
            json!({ "kind": "remove_orphan_files", "older_than_days": 0, "dry_run": false }),
        )),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    let two_days_ago = SystemTime::now() - Duration::from_secs(2 * 24 * 3600);
    std::fs::File::options()
        .write(true)
        .open(&stray)
        .unwrap()
        .set_modified(two_days_ago)
        .unwrap();
    let job = run_job(
        &router,
        with_task(json!({ "kind": "remove_orphan_files", "older_than_days": 1, "dry_run": false })),
    )
    .await;
    assert_eq!(job["outcome"]["count"], 1, "{job}");
    assert!(!stray.exists());
    assert_eq!(totals().await, before_totals);

    // Manifest rewrite after a few more appends.
    local.append_orders(&BATCHES[..3]).await;
    let rewrite = json!({ "kind": "rewrite_manifests" });
    let (_, preview) = call(
        &router,
        "POST",
        "/api/maintenance/preview",
        Some(with_task(rewrite.clone())),
    )
    .await;
    let manifests_before = preview["data_manifests"].as_u64().unwrap();
    assert!(manifests_before >= 2, "{preview}");
    let job = run_job(&router, with_task(rewrite)).await;
    assert_eq!(
        job["outcome"]["manifests_before"], manifests_before,
        "{job}"
    );
    assert!(job["outcome"]["manifests_after"].as_u64().unwrap() < manifests_before);
    let (_, totals_after) = call(
        &router,
        "POST",
        "/api/query",
        Some(json!({ "sql": "SELECT count(*) FROM local.sales.orders" })),
    )
    .await;
    assert_eq!(totals_after["rows"], json!([["16"]]));

    // History for the table, newest first.
    let (_, jobs) = call(
        &router,
        "GET",
        &format!("/api/jobs?catalog_id={id}&namespace=sales&table=orders"),
        None,
    )
    .await;
    let kinds: Vec<&str> = jobs
        .as_array()
        .unwrap()
        .iter()
        .map(|job| job["task"]["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        [
            "rewrite_manifests",
            "remove_orphan_files",
            "remove_orphan_files",
            "expire_snapshots",
            "compact"
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn schedules_queue_jobs_when_due() {
    let dir = tempfile::tempdir().unwrap();
    let local = LocalCatalog::new(dir.path()).await;
    local.create_orders().await;
    local.append_orders(&BATCHES[..2]).await;

    let store = Store::open(&dir.path().join("bergpilot")).await.unwrap();
    let pool = store.pool().clone();
    let state = AppState::new(store, None);
    let jobs = state.jobs.clone();
    let router = app(state);
    let (_, created) = call(
        &router,
        "POST",
        "/api/catalogs",
        Some(local.registration("local")),
    )
    .await;
    let id = created["id"].as_i64().unwrap();

    let schedule = json!({
        "catalog_id": id,
        "namespace": ["sales"],
        "table": "orders",
        "task": { "kind": "rewrite_manifests" },
        "cron": "0 3 * * *",
        "enabled": true,
    });
    let (status, created) = call(&router, "POST", "/api/schedules", Some(schedule.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert!(created["next_run_ms"].as_i64().unwrap() > 0);
    assert!(!created["cron_description"].as_str().unwrap().is_empty());

    let (status, invalid) = call(
        &router,
        "POST",
        "/api/schedules",
        Some({
            let mut bad = schedule.clone();
            bad["cron"] = json!("0 0 3 * * *");
            bad
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{invalid}");

    // Make it due; one tick queues exactly one job, a second tick does not
    // queue another while the first is still queued.
    sqlx::query("update schedules set next_run_ms = 0")
        .execute(&pool)
        .await
        .unwrap();
    jobs.queue_due_schedules().await.unwrap();
    sqlx::query("update schedules set next_run_ms = 0")
        .execute(&pool)
        .await
        .unwrap();
    jobs.queue_due_schedules().await.unwrap();
    let (_, listed) = call(&router, "GET", "/api/jobs", None).await;
    let listed = listed.as_array().unwrap();
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0]["schedule_id"], created["id"]);
    assert_eq!(listed[0]["status"], "queued");

    // The worker is not running here, so the job stays queued and can be
    // cancelled.
    let job_id = listed[0]["id"].as_i64().unwrap();
    let (status, cancelled) =
        call(&router, "POST", &format!("/api/jobs/{job_id}/cancel"), None).await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(cancelled["status"], "cancelled");
    assert!(cancelled.get("finished_at").is_some());

    // Disabling clears the next run.
    let schedule_id = created["id"].as_i64().unwrap();
    let mut disabled = schedule.clone();
    disabled["enabled"] = json!(false);
    let (_, updated) = call(
        &router,
        "PUT",
        &format!("/api/schedules/{schedule_id}"),
        Some(disabled),
    )
    .await;
    assert_eq!(updated["enabled"], false);
    assert!(updated.get("next_run_ms").is_none());
    let (status, _) = call(
        &router,
        "DELETE",
        &format!("/api/schedules/{schedule_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

/// Position deletes written with iceberg-rust's writer: reads apply them, a
/// files-with-deletes compaction keeps the result, and a full compaction
/// drops the delete files.
#[tokio::test(flavor = "multi_thread")]
async fn compaction_applies_position_deletes() {
    use std::collections::HashMap;
    use std::sync::Arc;

    use datafusion::parquet::file::properties::WriterProperties;
    use iceberg::spec::{DataFileFormat, NestedField, PrimitiveType, Schema, Type};
    use iceberg::transaction::{ApplyTransactionAction, Transaction};
    use iceberg::writer::base_writer::position_delete_file_writer::{
        POSITION_DELETE_SCHEMA, PositionDeleteFileWriterBuilder,
    };
    use iceberg::writer::file_writer::ParquetWriterBuilder;
    use iceberg::writer::file_writer::location_generator::{
        DefaultFileNameGenerator, DefaultLocationGenerator,
    };
    use iceberg::writer::file_writer::rolling_writer::RollingFileWriterBuilder;
    use iceberg::writer::{IcebergWriter, IcebergWriterBuilder, PositionDeleteInput};
    use iceberg::{NamespaceIdent, TableCreation, TableIdent};

    let dir = tempfile::tempdir().unwrap();
    let local = LocalCatalog::new(dir.path()).await;
    let namespace = NamespaceIdent::new("sales".to_owned());
    local
        .catalog
        .create_namespace(&namespace, HashMap::new())
        .await
        .unwrap();
    let schema = Schema::builder()
        .with_fields(vec![
            NestedField::required(1, "id", Type::Primitive(PrimitiveType::Long)).into(),
            NestedField::optional(2, "v", Type::Primitive(PrimitiveType::Double)).into(),
        ])
        .build()
        .unwrap();
    local
        .catalog
        .create_table(
            &namespace,
            TableCreation::builder()
                .name("plain".to_owned())
                .schema(schema)
                .build(),
        )
        .await
        .unwrap();
    let ctx = datafusion::prelude::SessionContext::new();
    ctx.register_catalog(
        "seed",
        Arc::new(
            iceberg_datafusion::IcebergCatalogProvider::try_new(local.catalog.clone())
                .await
                .unwrap(),
        ),
    );
    for values in [
        "(1, 1.0), (2, 2.0), (3, 3.0), (4, NULL)",
        "(5, 5.0), (6, 6.0), (7, 7.0), (8, NULL)",
        "(9, 9.0), (10, 10.0), (11, 11.0), (12, NULL)",
    ] {
        ctx.sql(&format!("INSERT INTO seed.sales.plain VALUES {values}"))
            .await
            .unwrap()
            .collect()
            .await
            .unwrap();
    }

    // Delete rows 0 and 1 of the first data file and row 3 of the second.
    let ident = TableIdent::new(namespace.clone(), "plain".to_owned());
    let table = local.catalog.load_table(&ident).await.unwrap();
    let mut paths: Vec<String> = bergpilot::metadata_tables::live_files(&table)
        .await
        .unwrap()
        .iter()
        .map(|live| live.file.file_path().to_owned())
        .collect();
    paths.sort();
    assert_eq!(paths.len(), 3);
    let rolling = RollingFileWriterBuilder::new_with_default_file_size(
        ParquetWriterBuilder::new(
            WriterProperties::builder().build(),
            Arc::new(POSITION_DELETE_SCHEMA.clone()),
        ),
        table.file_io().clone(),
        DefaultLocationGenerator::new(table.metadata()).unwrap(),
        DefaultFileNameGenerator::new("pos-del".to_owned(), None, DataFileFormat::Parquet),
    );
    let mut writer = PositionDeleteFileWriterBuilder::new(rolling)
        .build(None)
        .await
        .unwrap();
    writer
        .write(vec![
            PositionDeleteInput::new(Arc::from(paths[0].as_str()), 0),
            PositionDeleteInput::new(Arc::from(paths[0].as_str()), 1),
            PositionDeleteInput::new(Arc::from(paths[1].as_str()), 3),
        ])
        .await
        .unwrap();
    let delete_files = writer.close().await.unwrap();
    let tx = Transaction::new(&table);
    let tx = tx
        .fast_append()
        .add_data_files(delete_files)
        .apply(tx)
        .unwrap();
    tx.commit(local.catalog.as_ref()).await.unwrap();

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
    let id = created["id"].as_i64().unwrap();
    let target = json!({ "catalog_id": id, "namespace": ["sales"], "table": "plain" });
    let with_task = |task: Value| {
        let mut body = target.clone();
        body["task"] = task;
        body
    };
    let totals = || async {
        let (_, result) = call(
            &router,
            "POST",
            "/api/query",
            Some(json!({ "sql": "SELECT count(*), sum(id) FROM local.sales.plain" })),
        )
        .await;
        result["rows"].clone()
    };
    let delete_count = || async {
        let (_, files) = call(
            &router,
            "GET",
            &format!("/api/catalogs/{id}/table/files?namespace=sales&name=plain"),
            None,
        )
        .await;
        (
            files["data"]["files"].as_u64().unwrap(),
            files["position_deletes"]["files"].as_u64().unwrap(),
        )
    };

    // Three of the twelve rows are deleted. The sum is checked only for
    // staying the same, since which ids sit at those positions depends on
    // how the writer ordered rows.
    let before = totals().await;
    assert_eq!(before[0][0], "9", "{before}");
    assert_eq!(delete_count().await, (3, 1));

    let job = run_job(
        &router,
        with_task(
            json!({ "kind": "compact", "strategy": "files_with_deletes", "min_delete_files": 1 }),
        ),
    )
    .await;
    assert_eq!(job["outcome"]["input_delete_files"], 1, "{job}");
    assert_eq!(totals().await, before);

    let job = run_job(
        &router,
        with_task(json!({ "kind": "compact", "strategy": "full" })),
    )
    .await;
    assert_eq!(job["outcome"]["rewrote"], true, "{job}");
    assert_eq!(totals().await, before);
    assert_eq!(
        delete_count().await,
        (1, 0),
        "a full compaction drops the delete file"
    );
}
