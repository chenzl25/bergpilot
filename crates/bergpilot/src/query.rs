//! Read-only SQL over configured catalogs with DataFusion.
//!
//! Tables are named `catalog.namespace.table`. A nested namespace is one
//! quoted, dot-separated identifier: `dev."a.b".events`. Only the tables a
//! query mentions are loaded, each pinned to its current snapshot.
//! Metadata tables are `"table$kind"`, e.g. `dev.demo."events$files"` (see
//! `metadata_tables`); `"table@snapshot"` reads the table as of a snapshot
//! id, branch or tag.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use datafusion::arrow::array::RecordBatch;
use datafusion::arrow::util::display::{ArrayFormatter, FormatOptions};
use datafusion::catalog::{CatalogProvider, MemoryCatalogProvider, MemorySchemaProvider};
use datafusion::execution::context::SQLOptions;
use datafusion::execution::runtime_env::RuntimeEnvBuilder;
use datafusion::prelude::{SessionConfig, SessionContext};
use datafusion::sql::TableReference;
use futures::StreamExt;
use iceberg::{NamespaceIdent, TableIdent};
use iceberg_datafusion::IcebergStaticTableProvider;

use crate::catalogs::CatalogRegistry;
use crate::error::{ApiError, ApiResult};
use crate::types::{QueryColumn, QueryRequest, QueryResult};

pub const DEFAULT_ROW_LIMIT: u32 = 1_000;
pub const MAX_ROW_LIMIT: u32 = 10_000;

#[derive(Clone, Debug)]
pub struct QueryLimits {
    pub timeout: Duration,
    /// Memory DataFusion may use per query before it spills or fails.
    pub memory_bytes: usize,
}

impl Default for QueryLimits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(120),
            memory_bytes: 1024 * 1024 * 1024,
        }
    }
}

pub async fn run(
    registry: &CatalogRegistry,
    limits: &QueryLimits,
    request: QueryRequest,
) -> ApiResult<QueryResult> {
    let row_limit = request
        .limit
        .unwrap_or(DEFAULT_ROW_LIMIT)
        .clamp(1, MAX_ROW_LIMIT) as usize;
    let started = Instant::now();
    let result = tokio::time::timeout(limits.timeout, async {
        execute(registry, limits, &request.sql, row_limit).await
    })
    .await
    .map_err(|_| {
        ApiError::BadRequest(format!(
            "the query did not finish within {} seconds",
            limits.timeout.as_secs()
        ))
    })??;
    Ok(QueryResult {
        elapsed_ms: started.elapsed().as_millis() as u64,
        ..result
    })
}

async fn execute(
    registry: &CatalogRegistry,
    limits: &QueryLimits,
    sql: &str,
    row_limit: usize,
) -> ApiResult<QueryResult> {
    let ctx = session(limits)?;
    let state = ctx.state();
    let dialect = state.config().options().sql_parser.dialect;
    let statement = state
        .sql_to_statement(sql, &dialect)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    ensure_read_only(&statement)?;
    let references = state
        .resolve_table_references(&statement)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    register_tables(registry, &ctx, &references).await?;

    // Reject anything but queries before planning touches a table.
    let options = SQLOptions::new()
        .with_allow_ddl(false)
        .with_allow_dml(false)
        .with_allow_statements(false);
    let frame = ctx
        .sql_with_options(sql, options)
        .await
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;

    let schema = frame.schema().as_arrow().clone();
    let columns = schema
        .fields()
        .iter()
        .map(|field| QueryColumn {
            name: field.name().clone(),
            data_type: field.data_type().to_string(),
        })
        .collect();

    let mut stream = frame
        .execute_stream()
        .await
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let mut rows = Vec::new();
    let mut truncated = false;
    while let Some(batch) = stream.next().await {
        let batch = batch.map_err(|error| ApiError::Upstream(error.to_string()))?;
        if append_rows(&mut rows, &batch, row_limit)? {
            truncated = true;
            break;
        }
    }
    Ok(QueryResult {
        columns,
        rows,
        truncated,
        elapsed_ms: 0,
    })
}

/// Only queries and EXPLAIN; `SQLOptions` below enforces the same during
/// planning, this check just gives a clearer message first.
fn ensure_read_only(statement: &datafusion::sql::parser::Statement) -> ApiResult<()> {
    use datafusion::sql::parser::Statement as DfStatement;
    use datafusion::sql::sqlparser::ast::Statement;
    let allowed = match statement {
        DfStatement::Statement(inner) => {
            matches!(
                inner.as_ref(),
                Statement::Query(_) | Statement::Explain { .. }
            )
        }
        DfStatement::Explain(_) => true,
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(ApiError::BadRequest(
            "BergPilot only runs read-only queries (SELECT, WITH, VALUES or EXPLAIN)".to_owned(),
        ))
    }
}

fn session(limits: &QueryLimits) -> ApiResult<SessionContext> {
    let runtime = RuntimeEnvBuilder::new()
        .with_memory_limit(limits.memory_bytes, 1.0)
        .build_arc()
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    let config = SessionConfig::new()
        .with_information_schema(false)
        .with_default_catalog_and_schema("__bergpilot", "__default");
    Ok(SessionContext::new_with_config_rt(config, runtime))
}

/// Load every referenced table and register it under its own name.
async fn register_tables(
    registry: &CatalogRegistry,
    ctx: &SessionContext,
    references: &[TableReference],
) -> ApiResult<()> {
    let mut catalogs: HashMap<String, Arc<MemoryCatalogProvider>> = HashMap::new();
    for reference in references {
        let TableReference::Full {
            catalog,
            schema,
            table,
        } = reference
        else {
            return Err(ApiError::BadRequest(format!(
                "use a fully qualified name such as my_catalog.my_namespace.{} \
                 instead of {reference}",
                reference.table()
            )));
        };
        let connected = registry
            .get_by_name(catalog)
            .await?
            .ok_or_else(|| ApiError::BadRequest(format!("there is no catalog named {catalog}")))?;
        let namespace = NamespaceIdent::from_strs(schema.split('.'))?;
        let name = TableName::parse(table);
        let ident = TableIdent::new(namespace, name.base.to_owned());
        let loaded = connected.catalog.load_table(&ident).await?;
        let provider: Arc<dyn datafusion::catalog::TableProvider> = match (name.metadata, name.at) {
            (Some(kind), _) => Arc::new(crate::metadata_tables::build(&loaded, kind).await?),
            (None, Some(selector)) => {
                let snapshot_id = resolve_snapshot(&loaded, selector)?;
                Arc::new(
                    IcebergStaticTableProvider::try_new_from_table_snapshot(loaded, snapshot_id)
                        .await?,
                )
            }
            (None, None) => Arc::new(IcebergStaticTableProvider::try_new_from_table(loaded).await?),
        };

        let catalog_provider = catalogs
            .entry(catalog.to_string())
            .or_insert_with(|| {
                let provider = Arc::new(MemoryCatalogProvider::new());
                ctx.register_catalog(catalog.as_ref(), provider.clone());
                provider
            })
            .clone();
        let schema_provider = match catalog_provider.schema(schema) {
            Some(existing) => existing,
            None => {
                let created = Arc::new(MemorySchemaProvider::new());
                catalog_provider
                    .register_schema(schema, created.clone())
                    .map_err(|error| ApiError::Internal(error.to_string()))?;
                created
            }
        };
        if !schema_provider.table_exist(table) {
            schema_provider
                .register_table(table.to_string(), provider)
                .map_err(|error| ApiError::Internal(error.to_string()))?;
        }
    }
    Ok(())
}

/// A table name in SQL: `events`, `events$files` (a metadata table) or
/// `events@1234` / `events@main` (the table as of a snapshot, branch or tag).
#[derive(Debug, PartialEq, Eq)]
struct TableName<'a> {
    base: &'a str,
    metadata: Option<&'a str>,
    at: Option<&'a str>,
}

impl<'a> TableName<'a> {
    fn parse(name: &'a str) -> Self {
        if let Some((base, kind)) = name.split_once('$') {
            return TableName {
                base,
                metadata: Some(kind),
                at: None,
            };
        }
        if let Some((base, at)) = name.rsplit_once('@')
            && !base.is_empty()
            && !at.is_empty()
        {
            return TableName {
                base,
                metadata: None,
                at: Some(at),
            };
        }
        TableName {
            base: name,
            metadata: None,
            at: None,
        }
    }
}

/// A snapshot id, or the snapshot a branch or tag points at.
fn resolve_snapshot(table: &iceberg::table::Table, selector: &str) -> ApiResult<i64> {
    let metadata = table.metadata();
    if let Ok(id) = selector.parse::<i64>()
        && metadata.snapshot_by_id(id).is_some()
    {
        return Ok(id);
    }
    metadata
        .snapshot_for_ref(selector)
        .map(|snapshot| snapshot.snapshot_id())
        .ok_or_else(|| {
            ApiError::BadRequest(format!(
                "{selector:?} is neither a snapshot id nor a branch or tag of {}",
                table.identifier().name()
            ))
        })
}

/// Append up to `limit` rows in total; returns true once more rows exist.
fn append_rows(
    rows: &mut Vec<Vec<Option<String>>>,
    batch: &RecordBatch,
    limit: usize,
) -> ApiResult<bool> {
    let options = FormatOptions::default().with_null("");
    let formatters = batch
        .columns()
        .iter()
        .map(|column| ArrayFormatter::try_new(column.as_ref(), &options))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    for row in 0..batch.num_rows() {
        if rows.len() == limit {
            return Ok(true);
        }
        rows.push(
            batch
                .columns()
                .iter()
                .zip(&formatters)
                .map(|(column, formatter)| {
                    (!column.is_null(row)).then(|| formatter.value(row).to_string())
                })
                .collect(),
        );
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::TableName;

    #[test]
    fn parses_table_names() {
        let parse = TableName::parse;
        assert_eq!(
            parse("events"),
            TableName {
                base: "events",
                metadata: None,
                at: None
            }
        );
        assert_eq!(
            parse("events$files"),
            TableName {
                base: "events",
                metadata: Some("files"),
                at: None
            }
        );
        assert_eq!(
            parse("events@123"),
            TableName {
                base: "events",
                metadata: None,
                at: Some("123")
            }
        );
        assert_eq!(
            parse("events@main"),
            TableName {
                base: "events",
                metadata: None,
                at: Some("main")
            }
        );
        assert_eq!(
            parse("@x"),
            TableName {
                base: "@x",
                metadata: None,
                at: None
            }
        );
    }
}
