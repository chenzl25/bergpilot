use axum::Json;
use axum::extract::State;

use crate::error::ApiResult;
use crate::server::AppState;
use crate::types::{QueryRequest, QueryResult};

pub async fn run(
    State(state): State<AppState>,
    Json(request): Json<QueryRequest>,
) -> ApiResult<Json<QueryResult>> {
    let _permit = state
        .query_slots
        .acquire()
        .await
        .map_err(|_| crate::error::ApiError::Internal("query slots closed".to_owned()))?;
    Ok(Json(
        crate::query::run(&state.registry, &state.query_limits, request).await?,
    ))
}
