//! Storage that counts the bytes it reads and writes, so a long job can
//! report how far it has got. It wraps whatever storage the catalog would
//! use and is installed only on catalog clients built for one job.

use std::collections::HashMap;
use std::ops::Range;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use bytes::Bytes;
use futures::stream::BoxStream;
use iceberg::Result;
use iceberg::io::{
    FileMetadata, FileRead, FileWrite, InputFile, ListEntry, OutputFile, Storage, StorageConfig,
    StorageCredentialProvider, StorageFactory,
};
use serde::{Deserialize, Serialize};

/// Bytes read per path and bytes written in total.
#[derive(Debug, Default)]
pub struct IoCounter {
    read: Mutex<HashMap<String, u64>>,
    written: AtomicU64,
}

impl IoCounter {
    pub fn bytes_read(&self, path: &str) -> u64 {
        self.lock().get(path).copied().unwrap_or(0)
    }

    pub fn bytes_written(&self) -> u64 {
        self.written.load(Ordering::Relaxed)
    }

    fn record_read(&self, path: &str, bytes: usize) {
        *self.lock().entry(path.to_owned()).or_default() += bytes as u64;
    }

    fn record_write(&self, bytes: usize) {
        self.written.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, u64>> {
        // Counters stay meaningful even if a reader panicked mid-update.
        self.read
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

/// A [`StorageFactory`] whose storages report to `counter`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CountingStorageFactory {
    inner: Arc<dyn StorageFactory>,
    #[serde(skip)]
    counter: Arc<IoCounter>,
}

impl CountingStorageFactory {
    pub fn new(inner: Arc<dyn StorageFactory>, counter: Arc<IoCounter>) -> Self {
        Self { inner, counter }
    }
}

#[typetag::serde(name = "BergPilotCountingStorageFactory")]
impl StorageFactory for CountingStorageFactory {
    fn build(&self, config: &StorageConfig) -> Result<Arc<dyn Storage>> {
        Ok(CountingStorage::wrap(
            self.inner.build(config)?,
            self.counter.clone(),
        ))
    }

    fn build_with_credentials(
        &self,
        config: &StorageConfig,
        credential_provider: Arc<dyn StorageCredentialProvider>,
    ) -> Result<Arc<dyn Storage>> {
        Ok(CountingStorage::wrap(
            self.inner
                .build_with_credentials(config, credential_provider)?,
            self.counter.clone(),
        ))
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct CountingStorage {
    inner: Arc<dyn Storage>,
    #[serde(skip)]
    counter: Arc<IoCounter>,
    /// Lets `new_input` and `new_output` hand out files that read and write
    /// through this storage. Empty after deserialization, when files go
    /// straight to `inner`.
    #[serde(skip)]
    this: Weak<CountingStorage>,
}

impl CountingStorage {
    fn wrap(inner: Arc<dyn Storage>, counter: Arc<IoCounter>) -> Arc<dyn Storage> {
        Arc::new_cyclic(|this| Self {
            inner,
            counter,
            this: this.clone(),
        })
    }
}

#[async_trait]
#[typetag::serde(name = "BergPilotCountingStorage")]
impl Storage for CountingStorage {
    async fn exists(&self, path: &str) -> Result<bool> {
        self.inner.exists(path).await
    }

    async fn metadata(&self, path: &str) -> Result<FileMetadata> {
        self.inner.metadata(path).await
    }

    async fn read(&self, path: &str) -> Result<Bytes> {
        let bytes = self.inner.read(path).await?;
        self.counter.record_read(path, bytes.len());
        Ok(bytes)
    }

    async fn reader(&self, path: &str) -> Result<Box<dyn FileRead>> {
        Ok(Box::new(CountingRead {
            inner: self.inner.reader(path).await?,
            path: path.to_owned(),
            counter: self.counter.clone(),
        }))
    }

    async fn write(&self, path: &str, bs: Bytes) -> Result<()> {
        let len = bs.len();
        self.inner.write(path, bs).await?;
        self.counter.record_write(len);
        Ok(())
    }

    async fn writer(&self, path: &str) -> Result<Box<dyn FileWrite>> {
        Ok(Box::new(CountingWrite {
            inner: self.inner.writer(path).await?,
            counter: self.counter.clone(),
        }))
    }

    async fn delete(&self, path: &str) -> Result<()> {
        self.inner.delete(path).await
    }

    async fn delete_prefix(&self, path: &str) -> Result<()> {
        self.inner.delete_prefix(path).await
    }

    async fn delete_stream(&self, paths: BoxStream<'static, String>) -> Result<()> {
        self.inner.delete_stream(paths).await
    }

    async fn list(
        &self,
        path: &str,
        recursive: bool,
    ) -> Result<BoxStream<'static, Result<ListEntry>>> {
        self.inner.list(path, recursive).await
    }

    fn new_input(&self, path: &str) -> Result<InputFile> {
        match self.this.upgrade() {
            Some(this) => Ok(InputFile::new(this, path.to_owned())),
            None => self.inner.new_input(path),
        }
    }

    fn new_output(&self, path: &str) -> Result<OutputFile> {
        match self.this.upgrade() {
            Some(this) => Ok(OutputFile::new(this, path.to_owned())),
            None => self.inner.new_output(path),
        }
    }
}

struct CountingRead {
    inner: Box<dyn FileRead>,
    path: String,
    counter: Arc<IoCounter>,
}

#[async_trait]
impl FileRead for CountingRead {
    async fn read(&self, range: Range<u64>) -> Result<Bytes> {
        let bytes = self.inner.read(range).await?;
        self.counter.record_read(&self.path, bytes.len());
        Ok(bytes)
    }
}

struct CountingWrite {
    inner: Box<dyn FileWrite>,
    counter: Arc<IoCounter>,
}

#[async_trait]
impl FileWrite for CountingWrite {
    async fn write(&mut self, bs: Bytes) -> Result<()> {
        let len = bs.len();
        self.inner.write(bs).await?;
        self.counter.record_write(len);
        Ok(())
    }

    async fn close(&mut self) -> Result<()> {
        self.inner.close().await
    }
}

#[cfg(test)]
mod tests {
    use iceberg::io::FileIOBuilder;
    use iceberg::io::LocalFsStorageFactory;

    use super::*;

    #[tokio::test]
    async fn counts_reads_and_writes_through_file_io() {
        let dir = tempfile::tempdir().unwrap();
        let counter = Arc::new(IoCounter::default());
        let factory = Arc::new(CountingStorageFactory::new(
            Arc::new(LocalFsStorageFactory),
            counter.clone(),
        ));
        let file_io = FileIOBuilder::new(factory).build();
        let path = format!("file://{}/a.bin", dir.path().display());

        let mut writer = file_io.new_output(&path).unwrap().writer().await.unwrap();
        writer
            .write(Bytes::from_static(b"hello world"))
            .await
            .unwrap();
        writer.close().await.unwrap();
        assert_eq!(counter.bytes_written(), 11);

        let reader = file_io.new_input(&path).unwrap().reader().await.unwrap();
        assert_eq!(&reader.read(0..5).await.unwrap()[..], b"hello");
        assert_eq!(&reader.read(6..11).await.unwrap()[..], b"world");
        assert_eq!(counter.bytes_read(&path), 10);
        assert_eq!(counter.bytes_read("file:///elsewhere"), 0);
    }
}
