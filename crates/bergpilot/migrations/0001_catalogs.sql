create table catalogs (
    id integer primary key autoincrement,
    -- Also the catalog name in SQL, so it is restricted to [a-z_][a-z0-9_]*.
    name text not null unique,
    kind text not null,
    -- JSON object of non-secret connection properties.
    properties text not null default '{}',
    -- Encrypted JSON object of secret properties (see secrets.rs), or null.
    secrets text,
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
