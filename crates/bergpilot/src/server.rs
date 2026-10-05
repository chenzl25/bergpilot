//! Wiring: shared state, access control and the HTTP server.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use tokio::sync::Semaphore;
use tower_http::trace::TraceLayer;

use crate::catalogs::CatalogRegistry;
use crate::error::ApiError;
use crate::files::FileStatsCache;
use crate::jobs::Jobs;
use crate::maintenance::MaintenanceLimits;
use crate::query::QueryLimits;
use crate::store::Store;

/// Queries run at the same time; more wait for a slot.
const QUERY_SLOTS: usize = 2;

#[derive(Clone)]
pub struct AppState {
    pub registry: CatalogRegistry,
    pub jobs: Jobs,
    pub file_stats: FileStatsCache,
    pub query_limits: QueryLimits,
    pub query_slots: Arc<Semaphore>,
    /// When set, every `/api` request except `/api/info` must send
    /// `Authorization: Bearer <token>`.
    pub token: Option<Arc<str>>,
}

impl AppState {
    /// State without background work; call [`AppState::start`] to run jobs
    /// and schedules.
    pub fn new(store: Store, token: Option<String>) -> Self {
        Self::with_limits(
            store,
            token,
            QueryLimits::default(),
            MaintenanceLimits::default(),
        )
    }

    pub fn with_limits(
        store: Store,
        token: Option<String>,
        query_limits: QueryLimits,
        maintenance_limits: MaintenanceLimits,
    ) -> Self {
        let registry = CatalogRegistry::new(store.clone());
        Self {
            jobs: Jobs::new(store.pool().clone(), registry.clone(), maintenance_limits),
            registry,
            file_stats: FileStatsCache::default(),
            query_limits,
            query_slots: Arc::new(Semaphore::new(QUERY_SLOTS)),
            token: token.map(Arc::from),
        }
    }
}

impl AppState {
    /// Start the job worker and the scheduler.
    pub async fn start(&self) -> anyhow::Result<()> {
        self.jobs.start().await
    }
}

pub fn app(state: AppState) -> Router {
    let api = crate::api::router()
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token))
        .with_state(state.clone());
    Router::new()
        .nest("/api", api)
        .fallback(crate::web::serve_asset)
        .layer(middleware::from_fn_with_state(state, check_host))
        .layer(TraceLayer::new_for_http())
}

/// Without a token BergPilot trusts anything that can reach it, which is
/// only this machine. A web page could still reach it through DNS rebinding
/// (a hostname that resolves to 127.0.0.1), so in that mode only loopback
/// host names are accepted. With a token, the token protects the API.
async fn check_host(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if state.token.is_some() {
        return next.run(request).await;
    }
    let host = request
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if is_loopback_host(host) {
        next.run(request).await
    } else {
        (
            axum::http::StatusCode::FORBIDDEN,
            "BergPilot only answers requests addressed to localhost unless it runs with an \
             access token (BERGPILOT_TOKEN).",
        )
            .into_response()
    }
}

/// `host` from a Host header, with or without a port.
fn is_loopback_host(host: &str) -> bool {
    let name = if let Some(rest) = host.strip_prefix('[') {
        // [::1]:7878
        rest.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map_or(host, |(name, _)| name)
    };
    name.eq_ignore_ascii_case("localhost")
        || name
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

async fn require_token(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let Some(expected) = state.token.as_deref() else {
        return next.run(request).await;
    };
    if request.uri().path().ends_with("/info") {
        return next.run(request).await;
    }
    let provided = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    match provided {
        Some(token) if constant_time_eq(token.as_bytes(), expected.as_bytes()) => {
            next.run(request).await
        }
        _ => ApiError::Unauthorized("a valid access token is required".to_owned()).into_response(),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub async fn serve(addr: SocketAddr, state: AppState) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_loopback_host;

    #[test]
    fn accepts_only_loopback_hosts() {
        for host in [
            "localhost",
            "localhost:7878",
            "127.0.0.1:7878",
            "127.0.0.2",
            "[::1]:7878",
            "LOCALHOST",
        ] {
            assert!(is_loopback_host(host), "{host}");
        }
        for host in [
            "evil.example",
            "evil.example:7878",
            "192.168.1.5:7878",
            "",
            "localhost.evil.example",
        ] {
            assert!(!is_loopback_host(host), "{host}");
        }
    }
}
