// Form layout for each catalog type: which properties BergPilot shows as
// inputs, and which ones are secrets. Property keys are the ones the
// iceberg-rust catalog builders read.

import type { ComponentType } from "react";
import { Cloud, Database, Globe, Package } from "lucide-react";

import type { CatalogKind } from "@/api/generated/CatalogKind";

export interface Field {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  checkbox?: boolean;
}

export interface AuthMode {
  id: string;
  label: string;
  fields: Field[];
}

export interface KindLayout {
  label: string;
  icon: ComponentType<{ className?: string }>;
  description: string;
  connection: Field[];
  /** Mutually exclusive ways to authenticate; the first is the default. */
  auth: AuthMode[];
  authTitle: string;
  storageNote: string;
}

const S3_FIELDS: Field[] = [
  { key: "s3.endpoint", label: "Endpoint", placeholder: "Optional, e.g. http://localhost:9000" },
  { key: "s3.region", label: "Region", placeholder: "Optional, e.g. us-east-1" },
  { key: "s3.access-key-id", label: "Access key ID", secret: true },
  { key: "s3.secret-access-key", label: "Secret access key", secret: true },
  {
    key: "s3.path-style-access",
    label: "Path-style access (MinIO and most self-hosted storage)",
    checkbox: true,
  },
];

export const STORAGE_FIELDS = S3_FIELDS;

const AWS_AUTH: AuthMode[] = [
  { id: "default", label: "Default chain", fields: [] },
  {
    id: "profile",
    label: "Profile",
    fields: [{ key: "profile_name", label: "Profile", placeholder: "Name in ~/.aws/config" }],
  },
  {
    id: "keys",
    label: "Access keys",
    fields: [
      { key: "aws_access_key_id", label: "Access key ID", secret: true },
      { key: "aws_secret_access_key", label: "Secret access key", secret: true },
      { key: "aws_session_token", label: "Session token", secret: true, hint: "Only for temporary credentials" },
    ],
  },
];

export const LAYOUTS: Record<CatalogKind, KindLayout> = {
  rest: {
    icon: Globe,
    label: "REST",
    description: "An Iceberg REST catalog such as Polaris, Lakekeeper, Gravitino, Nessie or Unity.",
    connection: [
      { key: "uri", label: "URI", required: true, placeholder: "https://catalog.example.com" },
      { key: "warehouse", label: "Warehouse", placeholder: "Optional" },
    ],
    authTitle: "Authentication",
    auth: [
      { id: "none", label: "None", fields: [] },
      {
        id: "oauth2",
        label: "OAuth2 client",
        fields: [
          { key: "credential", label: "Credential", secret: true, hint: "client_id:client_secret" },
          { key: "oauth2-server-uri", label: "Token endpoint", placeholder: "Optional; defaults to the catalog's" },
          { key: "scope", label: "Scope", placeholder: "Optional" },
        ],
      },
      { id: "token", label: "Bearer token", fields: [{ key: "token", label: "Token", secret: true }] },
    ],
    storageNote: "Leave empty when the catalog vends credentials or the environment provides them.",
  },
  glue: {
    icon: Cloud,
    label: "AWS Glue",
    description: "The AWS Glue Data Catalog. Glue databases are namespaces; there is no nesting.",
    connection: [
      { key: "warehouse", label: "Warehouse", required: true, placeholder: "s3://bucket/warehouse" },
      { key: "region_name", label: "Region", placeholder: "e.g. us-east-1" },
      { key: "catalog_id", label: "Catalog ID", placeholder: "Optional; the AWS account ID" },
      { key: "uri", label: "Endpoint", placeholder: "Optional; for VPC endpoints or local testing" },
    ],
    authTitle: "AWS credentials",
    auth: AWS_AUTH,
    storageNote: "Usually empty: S3 reuses the AWS region and keys above unless set here.",
  },
  s3tables: {
    icon: Package,
    label: "S3 Tables",
    description: "Amazon S3 Tables. Each table bucket is one catalog.",
    connection: [
      {
        key: "table_bucket_arn",
        label: "Table bucket ARN",
        required: true,
        placeholder: "arn:aws:s3tables:us-east-1:123456789012:bucket/name",
      },
      { key: "region_name", label: "Region", placeholder: "e.g. us-east-1" },
      { key: "endpoint_url", label: "Endpoint", placeholder: "Optional; for local testing" },
    ],
    authTitle: "AWS credentials",
    auth: AWS_AUTH,
    storageNote: "Usually empty: S3 Tables vends storage access.",
  },
  sql: {
    icon: Database,
    label: "JDBC",
    description:
      "A catalog kept in PostgreSQL, MySQL or SQLite tables, the layout Java's JdbcCatalog uses.",
    connection: [
      {
        key: "uri",
        label: "Database URL",
        required: true,
        placeholder: "postgres://user@host:5432/db · mysql://… · sqlite:///path/catalog.db",
        hint: "Without the password; it goes in the field below.",
      },
      { key: "password", label: "Database password", secret: true },
      {
        key: "catalog_name",
        label: "Catalog name in the database",
        placeholder: "Defaults to the BergPilot name",
        hint: "The name the catalog was created with in Spark, Flink or Trino (the catalog_name column).",
      },
      { key: "warehouse", label: "Warehouse", placeholder: "Optional" },
    ],
    authTitle: "",
    auth: [{ id: "none", label: "None", fields: [] }],
    storageNote: "Needed unless the environment provides storage credentials.",
  },
};

/** Every key a layout shows, so the rest can go to "additional properties". */
export function knownKeys(kind: CatalogKind): Set<string> {
  const layout = LAYOUTS[kind];
  const keys = new Set<string>();
  for (const field of [...layout.connection, ...STORAGE_FIELDS]) keys.add(field.key);
  for (const mode of layout.auth) for (const field of mode.fields) keys.add(field.key);
  return keys;
}

/** Guess the auth mode of a stored catalog from the keys it has. */
export function detectAuth(kind: CatalogKind, keys: string[]): string {
  const layout = LAYOUTS[kind];
  for (const mode of layout.auth) {
    if (mode.fields.some((field) => keys.includes(field.key))) return mode.id;
  }
  return layout.auth[0].id;
}
