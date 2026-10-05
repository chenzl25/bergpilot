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

    let (status, ns) = call(
        &router,
        "GET",
        &format!("/api/catalogs/{id}/namespace?namespace=sales"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{ns}");
    assert_eq!(ns["tables"][0]["name"], "orders");
    assert_eq!(ns["tables"][0]["records"], 6);
    assert_eq!(ns["tables"][0]["data_files"], 4);
    assert_eq!(ns["tables"][0]["snapshots"], 2);

    let (_, names) = call(&router, "GET", &format!("/api/catalogs/{id}/names"), None).await;
    assert_eq!(
        names,
        json!({ "namespaces": [{ "namespace": ["sales"], "tables": ["orders"] }], "truncated": false })
    );

    // Properties: set and remove in one commit.
    let (status, updated) = call(
        &router,
        "POST",
        "/api/table/properties",
        Some(json!({
            "catalog_id": id, "namespace": ["sales"], "table": "orders",
            "set": { "write.target-file-size-bytes": "134217728", "owner": "data-team" },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["properties"]["owner"], "data-team");
    let (_, updated) = call(
        &router,
        "POST",
        "/api/table/properties",
        Some(json!({
            "catalog_id": id, "namespace": ["sales"], "table": "orders", "remove": ["owner"],
        })),
    )
    .await;
    assert!(updated["properties"].get("owner").is_none(), "{updated}");
    assert_eq!(
        updated["properties"]["write.target-file-size-bytes"],
        "134217728"
    );
    let (status, _) = call(
        &router,
        "POST",
        "/api/table/properties",
        Some(json!({ "catalog_id": id, "namespace": ["sales"], "table": "orders" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Time travel: the first snapshot had three rows.
    let (_, first) = call(
        &router,
        "POST",
        "/api/query",
        Some(json!({
            "sql": r#"SELECT snapshot_id FROM local.sales."orders$snapshots"
                      ORDER BY sequence_number LIMIT 1"#
        })),
    )
    .await;
    let first_snapshot = first["rows"][0][0].as_str().unwrap().to_owned();
    let (status, travelled) = call(
        &router,
        "POST",
        "/api/query",
        Some(json!({
            "sql": format!(r#"SELECT count(*) FROM local.sales."orders@{first_snapshot}""#)
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{travelled}");
    let first_count = travelled["rows"][0][0].as_str().unwrap();
    assert!(
        first_count == "3",
        "first snapshot holds 3 rows, got {first_count}"
    );
    let (_, on_main) = call(
        &router,
        "POST",
        "/api/query",
        Some(json!({ "sql": r#"SELECT count(*) FROM local.sales."orders@main""# })),
    )
    .await;
    assert_eq!(on_main["rows"], json!([["6"]]));
    let (status, _) = call(
        &router,
        "POST",
        "/api/query",
        Some(json!({ "sql": r#"SELECT count(*) FROM local.sales."orders@nope""# })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

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

#[tokio::test]
async fn refuses_foreign_host_names_without_a_token() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).await.unwrap();
    let request = |host: &str| {
        Request::builder()
            .uri("/api/catalogs")
            .header("host", host)
            .body(Body::empty())
            .unwrap()
    };
    let open = app(AppState::new(store.clone(), None));
    let rebinding = open
        .clone()
        .oneshot(request("evil.example:7878"))
        .await
        .unwrap();
    assert_eq!(rebinding.status(), StatusCode::FORBIDDEN);
    let local = open.oneshot(request("127.0.0.1:7878")).await.unwrap();
    assert_eq!(local.status(), StatusCode::OK);

    // With a token the token is the protection, whatever the host name.
    let guarded = app(AppState::new(store, Some("secret".into())));
    let response = guarded
        .oneshot(
            Request::builder()
                .uri("/api/catalogs")
                .header("host", "bergpilot.internal:7878")
                .header("authorization", "Bearer secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
