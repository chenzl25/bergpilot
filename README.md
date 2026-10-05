# BergPilot

Observability and maintenance for Apache Iceberg™ tables, in a single Rust service. No JVM, no Spark.

> **Status:** early. Connect REST, AWS Glue, S3 Tables and JDBC catalogs, browse namespaces and tables, inspect schemas, snapshots and file sizes, and run read-only SQL.

## Goals

- **Catalogs:** connect to REST, AWS Glue, S3 Tables and JDBC catalogs.
- **Observability:** browse namespaces and tables; inspect schemas, partition specs, snapshots, branches, manifests and data/delete files; show file-size distribution and how it changes over time.
- **SQL inspection:** run read queries against tables with Apache DataFusion.
- **Maintenance:** compaction, snapshot expiry, orphan-file cleanup and manifest rewrites, on demand or on a schedule.

## Built on

- [risingwavelabs/iceberg-rust](https://github.com/risingwavelabs/iceberg-rust): catalogs, metadata, scans, DataFusion integration and maintenance actions.
- [nimtable/iceberg-compaction](https://github.com/nimtable/iceberg-compaction): data-file compaction on DataFusion.

Both are git dependencies pinned to a revision, so BergPilot is not published to crates.io. Binaries and container images will be the release artifacts.

BergPilot is inspired by [Nimtable](https://github.com/nimtable/nimtable) and may reuse parts of it under the Apache License 2.0.

## Roadmap

1. **Read-only (done):** REST catalogs, browsing, table detail, file-size distribution, `SELECT` queries.
2. **More catalogs (done):** AWS Glue, S3 Tables and JDBC.
3. **Maintenance:** compaction, snapshot expiry, orphan cleanup and manifest rewrites, with scheduling.

## Catalogs

| Type | Connects with | Notes |
| --- | --- | --- |
| REST | URI, optional OAuth2 client credentials or bearer token | Vended credentials are refreshed automatically. |
| AWS Glue | Warehouse, region, default credential chain, profile or access keys | Glue databases are namespaces; Glue has no nesting. |
| S3 Tables | Table bucket ARN, region, AWS credentials | Not yet tested against AWS; local mocks cover listing only. |
| JDBC | PostgreSQL, MySQL or SQLite URL; password kept separately | Reads catalogs created by Java's `JdbcCatalog` (Spark, Flink, Trino). Set "catalog name in the database" to the name they used. |

## Running

Build the web UI, then the server; the release binary embeds the UI:

```bash
pnpm --dir web install
pnpm --dir web build
cargo build --release
./target/release/bergpilot
```

Open http://127.0.0.1:7878 and add a catalog. BergPilot keeps its database and secret key in
`~/.bergpilot` (`--data-dir` to change). It listens on 127.0.0.1; to listen on another address,
set an access token with `BERGPILOT_TOKEN` and pass `--bind 0.0.0.0:7878`.

In SQL, tables are named `catalog.namespace.table`. Write a nested namespace as one quoted
identifier: `prod."sales.eu".orders`. Only read-only queries run.

## Development

The Rust toolchain is pinned in `rust-toolchain.toml`.

```bash
docker compose -f dev/docker-compose.yml up -d   # REST catalog on :8181, storage on :9000
cargo run --example seed                         # sample tables in namespace "demo"
cargo run                                        # API and UI on :7878
pnpm --dir web dev                               # UI with hot reload on :5173
```

For the local catalog use URI `http://localhost:8181`, S3 endpoint `http://localhost:9000`,
region `us-east-1`, access key `admin`, secret `password`, and path-style access.

To seed other catalog types (for example Glue in a [moto](https://github.com/getmoto/moto) server),
see the environment variables at the top of `crates/bergpilot/examples/seed.rs`.

`cargo test` regenerates the TypeScript API types in `web/src/api/generated`; commit them with any
change to `crates/bergpilot/src/types.rs`.

## License

[Apache License 2.0](LICENSE).

Apache®, Apache Iceberg™, Apache DataFusion™ and their logos are trademarks of the Apache Software Foundation. BergPilot is not affiliated with or endorsed by the Apache Software Foundation.
