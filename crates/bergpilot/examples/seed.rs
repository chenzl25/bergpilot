//! Fill the local development catalog (`dev/docker-compose.yml`) with sample
//! tables. Safe to re-run: existing tables get more snapshots.
//!
//!     cargo run --example seed
//!
//! Creates `demo.events` (partitioned by category, several small appends),
//! `demo.users`, and `demo.archive.orders` in a nested namespace.

use std::collections::HashMap;
use std::sync::Arc;

use iceberg::spec::{NestedField, PrimitiveType, Schema, Transform, Type, UnboundPartitionSpec};
use iceberg::{Catalog, CatalogBuilder, NamespaceIdent, TableCreation, TableIdent};
use iceberg_catalog_rest::RestCatalogBuilder;
use iceberg_datafusion::IcebergCatalogProvider;
use iceberg_storage_opendal::OpenDalResolvingStorageFactory;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let props = HashMap::from([
        ("uri".to_owned(), "http://localhost:8181".to_owned()),
        ("s3.endpoint".to_owned(), "http://localhost:9000".to_owned()),
        ("s3.access-key-id".to_owned(), "admin".to_owned()),
        ("s3.secret-access-key".to_owned(), "password".to_owned()),
        ("s3.region".to_owned(), "us-east-1".to_owned()),
        ("s3.path-style-access".to_owned(), "true".to_owned()),
    ]);
    let catalog: Arc<dyn Catalog> = Arc::new(
        RestCatalogBuilder::default()
            .with_storage_factory(Arc::new(OpenDalResolvingStorageFactory::new()))
            .load("dev", props)
            .await?,
    );

    let demo = NamespaceIdent::new("demo".to_owned());
    let archive = NamespaceIdent::from_strs(["demo", "archive"])?;
    for namespace in [&demo, &archive] {
        if !catalog.namespace_exists(namespace).await? {
            catalog.create_namespace(namespace, HashMap::new()).await?;
        }
    }

    let events = Schema::builder()
        .with_fields(vec![
            NestedField::required(1, "id", Type::Primitive(PrimitiveType::Long)).into(),
            NestedField::required(2, "category", Type::Primitive(PrimitiveType::String)).into(),
            NestedField::optional(3, "value", Type::Primitive(PrimitiveType::Double)).into(),
            NestedField::optional(4, "note", Type::Primitive(PrimitiveType::String)).into(),
        ])
        .build()?;
    // The Java REST catalog requires an explicit spec id.
    let by_category = UnboundPartitionSpec::builder()
        .with_spec_id(0)
        .add_partition_field(2, "category", Transform::Identity)?
        .build();
    create_if_missing(&*catalog, &demo, "events", events, Some(by_category)).await?;

    let users = Schema::builder()
        .with_fields(vec![
            NestedField::required(1, "id", Type::Primitive(PrimitiveType::Int)).into(),
            NestedField::required(2, "name", Type::Primitive(PrimitiveType::String)).into(),
            NestedField::optional(3, "country", Type::Primitive(PrimitiveType::String)).into(),
        ])
        .build()?;
    create_if_missing(&*catalog, &demo, "users", users, None).await?;

    let orders = Schema::builder()
        .with_fields(vec![
            NestedField::required(1, "order_id", Type::Primitive(PrimitiveType::Long)).into(),
            NestedField::required(2, "user_id", Type::Primitive(PrimitiveType::Int)).into(),
            NestedField::optional(3, "amount", Type::Primitive(PrimitiveType::Double)).into(),
        ])
        .build()?;
    create_if_missing(&*catalog, &archive, "orders", orders, None).await?;

    let ctx = datafusion::prelude::SessionContext::new();
    ctx.register_catalog(
        "dev",
        Arc::new(IcebergCatalogProvider::try_new(catalog.clone()).await?),
    );

    // Several small appends make several snapshots and many small files,
    // which is what the file-size view is for.
    for batch in 0..5 {
        let first = batch * 2_000 + 1;
        let rows: Vec<String> = (first..first + 2_000).map(event_row).collect();
        run(
            &ctx,
            &format!("INSERT INTO dev.demo.events VALUES {}", rows.join(", ")),
        )
        .await?;
    }
    run(
        &ctx,
        "INSERT INTO dev.demo.users VALUES \
         (1, 'Ada', 'UK'), (2, 'Grace', 'US'), (3, 'Linus', 'FI'), (4, 'Yukihiro', NULL)",
    )
    .await?;

    println!("Seeded demo.events, demo.users and demo.archive.orders (empty).");
    println!("Query them in BergPilot as dev.demo.events or dev.\"demo.archive\".orders.");
    Ok(())
}

/// One `demo.events` row as a SQL tuple. Rows go in as VALUES because the
/// fork panics on a partitioned `INSERT ... SELECT` (record_batch_projector.rs).
fn event_row(n: i64) -> String {
    let category = ["click", "view", "purchase", "signup"][(n % 4) as usize];
    let value = if n % 13 == 0 {
        "NULL".to_owned()
    } else {
        format!("{:.1}", (n % 997) as f64 / 10.0)
    };
    let note = if n % 10 == 0 {
        "NULL".to_owned()
    } else {
        format!("'event {n}'")
    };
    format!("({n}, '{category}', {value}, {note})")
}

async fn create_if_missing(
    catalog: &dyn Catalog,
    namespace: &NamespaceIdent,
    name: &str,
    schema: Schema,
    partition_spec: Option<UnboundPartitionSpec>,
) -> anyhow::Result<()> {
    if catalog
        .table_exists(&TableIdent::new(namespace.clone(), name.to_owned()))
        .await?
    {
        return Ok(());
    }
    let creation = TableCreation::builder()
        .name(name.to_owned())
        .schema(schema)
        .partition_spec_opt(partition_spec)
        .build();
    catalog.create_table(namespace, creation).await?;
    Ok(())
}

async fn run(ctx: &datafusion::prelude::SessionContext, sql: &str) -> anyhow::Result<()> {
    ctx.sql(sql).await?.collect().await?;
    Ok(())
}
