# Architecture

BergPilot is one Rust binary: an axum server with a JSON API under `/api` and a React single-page
app embedded from `web/dist`. It keeps its own state in SQLite and reaches Iceberg tables through
their catalogs with the RisingWave fork of iceberg-rust.

```
browser ── /api/* ──▶ api/ ──▶ catalogs (client per catalog) ──▶ REST · Glue · S3 Tables · JDBC
   ▲                   │            │
   │                   │            └─▶ metadata, files, metadata_tables, query (DataFusion)
   └── web/dist ◀── web.rs          └─▶ jobs ──▶ maintenance ──▶ iceberg-compaction, orphans
                       │
                       └─▶ store (SQLite: catalogs, jobs, schedules; secrets encrypted)
```

## Backend (`crates/bergpilot/src`)

| Module | Owns |
| --- | --- |
| `main.rs` | Flags, data directory, startup. Nothing else. |
| `server.rs` | `AppState`, the router, the access-token and loopback-Host checks. |
| `api/` | HTTP handlers only: parse, call a module below, map to JSON. `browse` (catalog/namespace/table reads), `catalogs` (CRUD, connection test), `query`, `jobs` (jobs, previews, schedules). |
| `types.rs` | Every request and response type. `ts-rs` exports them to `web/src/api/generated`. |
| `store.rs` | SQLite pool and migrations (`migrations/`); catalog records; validation of catalog settings. |
| `secrets.rs` | AES-256-GCM for catalog secrets; which property keys count as secrets. |
| `catalogs.rs` | Building an iceberg-rust `Catalog` per kind, and caching clients until a catalog changes. |
| `metadata.rs` | `TableDetail` from table metadata (schema, specs, snapshots, refs). |
| `files.rs` | Files-by-size statistics per snapshot, cached by (table UUID, snapshot id). |
| `metadata_tables.rs` | `"table$snapshots"`, `$history`, `$refs`, `$manifests`, `$files`, `$partitions`, plus partition statistics for the UI. |
| `query.rs` | Read-only SQL: parse, resolve referenced tables, register only those (pinned to their current snapshot), execute with row, time and memory limits. |
| `maintenance.rs` | Compaction, expiry, orphan removal and manifest rewrite; previews; setting validation. |
| `orphans.rs` | Orphan-file detection with normalized paths and a self-check (see Safety in README). |
| `jobs.rs` | Job queue and worker, cancellation, restart recovery, cron schedules. |
| `web.rs` | Serving `web/dist` (from disk in debug builds, embedded in release builds). |

Dependencies point down the table: handlers call modules; modules never call handlers; only
`store.rs` and `jobs.rs` touch SQL.

## Frontend (`web/src`)

- `api/client.ts`: the only place that calls `fetch`; typed with the generated types.
- `pages/`: one file per route (`main.tsx` lists them; the SQL page and its editor load lazily).
  `catalogFields.ts` describes the catalog form for each kind.
- `components/`: the app shell (`Layout.tsx`: sidebar, breadcrumbs, token prompt), explorer tree,
  ⌘K menu, maintenance tab, job tables, trend chart, the virtualized result grid (`DataGrid.tsx`),
  and shared page parts (`page.tsx`).
- `components/ui/`: [shadcn/ui](https://ui.shadcn.com) components (Radix primitives, "nova"
  style). They are our code: edit them freely. Add more with `pnpm dlx shadcn@latest add <name>`
  (`components.json` holds the settings).
- `index.css`: Tailwind v4, the color tokens for light and dark, and Geist fonts. Colors are CSS
  variables (`--primary`, `--chart-1`…); components use them through Tailwind classes, the SQL
  editor and the trend chart read them directly. `shadcn.css` is copied from the shadcn package.
- `format.ts`, `jobs.ts`, `health.ts`: formatting, plain-language descriptions, table checks.

Server state lives in TanStack Query; there is no global client store. The access token, theme,
recent queries and the SQL draft are kept in `localStorage`. Changes that finish in the background
(jobs) are announced with toasts by `useJobWatcher`.

## Decisions worth knowing

- **Fork, pinned.** iceberg-rust and iceberg-compaction are git dependencies at one revision;
  DataFusion and arrow versions follow the fork. Upgrades move them together.
- **No eager catalog provider.** The fork's `IcebergCatalogProvider` loads every table of a
  catalog; `query.rs` registers only the tables a statement names.
- **Own orphan detection.** The fork's `RemoveOrphanFilesAction` compares paths as strings and on
  local storage reports live files as orphans; `orphans.rs` replaces it.
- **Exact previews.** Expiry previews run the real transaction against a catalog wrapper that
  records the commit and declines it, so the preview and the run use the same rules.
- **One job per table.** The worker never runs two jobs on one table; schedules skip a tick while
  their previous job is unfinished.

## Tests

- Unit tests sit next to their code.
- `tests/sql_catalog.rs` and `tests/maintenance.rs` run the HTTP API in-process against a SQLite
  catalog and a local warehouse: browsing, SQL, metadata tables, and every maintenance operation,
  checking data and files on disk.
- `dev/docker-compose.yml` and `examples/seed.rs` give a REST catalog on S3-compatible storage for
  manual checks.
