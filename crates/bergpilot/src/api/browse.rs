use axum::Json;
use axum::extract::{Path, Query, State};
use iceberg::{NamespaceIdent, TableIdent};
use serde::Deserialize;

use super::split_namespace;
use crate::error::{ApiError, ApiResult};
use crate::files::{current_totals, manifest_list_counts, summary_matches, summary_number};
use crate::metadata::table_detail;
use crate::server::AppState;
use crate::types::{
    CatalogNames, FileStats, NamespaceDetail, NamespaceList, NamespaceNames, TableDetail,
    TableList, TableSummary,
};

/// Tables summarized per namespace page.
const SUMMARY_LIMIT: usize = 500;
const SUMMARY_CONCURRENCY: usize = 8;

#[derive(Deserialize)]
pub struct NamespaceQuery {
    /// Parent namespace; omit for top-level namespaces.
    #[serde(default)]
    parent: Option<String>,
}

pub async fn namespaces(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<NamespaceQuery>,
) -> ApiResult<Json<NamespaceList>> {
    let connected = state.registry.get(id).await?;
    let parent = match query.parent.as_deref().map(split_namespace) {
        Some(levels) if !levels.is_empty() => Some(NamespaceIdent::from_vec(levels)?),
        _ => None,
    };
    let mut namespaces: Vec<Vec<String>> = connected
        .catalog
        .list_namespaces(parent.as_ref())
        .await?
        .into_iter()
        .map(NamespaceIdent::inner)
        .collect();
    namespaces.sort();
    Ok(Json(NamespaceList { namespaces }))
}

#[derive(Deserialize)]
pub struct TablesQuery {
    namespace: String,
}

pub async fn tables(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<TablesQuery>,
) -> ApiResult<Json<TableList>> {
    let connected = state.registry.get(id).await?;
    let namespace = namespace_ident(&query.namespace)?;
    let mut tables: Vec<String> = connected
        .catalog
        .list_tables(&namespace)
        .await?
        .into_iter()
        .map(|ident| ident.name().to_owned())
        .collect();
    tables.sort();
    Ok(Json(TableList { tables }))
}

#[derive(Deserialize)]
pub struct TableQuery {
    namespace: String,
    name: String,
    /// Snapshot for file stats; the current snapshot when omitted.
    #[serde(default)]
    snapshot_id: Option<String>,
}

pub async fn table(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<TableQuery>,
) -> ApiResult<Json<TableDetail>> {
    let connected = state.registry.get(id).await?;
    let ident = TableIdent::new(namespace_ident(&query.namespace)?, query.name);
    let table = connected.catalog.load_table(&ident).await?;
    let totals = current_totals(&table, &state.file_stats).await?;
    Ok(Json(table_detail(&connected.record.name, &table, totals)))
}

pub async fn files(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<TableQuery>,
) -> ApiResult<Json<FileStats>> {
    let connected = state.registry.get(id).await?;
    let ident = TableIdent::new(namespace_ident(&query.namespace)?, query.name);
    let snapshot_id = query
        .snapshot_id
        .as_deref()
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| ApiError::BadRequest(format!("invalid snapshot id {value:?}")))
        })
        .transpose()?;
    let table = connected.catalog.load_table(&ident).await?;
    Ok(Json(state.file_stats.stats(&table, snapshot_id).await?))
}

/// A namespace with its properties, children and a summary of each table.
pub async fn namespace_detail(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<TablesQuery>,
) -> ApiResult<Json<NamespaceDetail>> {
    use futures::StreamExt;

    let connected = state.registry.get(id).await?;
    let namespace = namespace_ident(&query.namespace)?;
    let catalog = connected.catalog.clone();
    let (properties, children, tables) = tokio::try_join!(
        async { catalog.get_namespace(&namespace).await },
        async { catalog.list_namespaces(Some(&namespace)).await },
        async { catalog.list_tables(&namespace).await },
    )?;
    let mut names: Vec<String> = tables.iter().map(|ident| ident.name().to_owned()).collect();
    names.sort();
    let truncated = names.len() > SUMMARY_LIMIT;
    names.truncate(SUMMARY_LIMIT);
    let mut summaries: Vec<TableSummary> = futures::stream::iter(names)
        .map(|name| {
            let catalog = catalog.clone();
            let ident = TableIdent::new(namespace.clone(), name.clone());
            async move {
                match catalog.load_table(&ident).await {
                    Ok(table) => summarize(name, &table).await,
                    Err(error) => TableSummary {
                        name,
                        format_version: None,
                        records: None,
                        data_files: None,
                        data_bytes: None,
                        delete_files: None,
                        snapshots: 0,
                        last_updated_ms: None,
                        error: Some(error.to_string()),
                    },
                }
            }
        })
        .buffer_unordered(SUMMARY_CONCURRENCY)
        .collect()
        .await;
    summaries.sort_by(|a, b| a.name.cmp(&b.name));
    let mut child_namespaces: Vec<Vec<String>> =
        children.into_iter().map(NamespaceIdent::inner).collect();
    child_namespaces.sort();
    Ok(Json(NamespaceDetail {
        namespace: namespace.inner(),
        properties: properties
            .properties()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        child_namespaces,
        tables: summaries,
        truncated,
    }))
}

/// A table's line on the namespace page. Counts come from the manifest
/// list; the size comes from the snapshot summary, and only when the
/// summary's counts agree with the manifest list (see
/// [`crate::files::current_totals`]).
async fn summarize(name: String, table: &iceberg::table::Table) -> TableSummary {
    let metadata = table.metadata();
    let mut summary = TableSummary {
        name,
        format_version: Some(metadata.format_version() as u8),
        records: None,
        data_files: None,
        data_bytes: None,
        delete_files: None,
        snapshots: metadata.snapshots().len() as u32,
        last_updated_ms: Some(metadata.last_updated_ms()),
        error: None,
    };
    let Some(snapshot) = metadata.current_snapshot() else {
        summary.records = Some(0);
        summary.data_files = Some(0);
        summary.data_bytes = Some(0);
        summary.delete_files = Some(0);
        return summary;
    };
    match manifest_list_counts(table, snapshot).await {
        Ok(Some(counts)) => {
            summary.records = Some(counts.records);
            summary.data_files = Some(counts.data_files);
            summary.delete_files = Some(counts.delete_files);
            if summary_matches(snapshot, &counts) {
                summary.data_bytes = summary_number(snapshot, "total-files-size");
            }
        }
        // Old manifests without counts: the summary is all there is.
        Ok(None) => {
            summary.records = summary_number(snapshot, "total-records");
            summary.data_files = summary_number(snapshot, "total-data-files");
            summary.data_bytes = summary_number(snapshot, "total-files-size");
            summary.delete_files = summary_number(snapshot, "total-delete-files");
        }
        Err(error) => summary.error = Some(error.to_string()),
    }
    summary
}

/// Namespaces walked for completion, and how deep.
const NAMES_LIMIT: usize = 300;
const NAMES_DEPTH: usize = 4;

/// Every namespace (breadth first, up to a limit) with its table names.
pub async fn names(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<CatalogNames>> {
    use futures::{StreamExt, TryStreamExt};

    let connected = state.registry.get(id).await?;
    let catalog = connected.catalog;
    let mut out = Vec::new();
    let mut frontier = catalog.list_namespaces(None).await?;
    let mut truncated = false;
    for depth in 0..NAMES_DEPTH {
        if frontier.is_empty() {
            break;
        }
        if out.len() + frontier.len() > NAMES_LIMIT {
            frontier.truncate(NAMES_LIMIT.saturating_sub(out.len()));
            truncated = true;
        }
        let level: Vec<(NamespaceIdent, Vec<String>, Vec<NamespaceIdent>)> =
            futures::stream::iter(frontier)
                .map(|namespace| {
                    let catalog = catalog.clone();
                    let descend = depth + 1 < NAMES_DEPTH;
                    async move {
                        let tables = catalog.list_tables(&namespace).await?;
                        let children = if descend {
                            catalog.list_namespaces(Some(&namespace)).await?
                        } else {
                            Vec::new()
                        };
                        let mut tables: Vec<String> =
                            tables.into_iter().map(|t| t.name().to_owned()).collect();
                        tables.sort();
                        Ok::<_, iceberg::Error>((namespace, tables, children))
                    }
                })
                .buffer_unordered(SUMMARY_CONCURRENCY)
                .try_collect()
                .await?;
        frontier = Vec::new();
        for (namespace, tables, children) in level {
            out.push(NamespaceNames {
                namespace: namespace.inner(),
                tables,
            });
            frontier.extend(children);
        }
        if truncated {
            break;
        }
    }
    out.sort_by(|a, b| a.namespace.cmp(&b.namespace));
    Ok(Json(CatalogNames {
        namespaces: out,
        truncated: truncated || !frontier.is_empty(),
    }))
}

/// Set and remove table properties in one commit; returns the new detail.
pub async fn update_properties(
    State(state): State<AppState>,
    Json(update): Json<crate::types::PropertiesUpdate>,
) -> ApiResult<Json<TableDetail>> {
    use iceberg::transaction::{ApplyTransactionAction, Transaction};

    if update.set.is_empty() && update.remove.is_empty() {
        return Err(ApiError::BadRequest("nothing to change".to_owned()));
    }
    for key in update.set.keys().chain(update.remove.iter()) {
        if key.trim().is_empty() {
            return Err(ApiError::BadRequest(
                "property names cannot be empty".to_owned(),
            ));
        }
    }
    if let Some(key) = update
        .remove
        .iter()
        .find(|key| update.set.contains_key(*key))
    {
        return Err(ApiError::BadRequest(format!(
            "{key} is both set and removed"
        )));
    }
    let connected = state.registry.get(update.target.catalog_id).await?;
    let ident = TableIdent::new(
        NamespaceIdent::from_vec(update.target.namespace.clone())?,
        update.target.table.clone(),
    );
    let table = connected.catalog.load_table(&ident).await?;
    let tx = Transaction::new(&table);
    let mut action = tx.update_table_properties();
    for (key, value) in &update.set {
        action = action.set(key.trim().to_owned(), value.clone());
    }
    for key in &update.remove {
        action = action.remove(key.trim().to_owned());
    }
    let tx = action.apply(tx)?;
    let updated = tx.commit(connected.catalog.as_ref()).await?;
    let totals = current_totals(&updated, &state.file_stats).await?;
    Ok(Json(table_detail(&connected.record.name, &updated, totals)))
}

pub async fn partitions(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<TableQuery>,
) -> ApiResult<Json<Vec<crate::metadata_tables::PartitionStat>>> {
    let connected = state.registry.get(id).await?;
    let ident = TableIdent::new(namespace_ident(&query.namespace)?, query.name);
    let table = connected.catalog.load_table(&ident).await?;
    Ok(Json(crate::metadata_tables::partition_stats(&table).await?))
}

fn namespace_ident(value: &str) -> ApiResult<NamespaceIdent> {
    let levels = split_namespace(value);
    if levels.is_empty() {
        return Err(ApiError::BadRequest("namespace is required".to_owned()));
    }
    Ok(NamespaceIdent::from_vec(levels)?)
}
