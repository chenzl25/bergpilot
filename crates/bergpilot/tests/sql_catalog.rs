//! End-to-end through the HTTP API with a SQLite-backed SQL (JDBC-layout)
//! catalog and a local-filesystem warehouse; no external services.

#![cfg(feature = "sql")]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use bergpilot::server::{AppState, app};
use bergpilot::store::Store;
use http_body_util::BodyExt;
use iceberg::spec::{NestedField, PrimitiveType, Schema, Transform, Type, UnboundPartitionSpec};
use iceberg::{Catalog, CatalogBuilder, NamespaceIdent, TableCreation};
use iceberg_catalog_sql::SqlCatalogBuilder;
use iceberg_datafusion::IcebergCatalogProvider;
use iceberg_storage_opendal::OpenDalResolvingStorageFactory;
use serde_json::{Value, json};
use tower::ServiceExt;

/// The name the "other engine" gave the catalog; BergPilot calls it "local".
const STORED_CATALOG_NAME: &str = "java_jdbc";

#[tokio::test(flavor = "multi_thread")]
async fn browses_and_queries_a_sql_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let db_uri = format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("catalog.db").display()
    );
    let warehouse = format!("file://{}", dir.path().join("warehouse").display());
    seed(&db_uri, &warehouse).await;

    let store = Store::open(&dir.path().join("bergpilot")).await.unwrap();
    let router = app(AppState::new(store, None));

    let (status, created) = call(
        &router,
        "POST",
        "/api/catalogs",
        Some(json!({
            "name": "local",
            "kind": "sql",
            "properties": {
                "uri": db_uri,
                "warehouse": warehouse,
                "catalog_name": STORED_CATALOG_NAME,
            },
        })),
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

async fn seed(db_uri: &str, warehouse: &str) {
    let catalog: Arc<dyn Catalog> = Arc::new(
        SqlCatalogBuilder::default()
            .with_storage_factory(Arc::new(OpenDalResolvingStorageFactory::new()))
            .load(
                STORED_CATALOG_NAME,
                HashMap::from([
                    ("uri".to_owned(), db_uri.to_owned()),
                    ("warehouse".to_owned(), warehouse.to_owned()),
                ]),
            )
            .await
            .unwrap(),
    );
    let namespace = NamespaceIdent::new("sales".to_owned());
    catalog
        .create_namespace(&namespace, HashMap::new())
        .await
        .unwrap();
    let schema = Schema::builder()
        .with_fields(vec![
            NestedField::required(1, "id", Type::Primitive(PrimitiveType::Long)).into(),
            NestedField::required(2, "region", Type::Primitive(PrimitiveType::String)).into(),
            NestedField::optional(3, "amount", Type::Primitive(PrimitiveType::Double)).into(),
        ])
        .build()
        .unwrap();
    let spec = UnboundPartitionSpec::builder()
        .with_spec_id(0)
        .add_partition_field(2, "region", Transform::Identity)
        .unwrap()
        .build();
    catalog
        .create_table(
            &namespace,
            TableCreation::builder()
                .name("orders".to_owned())
                .schema(schema)
                .partition_spec(spec)
                .build(),
        )
        .await
        .unwrap();

    let ctx = datafusion::prelude::SessionContext::new();
    ctx.register_catalog(
        "seed",
        Arc::new(IcebergCatalogProvider::try_new(catalog).await.unwrap()),
    );
    for values in [
        "(1, 'eu', 10.0), (2, 'us', 20.0), (3, 'eu', NULL)",
        "(4, 'eu', 50.0), (5, 'us', 130.0), (6, 'us', NULL)",
    ] {
        ctx.sql(&format!("INSERT INTO seed.sales.orders VALUES {values}"))
            .await
            .unwrap()
            .collect()
            .await
            .unwrap();
    }
}

async fn call(
    router: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(match body {
            Some(body) => Body::from(body.to_string()),
            None => Body::empty(),
        })
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)))
    };
    (status, value)
}
