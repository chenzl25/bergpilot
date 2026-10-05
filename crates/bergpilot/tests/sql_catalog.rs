//! End-to-end through the HTTP API with a SQLite-backed SQL (JDBC-layout)
//! catalog and a local-filesystem warehouse; no external services.

#![cfg(feature = "sql")]

mod common;

use axum::http::StatusCode;
use bergpilot::server::{AppState, app};
use bergpilot::store::Store;
use common::{LocalCatalog, call};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn browses_and_queries_a_sql_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let local = LocalCatalog::new(dir.path()).await;
    local.create_orders().await;
    local
        .append_orders(&[
            "(1, 'eu', 10.0), (2, 'us', 20.0), (3, 'eu', NULL)",
            "(4, 'eu', 50.0), (5, 'us', 130.0), (6, 'us', NULL)",
        ])
        .await;
    let (db_uri, warehouse) = (local.db_uri.clone(), local.warehouse.clone());

    let store = Store::open(&dir.path().join("bergpilot")).await.unwrap();
    let router = app(AppState::new(store, None));

    let (status, created) = call(
        &router,
        "POST",
        "/api/catalogs",
        Some(local.registration("local")),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["id"].as_i64().unwrap();

    let (_, namespaces) = call(
        &router,
        "GET",
        &format!("/api/catalogs/{id}/namespaces"),
        None,
    )
    .await;
    assert_eq!(namespaces["namespaces"], json!([["sales"]]));

    let (_, tables) = call(
        &router,
        "GET",
        &format!("/api/catalogs/{id}/tables?namespace=sales"),
        None,
    )
    .await;
    assert_eq!(tables["tables"], json!(["orders"]));

    let (status, detail) = call(
        &router,
        "GET",
        &format!("/api/catalogs/{id}/table?namespace=sales&name=orders"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["catalog"], "local");
    assert_eq!(detail["snapshots"].as_array().unwrap().len(), 2);
    assert_eq!(detail["partition_fields"][0]["source"], "region");

    let (_, files) = call(
        &router,
        "GET",
        &format!("/api/catalogs/{id}/table/files?namespace=sales&name=orders"),
        None,
    )
    .await;
    assert_eq!(files["data"]["records"], 6);
    // Two appends into two regions each.
    assert_eq!(files["data"]["files"], 4);

    let (status, result) = call(
        &router,
        "POST",
        "/api/query",
        Some(json!({
            "sql": "SELECT region, sum(amount) AS total FROM local.sales.orders \
                    GROUP BY region ORDER BY region"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["rows"], json!([["eu", "60.0"], ["us", "150.0"]]));

    // Metadata tables.
    let query = |sql: &str| {
        let router = router.clone();
        let sql = sql.to_owned();
        async move {
            let (status, result) =
                call(&router, "POST", "/api/query", Some(json!({ "sql": sql }))).await;
            assert_eq!(status, StatusCode::OK, "{result}");
            result["rows"].clone()
        }
    };
    assert_eq!(
        query(r#"SELECT count(*), min(operation) FROM local.sales."orders$snapshots""#).await,
        json!([["2", "append"]])
    );
    assert_eq!(
        query(
            r#"SELECT count(*), bool_and(is_current_ancestor) FROM local.sales."orders$history""#
        )
        .await,
        json!([["2", "true"]])
    );
    assert_eq!(
        query(r#"SELECT name, type FROM local.sales."orders$refs""#).await,
        json!([["main", "branch"]])
    );
    assert_eq!(
        query(
            r#"SELECT partition, sum(record_count), count(*) FROM local.sales."orders$files"
               WHERE content = 'data' GROUP BY partition ORDER BY partition"#
        )
        .await,
        json!([["region=eu", "3", "2"], ["region=us", "3", "2"]])
    );
    assert_eq!(
        query(r#"SELECT partition, record_count, data_files FROM local.sales."orders$partitions""#)
            .await,
        json!([["region=eu", "3", "2"], ["region=us", "3", "2"]])
    );
    assert_eq!(
        query(r#"SELECT count(*), sum(added_files_count) FROM local.sales."orders$manifests""#)
            .await,
        json!([["2", "4"]])
    );
    let (status, error) = call(
        &router,
        "POST",
        "/api/query",
        Some(json!({ "sql": r#"SELECT * FROM local.sales."orders$nope""# })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        error["error"].as_str().unwrap().contains("$partitions"),
        "{error}"
    );

    let (_, partitions) = call(
        &router,
        "GET",
        &format!("/api/catalogs/{id}/table/partitions?namespace=sales&name=orders"),
        None,
    )
    .await;
    assert_eq!(partitions[1]["partition"], "region=us");
    assert_eq!(partitions[1]["data_files"], 2);

    // The wrong stored name finds nothing: the setting matters.
    let (status, test) = call(
        &router,
        "POST",
        "/api/catalogs/test",
        Some(json!({
            "catalog": {
                "name": "other",
                "kind": "sql",
                "properties": { "uri": db_uri, "warehouse": warehouse },
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(test["ok"], true);
    assert_eq!(test["namespaces"], 0);
}

#[tokio::test]
async fn rejects_a_password_in_the_database_url() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).await.unwrap();
    let router = app(AppState::new(store, None));
    let (status, body) = call(
        &router,
        "POST",
        "/api/catalogs",
        Some(json!({
            "name": "pg",
            "kind": "sql",
            "properties": { "uri": "postgres://iceberg:hunter2@db:5432/catalog" },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("password field"));
}
