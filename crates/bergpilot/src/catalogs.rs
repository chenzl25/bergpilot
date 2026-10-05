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

/// Build a catalog client for `record`. Nothing is cached.
pub async fn connect(record: &CatalogRecord) -> ApiResult<Arc<dyn Catalog>> {
    let props: HashMap<String, String> = record.connection_properties().into_iter().collect();
    let storage = Arc::new(OpenDalResolvingStorageFactory::new());
    match record.kind {
        CatalogKind::Rest => {
            let catalog = RestCatalogBuilder::default()
                .with_storage_factory(storage)
                .load(record.name.clone(), props)
                .await
                .map_err(|error| {
                    ApiError::Upstream(format!(
                        "failed to connect to catalog {}: {error}",
                        record.name
                    ))
                })?;
            Ok(Arc::new(catalog))
        }
    }
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
