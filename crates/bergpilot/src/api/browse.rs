use axum::Json;
use axum::extract::{Path, Query, State};
use iceberg::{NamespaceIdent, TableIdent};
use serde::Deserialize;

use super::split_namespace;
use crate::error::{ApiError, ApiResult};
use crate::metadata::table_detail;
use crate::server::AppState;
use crate::types::{FileStats, NamespaceList, TableDetail, TableList};

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
    Ok(Json(table_detail(&connected.record.name, &table)))
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
