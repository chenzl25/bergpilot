//! The web UI, embedded from `web/dist` at build time.
//!
//! Debug builds read the files from disk, so `pnpm build` takes effect
//! without recompiling. Release builds embed them. If the UI has not been
//! built, `/` explains how to build it.

use axum::http::{StatusCode, Uri, header};
use axum::response::{Html, IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../web/dist"]
#[allow_missing = true]
struct Assets;

pub async fn serve_asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Some(response) = asset(path) {
        return response;
    }
    // Client-side routes all render the single page.
    asset("index.html").unwrap_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Html(
                "<h1>BergPilot</h1><p>The web UI has not been built. Run \
                 <code>pnpm --dir web install &amp;&amp; pnpm --dir web build</code>, \
                 then rebuild BergPilot.</p>",
            ),
        )
            .into_response()
    })
}

fn asset(path: &str) -> Option<Response> {
    if path.is_empty() {
        return None;
    }
    let file = Assets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    // Vite fingerprints everything under assets/, so it can be cached forever.
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Some(
        (
            [
                (header::CONTENT_TYPE, mime.as_ref().to_owned()),
                (header::CACHE_CONTROL, cache.to_owned()),
            ],
            file.data,
        )
            .into_response(),
    )
}
