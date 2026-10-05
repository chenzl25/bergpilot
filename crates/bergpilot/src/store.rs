//! BergPilot's own state, kept in a SQLite database in the data directory.

use std::collections::BTreeMap;
use std::path::Path;
use std::str::FromStr;

use anyhow::Context;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use crate::error::{ApiError, ApiResult};
use crate::secrets::{SecretBox, is_secret_key};
use crate::types::{CatalogInput, CatalogKind, CatalogSummary};

/// A stored catalog with its secrets decrypted.
#[derive(Clone, Debug)]
pub struct CatalogRecord {
    pub id: i64,
    pub name: String,
    pub kind: CatalogKind,
    pub properties: BTreeMap<String, String>,
    pub secrets: BTreeMap<String, String>,
    pub created_at: String,
    pub updated_at: String,
}

impl CatalogRecord {
    pub fn summary(&self) -> CatalogSummary {
        CatalogSummary {
            id: self.id,
            name: self.name.clone(),
            kind: self.kind,
            properties: self.properties.clone(),
            secret_keys: self.secrets.keys().cloned().collect(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }

    /// Properties and secrets merged, as the catalog client expects them.
    pub fn connection_properties(&self) -> BTreeMap<String, String> {
        let mut all = self.properties.clone();
        all.extend(self.secrets.clone());
        all
    }
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
    secrets: SecretBox,
}

impl Store {
    pub async fn open(data_dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(data_dir)
            .with_context(|| format!("failed to create {}", data_dir.display()))?;
        let secrets = SecretBox::load_or_create(&data_dir.join("secret.key"))?;
        let url = format!("sqlite://{}", data_dir.join("bergpilot.db").display());
        let options = SqliteConnectOptions::from_str(&url)?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .context("failed to open bergpilot.db")?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .context("failed to migrate bergpilot.db")?;
        Ok(Self { pool, secrets })
    }

    pub async fn list_catalogs(&self) -> ApiResult<Vec<CatalogRecord>> {
        let rows = sqlx::query(
            "select id, name, kind, properties, secrets, created_at, updated_at \
             from catalogs order by name",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(|row| self.decode(row)).collect()
    }

    pub async fn get_catalog(&self, id: i64) -> ApiResult<CatalogRecord> {
        let row = sqlx::query(
            "select id, name, kind, properties, secrets, created_at, updated_at \
             from catalogs where id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("catalog {id} does not exist")))?;
        self.decode(&row)
    }

    pub async fn find_catalog_by_name(&self, name: &str) -> ApiResult<Option<CatalogRecord>> {
        let row = sqlx::query(
            "select id, name, kind, properties, secrets, created_at, updated_at \
             from catalogs where name = ?",
        )
        .bind(name)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| self.decode(&row)).transpose()
    }

    pub async fn create_catalog(&self, input: &CatalogInput) -> ApiResult<CatalogRecord> {
        let (properties, secrets) = split_input(input, BTreeMap::new())?;
        let result = sqlx::query(
            "insert into catalogs (name, kind, properties, secrets) values (?, ?, ?, ?)",
        )
        .bind(&input.name)
        .bind(input.kind.as_str())
        .bind(serde_json::to_string(&properties).map_err(anyhow::Error::from)?)
        .bind(self.encrypt(&secrets)?)
        .execute(&self.pool)
        .await
        .map_err(|error| unique_name_error(error, &input.name))?;
        self.get_catalog(result.last_insert_rowid()).await
    }

    pub async fn update_catalog(&self, id: i64, input: &CatalogInput) -> ApiResult<CatalogRecord> {
        let existing = self.get_catalog(id).await?;
        let (properties, secrets) = split_input(input, existing.secrets)?;
        sqlx::query(
            "update catalogs set name = ?, kind = ?, properties = ?, secrets = ?, \
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = ?",
        )
        .bind(&input.name)
        .bind(input.kind.as_str())
        .bind(serde_json::to_string(&properties).map_err(anyhow::Error::from)?)
        .bind(self.encrypt(&secrets)?)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|error| unique_name_error(error, &input.name))?;
        self.get_catalog(id).await
    }

    pub async fn delete_catalog(&self, id: i64) -> ApiResult<()> {
        let result = sqlx::query("delete from catalogs where id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::NotFound(format!("catalog {id} does not exist")));
        }
        Ok(())
    }

    /// The record a connection test would use, without saving anything.
    pub async fn preview_catalog(
        &self,
        id: Option<i64>,
        input: &CatalogInput,
    ) -> ApiResult<CatalogRecord> {
        let stored_secrets = match id {
            Some(id) => self.get_catalog(id).await?.secrets,
            None => BTreeMap::new(),
        };
        let (properties, secrets) = split_input(input, stored_secrets)?;
        Ok(CatalogRecord {
            id: id.unwrap_or(0),
            name: input.name.clone(),
            kind: input.kind,
            properties,
            secrets,
            created_at: String::new(),
            updated_at: String::new(),
        })
    }

    fn encrypt(&self, secrets: &BTreeMap<String, String>) -> ApiResult<Option<String>> {
        if secrets.is_empty() {
            return Ok(None);
        }
        Ok(Some(self.secrets.encrypt(secrets)?))
    }

    fn decode(&self, row: &sqlx::sqlite::SqliteRow) -> ApiResult<CatalogRecord> {
        let kind: String = row.try_get("kind")?;
        let properties: String = row.try_get("properties")?;
        let secrets: Option<String> = row.try_get("secrets")?;
        Ok(CatalogRecord {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            kind: CatalogKind::parse(&kind)
                .ok_or_else(|| ApiError::Internal(format!("unknown catalog kind {kind:?}")))?,
            properties: serde_json::from_str(&properties).map_err(anyhow::Error::from)?,
            secrets: match secrets {
                Some(encoded) => self.secrets.decrypt(&encoded)?,
                None => BTreeMap::new(),
            },
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
        })
    }
}

/// Validate `input` and split it into plain properties and secrets, starting
/// from `secrets` (the stored ones when updating).
fn split_input(
    input: &CatalogInput,
    mut secrets: BTreeMap<String, String>,
) -> ApiResult<(BTreeMap<String, String>, BTreeMap<String, String>)> {
    validate_catalog_name(&input.name)?;
    let mut properties = BTreeMap::new();
    for (key, value) in &input.properties {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        // A secret typed into the properties table is still a secret.
        if is_secret_key(key) {
            secrets.insert(key.to_owned(), value.clone());
        } else {
            properties.insert(key.to_owned(), value.trim().to_owned());
        }
    }
    for key in input.clear_secrets.iter().flatten() {
        secrets.remove(key);
    }
    for (key, value) in &input.secrets {
        let key = key.trim();
        if !key.is_empty() {
            secrets.insert(key.to_owned(), value.clone());
        }
    }
    for key in secrets.keys() {
        properties.remove(key);
    }
    let required = |key: &str, what: &str| {
        if properties.get(key).is_none_or(|value| value.is_empty()) {
            Err(ApiError::BadRequest(format!(
                "a {} catalog needs {what} (property \"{key}\")",
                input.kind.as_str()
            )))
        } else {
            Ok(())
        }
    };
    match input.kind {
        CatalogKind::Rest => required("uri", "the catalog URI")?,
        CatalogKind::Glue => required("warehouse", "a warehouse location")?,
        CatalogKind::S3tables => required("table_bucket_arn", "the table bucket ARN")?,
        CatalogKind::Sql => {
            required("uri", "the database URL")?;
            let uri = &properties["uri"];
            let scheme_ok = ["postgres://", "postgresql://", "mysql://", "sqlite:"]
                .iter()
                .any(|prefix| uri.starts_with(prefix));
            if !scheme_ok {
                return Err(ApiError::BadRequest(
                    "the database URL must start with postgres://, mysql:// or sqlite:".to_owned(),
                ));
            }
            if url::Url::parse(uri).is_ok_and(|url| url.password().is_some()) {
                return Err(ApiError::BadRequest(
                    "put the database password in the password field, not in the URL".to_owned(),
                ));
            }
        }
    }
    Ok((properties, secrets))
}

/// Catalog names double as SQL catalog names, so keep them unquoted-safe.
pub fn validate_catalog_name(name: &str) -> ApiResult<()> {
    let mut chars = name.chars();
    let valid = matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c == '_')
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && name.len() <= 64;
    if valid {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!(
            "catalog name {name:?} must start with a lowercase letter or underscore and \
             contain only lowercase letters, digits and underscores (at most 64)"
        )))
    }
}

fn unique_name_error(error: sqlx::Error, name: &str) -> ApiError {
    match &error {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            ApiError::BadRequest(format!("a catalog named {name:?} already exists"))
        }
        _ => error.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rest_input(name: &str) -> CatalogInput {
        CatalogInput {
            name: name.to_owned(),
            kind: CatalogKind::Rest,
            properties: BTreeMap::from([
                ("uri".to_owned(), "http://localhost:8181".to_owned()),
                (
                    "s3.secret-access-key".to_owned(),
                    "typed-as-property".to_owned(),
                ),
            ]),
            secrets: BTreeMap::from([("credential".to_owned(), "id:secret".to_owned())]),
            clear_secrets: None,
        }
    }

    #[tokio::test]
    async fn stores_secrets_encrypted_and_keeps_them_on_update() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();

        let created = store.create_catalog(&rest_input("dev")).await.unwrap();
        assert_eq!(
            created.summary().secret_keys,
            vec!["credential", "s3.secret-access-key"]
        );
        assert!(!created.properties.contains_key("s3.secret-access-key"));

        let raw: String = sqlx::query_scalar("select secrets from catalogs")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert!(!raw.contains("id:secret"));

        let mut update = rest_input("dev2");
        update.properties.remove("s3.secret-access-key");
        update.secrets.clear();
        update.clear_secrets = Some(vec!["credential".to_owned()]);
        let updated = store.update_catalog(created.id, &update).await.unwrap();
        assert_eq!(updated.name, "dev2");
        assert_eq!(
            updated.secrets,
            BTreeMap::from([(
                "s3.secret-access-key".to_owned(),
                "typed-as-property".to_owned()
            )])
        );
    }

    #[tokio::test]
    async fn rejects_duplicate_and_invalid_names() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        store.create_catalog(&rest_input("dev")).await.unwrap();
        assert!(matches!(
            store.create_catalog(&rest_input("dev")).await,
            Err(ApiError::BadRequest(_))
        ));
        for bad in ["Dev", "1dev", "dev-1", ""] {
            assert!(validate_catalog_name(bad).is_err(), "{bad:?}");
        }
    }
}
