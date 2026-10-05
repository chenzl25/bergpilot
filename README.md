# BergPilot

Observability and maintenance for Apache Iceberg™ tables, in a single Rust service. No JVM, no Spark.

> **Status:** early. Nothing is usable yet; this repository currently holds the project skeleton.

## Goals

- **Catalogs:** connect to REST, AWS Glue, S3 Tables and SQL catalogs (Hive Metastore read-only).
- **Observability:** browse namespaces and tables; inspect schemas, partition specs, snapshots, branches, manifests and data/delete files; show file-size distribution and how it changes over time.
- **SQL inspection:** run read queries against tables with Apache DataFusion.
- **Maintenance:** compaction, snapshot expiry, orphan-file cleanup and manifest rewrites, on demand or on a schedule.

## Built on

- [risingwavelabs/iceberg-rust](https://github.com/risingwavelabs/iceberg-rust): catalogs, metadata, scans, DataFusion integration and maintenance actions.
- [nimtable/iceberg-compaction](https://github.com/nimtable/iceberg-compaction): data-file compaction on DataFusion.

Both are git dependencies pinned to a revision, so BergPilot is not published to crates.io. Binaries and container images will be the release artifacts.

BergPilot is inspired by [Nimtable](https://github.com/nimtable/nimtable) and may reuse parts of it under the Apache License 2.0.

## Roadmap

1. **Read-only:** catalog browsing, metadata and manifest inspection, file distribution, `SELECT` queries.
2. **Maintenance:** compaction, snapshot expiry, orphan cleanup, scheduling.
3. **Writes:** an Iceberg REST catalog endpoint that proxies commits to the underlying catalog.

## Development

The toolchain is pinned in `rust-toolchain.toml`.

```bash
cargo build
cargo test
```

## License

[Apache License 2.0](LICENSE).

Apache®, Apache Iceberg™, Apache DataFusion™ and their logos are trademarks of the Apache Software Foundation. BergPilot is not affiliated with or endorsed by the Apache Software Foundation.
