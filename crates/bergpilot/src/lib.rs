//! BergPilot: observability and maintenance for Apache Iceberg tables.
//!
//! The binary in `main.rs` only parses flags; everything else lives here so
//! tests and examples can drive the same code.

pub mod api;
pub mod catalogs;
pub mod error;
pub mod files;
pub mod jobs;
pub mod maintenance;
pub mod metadata;
pub mod orphans;
pub mod query;
pub mod secrets;
pub mod server;
pub mod store;
pub mod types;
pub mod web;
