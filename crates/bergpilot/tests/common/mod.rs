//! Helpers shared by the integration tests: a SQLite-backed SQL catalog with
//! a local-filesystem warehouse, and an in-process HTTP client.

#![allow(dead_code)]

pub mod racing;
pub mod upsert;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use iceberg::io::StorageFactory;
use iceberg::spec::{NestedField, PrimitiveType, Schema, Transform, Type, UnboundPartitionSpec};
use iceberg::{Catalog, CatalogBuilder, NamespaceIdent, TableCreation};
use iceberg_catalog_sql::SqlCatalogBuilder;
use iceberg_datafusion::IcebergCatalogProvider;
use iceberg_storage_opendal::OpenDalResolvingStorageFactory;
use serde_json::{Value, json};
use tower::ServiceExt;

/// The name the "other engine" gave the catalog in the database.
pub const STORED_CATALOG_NAME: &str = "java_jdbc";

pub struct LocalCatalog {
    pub db_uri: String,
    pub warehouse: String,
    pub warehouse_dir: PathBuf,
    pub catalog: Arc<dyn Catalog>,
}

impl LocalCatalog {
    pub async fn new(dir: &Path) -> Self {
        let db_uri = format!("sqlite://{}?mode=rwc", dir.join("catalog.db").display());
        let warehouse_dir = dir.join("warehouse");
        let warehouse = format!("file://{}", warehouse_dir.display());
        let catalog = sql_client(
            &db_uri,
            &warehouse,
            Arc::new(OpenDalResolvingStorageFactory::new()),
        )
        .await;
        Self {
            db_uri,
            warehouse,
            warehouse_dir,
            catalog,
        }
    }

    /// Another client of the same catalog, reading and writing files
    /// through `storage`.
    pub async fn client(&self, storage: Arc<dyn StorageFactory>) -> Arc<dyn Catalog> {
        sql_client(&self.db_uri, &self.warehouse, storage).await
    }

    /// The JSON body that registers this catalog in BergPilot as `name`.
    pub fn registration(&self, name: &str) -> Value {
        json!({
            "name": name,
            "kind": "sql",
            "properties": {
                "uri": self.db_uri,
                "warehouse": self.warehouse,
                "catalog_name": STORED_CATALOG_NAME,
            },
        })
    }

    /// Create `sales.orders(id, region, amount)` partitioned by region.
    pub async fn create_orders(&self) {
        let namespace = NamespaceIdent::new("sales".to_owned());
        self.catalog
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
        self.catalog
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
    }

    /// Append rows, one commit per element of `batches`.
    pub async fn append_orders(&self, batches: &[&str]) {
        let ctx = datafusion::prelude::SessionContext::new();
        ctx.register_catalog(
            "seed",
            Arc::new(
                IcebergCatalogProvider::try_new(self.catalog.clone())
                    .await
                    .unwrap(),
            ),
        );
        for values in batches {
            ctx.sql(&format!("INSERT INTO seed.sales.orders VALUES {values}"))
                .await
                .unwrap()
                .collect()
                .await
                .unwrap();
        }
    }

    /// Parquet files under the orders table's data directory.
    pub fn data_files_on_disk(&self) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut stack = vec![self.warehouse_dir.join("sales").join("orders").join("data")];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|ext| ext == "parquet") {
                    found.push(path);
                }
            }
        }
        found
    }
}

async fn sql_client(
    db_uri: &str,
    warehouse: &str,
    storage: Arc<dyn StorageFactory>,
) -> Arc<dyn Catalog> {
    Arc::new(
        SqlCatalogBuilder::default()
            .with_storage_factory(storage)
            .load(
                STORED_CATALOG_NAME,
                HashMap::from([
                    ("uri".to_owned(), db_uri.to_owned()),
                    ("warehouse".to_owned(), warehouse.to_owned()),
                ]),
            )
            .await
            .unwrap(),
    )
}

pub async fn call(
    router: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "localhost")
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

/// Submit a job and wait for it to finish successfully.
pub async fn run_job(router: &Router, body: Value) -> Value {
    let (status, job) = call(router, "POST", "/api/jobs", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{job}");
    let id = job["id"].as_i64().unwrap();
    for _ in 0..600 {
        let (_, job) = call(router, "GET", &format!("/api/jobs/{id}"), None).await;
        match job["status"].as_str().unwrap() {
            "succeeded" => return job,
            "failed" | "cancelled" => panic!("job did not succeed: {job}"),
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    panic!("job {id} did not finish in time");
}
