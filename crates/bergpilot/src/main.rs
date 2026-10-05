use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, bail};
use bergpilot::server::{AppState, serve};
use bergpilot::store::Store;
use clap::Parser;
use tracing_subscriber::EnvFilter;

/// Observability and maintenance for Apache Iceberg tables.
#[derive(Parser)]
#[command(version)]
struct Args {
    /// Address to listen on. Anything other than a loopback address requires
    /// --token.
    #[arg(long, env = "BERGPILOT_BIND", default_value = "127.0.0.1:7878")]
    bind: SocketAddr,

    /// Where BergPilot keeps its database and secret key.
    /// Defaults to ~/.bergpilot.
    #[arg(long, env = "BERGPILOT_DATA_DIR")]
    data_dir: Option<PathBuf>,

    /// Access token required by the API. Prefer the environment variable so
    /// the token does not show up in process listings.
    #[arg(long, env = "BERGPILOT_TOKEN", hide_env_values = true)]
    token: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    let token = args.token.filter(|token| !token.is_empty());
    if !args.bind.ip().is_loopback() && token.is_none() {
        bail!(
            "refusing to listen on {} without an access token; set BERGPILOT_TOKEN \
             or bind to 127.0.0.1",
            args.bind
        );
    }

    let data_dir = match args.data_dir {
        Some(dir) => dir,
        None => std::env::home_dir()
            .context("cannot find the home directory; pass --data-dir")?
            .join(".bergpilot"),
    };
    let store = Store::open(&data_dir).await?;

    let host = if args.bind.ip().is_unspecified() {
        "localhost".to_owned()
    } else {
        args.bind.ip().to_string()
    };
    println!("BergPilot {} is running", env!("CARGO_PKG_VERSION"));
    println!("  Open:  http://{host}:{}/", args.bind.port());
    println!("  Data:  {}", data_dir.display());
    if token.is_some() {
        println!("  The API requires the access token; the UI will ask for it.");
    }

    serve(args.bind, AppState::new(store, token)).await
}
