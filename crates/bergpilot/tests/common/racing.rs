//! A catalog that lets another writer commit at the worst moment: right
//! before the first commit made through it reaches the real catalog. The
//! commit made through it then conflicts and has to be retried on top of
//! the other writer's snapshot.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use futures::future::BoxFuture;
use iceberg::table::Table;
use iceberg::{Catalog, Namespace, NamespaceIdent, Result, TableCommit, TableCreation, TableIdent};
use tokio::sync::Mutex;

pub struct RacingCatalog {
    inner: Arc<dyn Catalog>,
    race: Mutex<Option<BoxFuture<'static, ()>>>,
}

impl RacingCatalog {
    pub fn new(inner: Arc<dyn Catalog>, race: BoxFuture<'static, ()>) -> Arc<Self> {
        Arc::new(Self {
            inner,
            race: Mutex::new(Some(race)),
        })
    }

    /// Whether the other writer has committed.
    pub async fn raced(&self) -> bool {
        self.race.lock().await.is_none()
    }
}

impl fmt::Debug for RacingCatalog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RacingCatalog").finish_non_exhaustive()
    }
}

#[async_trait]
impl Catalog for RacingCatalog {
    async fn list_namespaces(
        &self,
        parent: Option<&NamespaceIdent>,
    ) -> Result<Vec<NamespaceIdent>> {
        self.inner.list_namespaces(parent).await
    }

    async fn create_namespace(
        &self,
        namespace: &NamespaceIdent,
        properties: HashMap<String, String>,
    ) -> Result<Namespace> {
        self.inner.create_namespace(namespace, properties).await
    }

    async fn get_namespace(&self, namespace: &NamespaceIdent) -> Result<Namespace> {
        self.inner.get_namespace(namespace).await
    }

    async fn namespace_exists(&self, namespace: &NamespaceIdent) -> Result<bool> {
        self.inner.namespace_exists(namespace).await
    }

    async fn update_namespace(
        &self,
        namespace: &NamespaceIdent,
        properties: HashMap<String, String>,
    ) -> Result<()> {
        self.inner.update_namespace(namespace, properties).await
    }

    async fn drop_namespace(&self, namespace: &NamespaceIdent) -> Result<()> {
        self.inner.drop_namespace(namespace).await
    }

    async fn list_tables(&self, namespace: &NamespaceIdent) -> Result<Vec<TableIdent>> {
        self.inner.list_tables(namespace).await
    }

    async fn create_table(
        &self,
        namespace: &NamespaceIdent,
        creation: TableCreation,
    ) -> Result<Table> {
        self.inner.create_table(namespace, creation).await
    }

    async fn load_table(&self, table: &TableIdent) -> Result<Table> {
        self.inner.load_table(table).await
    }

    async fn drop_table(&self, table: &TableIdent) -> Result<()> {
        self.inner.drop_table(table).await
    }

    async fn purge_table(&self, table: &TableIdent) -> Result<()> {
        self.inner.purge_table(table).await
    }

    async fn table_exists(&self, table: &TableIdent) -> Result<bool> {
        self.inner.table_exists(table).await
    }

    async fn rename_table(&self, src: &TableIdent, dest: &TableIdent) -> Result<()> {
        self.inner.rename_table(src, dest).await
    }

    async fn register_table(&self, table: &TableIdent, metadata_location: String) -> Result<Table> {
        self.inner.register_table(table, metadata_location).await
    }

    async fn update_table(&self, commit: TableCommit) -> Result<Table> {
        let race = self.race.lock().await.take();
        if let Some(race) = race {
            race.await;
        }
        self.inner.update_table(commit).await
    }
}
