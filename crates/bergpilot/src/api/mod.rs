//! HTTP API under `/api`.

mod browse;
mod catalogs;
mod jobs;
mod query;

use axum::Router;
use axum::routing::{get, post, put};

use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/info", get(catalogs::info))
        .route("/catalogs", get(catalogs::list).post(catalogs::create))
        .route("/catalogs/test", post(catalogs::test))
        .route(
            "/catalogs/{id}",
            get(catalogs::get_one)
                .put(catalogs::update)
                .delete(catalogs::delete),
        )
        .route("/catalogs/{id}/namespaces", get(browse::namespaces))
        .route("/catalogs/{id}/tables", get(browse::tables))
        .route("/catalogs/{id}/table", get(browse::table))
        .route("/catalogs/{id}/table/files", get(browse::files))
        .route("/catalogs/{id}/table/partitions", get(browse::partitions))
        .route("/query", post(query::run))
        .route("/jobs", get(jobs::list).post(jobs::submit))
        .route("/jobs/{id}", get(jobs::get_one))
        .route("/jobs/{id}/cancel", post(jobs::cancel))
        .route("/maintenance/preview", post(jobs::preview))
        .route(
            "/schedules",
            get(jobs::list_schedules).post(jobs::create_schedule),
        )
        .route(
            "/schedules/{id}",
            put(jobs::update_schedule).delete(jobs::delete_schedule),
        )
}

/// Namespace levels travel in query strings joined by U+001F, the separator
/// the Iceberg REST spec uses for multi-level namespaces.
pub const NAMESPACE_SEPARATOR: char = '\u{1f}';

pub fn split_namespace(value: &str) -> Vec<String> {
    value
        .split(NAMESPACE_SEPARATOR)
        .filter(|level| !level.is_empty())
        .map(str::to_owned)
        .collect()
}
