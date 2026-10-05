use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use iceberg::{NamespaceIdent, TableIdent};
use serde::Deserialize;

use super::split_namespace;
use crate::error::ApiResult;
use crate::jobs::JobFilter;
use crate::server::AppState;
use crate::types::{
    JobInfo, JobRequest, MaintenancePreview, PreviewRequest, ScheduleInfo, ScheduleInput, TableRef,
};

#[derive(Deserialize)]
pub struct TableFilter {
    #[serde(default)]
    catalog_id: Option<i64>,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    table: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

impl TableFilter {
    fn target(&self) -> Option<TableRef> {
        match (&self.catalog_id, &self.namespace, &self.table) {
            (Some(catalog_id), Some(namespace), Some(table)) => Some(TableRef {
                catalog_id: *catalog_id,
                namespace: split_namespace(namespace),
                table: table.clone(),
            }),
            _ => None,
        }
    }
}

pub async fn list(
    State(state): State<AppState>,
    Query(filter): Query<TableFilter>,
) -> ApiResult<Json<Vec<JobInfo>>> {
    let filter = JobFilter {
        target: filter.target(),
        limit: filter.limit,
    };
    Ok(Json(state.jobs.list(&filter).await?))
}

pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<JobInfo>> {
    Ok(Json(state.jobs.get(id).await?))
}

pub async fn submit(
    State(state): State<AppState>,
    Json(request): Json<JobRequest>,
) -> ApiResult<(StatusCode, Json<JobInfo>)> {
    let job = state
        .jobs
        .submit(&request.target, &request.task, None)
        .await?;
    Ok((StatusCode::CREATED, Json(job)))
}

pub async fn cancel(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<JobInfo>> {
    Ok(Json(state.jobs.cancel(id).await?))
}

pub async fn preview(
    State(state): State<AppState>,
    Json(request): Json<PreviewRequest>,
) -> ApiResult<Json<MaintenancePreview>> {
    let connected = state.registry.get(request.target.catalog_id).await?;
    let ident = TableIdent::new(
        NamespaceIdent::from_vec(request.target.namespace.clone())?,
        request.target.table.clone(),
    );
    Ok(Json(
        crate::maintenance::preview(
            connected.catalog,
            &ident,
            &request.task,
            state.jobs.limits(),
        )
        .await?,
    ))
}

pub async fn list_schedules(
    State(state): State<AppState>,
    Query(filter): Query<TableFilter>,
) -> ApiResult<Json<Vec<ScheduleInfo>>> {
    Ok(Json(
        state.jobs.list_schedules(filter.target().as_ref()).await?,
    ))
}

pub async fn create_schedule(
    State(state): State<AppState>,
    Json(input): Json<ScheduleInput>,
) -> ApiResult<(StatusCode, Json<ScheduleInfo>)> {
    Ok((
        StatusCode::CREATED,
        Json(state.jobs.create_schedule(&input).await?),
    ))
}

pub async fn update_schedule(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<ScheduleInput>,
) -> ApiResult<Json<ScheduleInfo>> {
    Ok(Json(state.jobs.update_schedule(id, &input).await?))
}

pub async fn delete_schedule(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    state.jobs.delete_schedule(id).await?;
    Ok(StatusCode::NO_CONTENT)
}
