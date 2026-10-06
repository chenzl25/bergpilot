use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// An error returned by the HTTP API as `{"error": "..."}`.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Unauthorized(String),
    /// The table changed in a way that makes the request unsafe to finish.
    #[error("{0}")]
    Conflict(String),
    /// The catalog or storage behind a request failed.
    #[error("{0}")]
    Upstream(String),
    #[error("{0}")]
    Internal(String),
}

impl ApiError {
    fn status(&self) -> StatusCode {
        match self {
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::NotFound(_) => StatusCode::NOT_FOUND,
            ApiError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::Upstream(_) => StatusCode::BAD_GATEWAY,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();
        if status.is_server_error() {
            tracing::warn!(%status, error = %self, "request failed");
        }
        (status, Json(json!({ "error": self.to_string() }))).into_response()
    }
}

impl From<iceberg::Error> for ApiError {
    fn from(error: iceberg::Error) -> Self {
        ApiError::Upstream(error.to_string())
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        ApiError::Internal(format!("database error: {error}"))
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        ApiError::Internal(format!("{error:#}"))
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
