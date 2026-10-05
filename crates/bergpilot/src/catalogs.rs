//! Connecting to configured catalogs.

use std::collections::HashMap;
use std::sync::Arc;

use iceberg::{Catalog, CatalogBuilder};
use iceberg_catalog_rest::RestCatalogBuilder;
use iceberg_storage_opendal::OpenDalResolvingStorageFactory;
use tokio::sync::Mutex;

use crate::error::{ApiError, ApiResult};
use crate::store::{CatalogRecord, Store};
use crate::types::CatalogKind;

/// Catalog types this build can connect to.
pub fn compiled_kinds() -> Vec<CatalogKind> {
    CatalogKind::ALL
        .into_iter()
        .filter(|kind| match kind {
            CatalogKind::Rest => true,
            CatalogKind::Glue => cfg!(feature = "glue"),
            CatalogKind::S3tables => cfg!(feature = "s3tables"),
            CatalogKind::Sql => cfg!(feature = "sql"),
        })
        .collect()
}

/// Build a catalog client for `record`. Nothing is cached.
pub async fn connect(record: &CatalogRecord) -> ApiResult<Arc<dyn Catalog>> {
    let props: HashMap<String, String> = record.connection_properties().into_iter().collect();
    let storage = Arc::new(OpenDalResolvingStorageFactory::new());
    let name = record.name.clone();
    let failed = |error: iceberg::Error| {
        ApiError::Upstream(format!(
            "failed to connect to catalog {}: {error}",
            record.name
        ))
    };
    let catalog: Arc<dyn Catalog> = match record.kind {
        CatalogKind::Rest => Arc::new(
            RestCatalogBuilder::default()
                .with_storage_factory(storage)
                .load(name, props)
                .await
                .map_err(failed)?,
        ),
        #[cfg(feature = "glue")]
        CatalogKind::Glue => Arc::new(
            iceberg_catalog_glue::GlueCatalogBuilder::default()
                .with_storage_factory(storage)
                .load(name, props)
                .await
                .map_err(failed)?,
        ),
        #[cfg(feature = "s3tables")]
        CatalogKind::S3tables => Arc::new(
            iceberg_catalog_s3tables::S3TablesCatalogBuilder::default()
                .with_storage_factory(storage)
                .load(name, props)
                .await
                .map_err(failed)?,
        ),
        #[cfg(feature = "sql")]
        CatalogKind::Sql => {
            let (name, props) = sql_properties(&record.name, props)?;
            Arc::new(
                iceberg_catalog_sql::SqlCatalogBuilder::default()
                    .with_storage_factory(storage)
                    .load(name, props)
                    .await
                    .map_err(failed)?,
            )
        }
        #[allow(unreachable_patterns)]
        other => {
            return Err(ApiError::BadRequest(format!(
                "this build of BergPilot does not include {} catalogs",
                other.as_str()
            )));
        }
    };
    Ok(catalog)
}

/// Adapt BergPilot's SQL catalog settings to the iceberg-rust builder:
///
/// - `catalog_name` is the name stored in the database's `catalog_name`
///   column (what Java's `JdbcCatalog` was called); it defaults to the
///   BergPilot name.
/// - `password` is kept as a secret and spliced into the database URL.
/// - The parameter style follows the database unless `sql_bind_style` is set.
#[cfg(feature = "sql")]
fn sql_properties(
    bergpilot_name: &str,
    mut props: HashMap<String, String>,
) -> ApiResult<(String, HashMap<String, String>)> {
    let name = props
        .remove("catalog_name")
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| bergpilot_name.to_owned());
    let mut uri = props.get("uri").cloned().unwrap_or_default();
    if let Some(password) = props.remove("password") {
        let mut parsed = url::Url::parse(&uri)
            .map_err(|error| ApiError::BadRequest(format!("invalid database URL: {error}")))?;
        parsed.set_password(Some(&password)).map_err(|()| {
            ApiError::BadRequest("this database URL cannot carry a password".into())
        })?;
        uri = parsed.to_string();
        props.insert("uri".to_owned(), uri.clone());
    }
    if !props.contains_key("sql_bind_style") {
        let style = if uri.starts_with("mysql:") {
            "QMark"
        } else {
            "DollarNumeric"
        };
        props.insert("sql_bind_style".to_owned(), style.to_owned());
    }
    Ok((name, props))
}

/// Catalog clients, reused until the catalog's configuration changes.
#[derive(Clone)]
pub struct CatalogRegistry {
    store: Store,
    clients: Arc<Mutex<HashMap<i64, CachedClient>>>,
}

struct CachedClient {
    /// `updated_at` of the record the client was built from.
    version: String,
    catalog: Arc<dyn Catalog>,
}

/// A catalog client together with the record it belongs to.
#[derive(Clone)]
pub struct Connected {
    pub record: CatalogRecord,
    pub catalog: Arc<dyn Catalog>,
}

impl CatalogRegistry {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            clients: Arc::default(),
        }
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub async fn get(&self, id: i64) -> ApiResult<Connected> {
        let record = self.store.get_catalog(id).await?;
        self.client_for(record).await
    }

    pub async fn get_by_name(&self, name: &str) -> ApiResult<Option<Connected>> {
        match self.store.find_catalog_by_name(name).await? {
            Some(record) => Ok(Some(self.client_for(record).await?)),
            None => Ok(None),
        }
    }

    pub async fn forget(&self, id: i64) {
        self.clients.lock().await.remove(&id);
    }

    async fn client_for(&self, record: CatalogRecord) -> ApiResult<Connected> {
        {
            let clients = self.clients.lock().await;
            if let Some(cached) = clients.get(&record.id)
                && cached.version == record.updated_at
            {
                return Ok(Connected {
                    catalog: cached.catalog.clone(),
                    record,
                });
            }
        }
        // Connect outside the lock: a slow catalog must not block the others.
        let catalog = connect(&record).await?;
        self.clients.lock().await.insert(
            record.id,
            CachedClient {
                version: record.updated_at.clone(),
                catalog: catalog.clone(),
            },
        );
        Ok(Connected { record, catalog })
    }
}
