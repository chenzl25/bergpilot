use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;

use crate::catalogs::connect;
use crate::error::ApiResult;
use crate::server::AppState;
use crate::types::{
    CatalogInput, CatalogSummary, CatalogTestRequest, CatalogTestResult, ServerInfo,
};

pub async fn info(State(state): State<AppState>) -> Json<ServerInfo> {
    Json(ServerInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        auth_required: state.token.is_some(),
        catalog_kinds: crate::catalogs::compiled_kinds(),
    })
}

pub async fn list(State(state): State<AppState>) -> ApiResult<Json<Vec<CatalogSummary>>> {
    let records = state.registry.store().list_catalogs().await?;
    Ok(Json(
        records.iter().map(|record| record.summary()).collect(),
    ))
}

pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<CatalogSummary>> {
    Ok(Json(
        state.registry.store().get_catalog(id).await?.summary(),
    ))
}

pub async fn create(
    State(state): State<AppState>,
    Json(input): Json<CatalogInput>,
) -> ApiResult<(StatusCode, Json<CatalogSummary>)> {
    let record = state.registry.store().create_catalog(&input).await?;
    Ok((StatusCode::CREATED, Json(record.summary())))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<CatalogInput>,
) -> ApiResult<Json<CatalogSummary>> {
    let record = state.registry.store().update_catalog(id, &input).await?;
    state.registry.forget(id).await;
    Ok(Json(record.summary()))
}

pub async fn delete(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    state.registry.store().delete_catalog(id).await?;
    state.registry.forget(id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Try to connect and list top-level namespaces without saving anything.
pub async fn test(
    State(state): State<AppState>,
    Json(request): Json<CatalogTestRequest>,
) -> ApiResult<Json<CatalogTestResult>> {
    let record = state
        .registry
        .store()
        .preview_catalog(request.id, &request.catalog)
        .await?;
    let outcome = async {
        let catalog = connect(&record).await?;
        let namespaces = catalog.list_namespaces(None).await?;
        Ok::<_, crate::error::ApiError>(namespaces.len() as u32)
    }
    .await;
    Ok(Json(match outcome {
        Ok(count) => CatalogTestResult {
            ok: true,
            namespaces: Some(count),
            error: None,
        },
        Err(error) => CatalogTestResult {
            ok: false,
            namespaces: None,
            error: Some(error.to_string()),
        },
    }))
}
