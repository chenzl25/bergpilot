import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";

import { api } from "../api/client";
import type { CatalogInput } from "../api/generated/CatalogInput";
import type { CatalogSummary } from "../api/generated/CatalogSummary";
import type { CatalogTestResult } from "../api/generated/CatalogTestResult";
import { errorMessage } from "../components/Layout";

type Auth = "none" | "oauth2" | "token";

/** Properties with their own inputs; everything else is "additional". */
const KNOWN_PROPERTIES = [
  "uri",
  "warehouse",
  "oauth2-server-uri",
  "scope",
  "s3.endpoint",
  "s3.region",
  "s3.path-style-access",
];
const KNOWN_SECRETS = ["credential", "token", "s3.access-key-id", "s3.secret-access-key"];

interface FormState {
  name: string;
  uri: string;
  warehouse: string;
  auth: Auth;
  oauthServer: string;
  scope: string;
  s3Endpoint: string;
  s3Region: string;
  s3PathStyle: boolean;
  /** New secret values typed in this session; blank keeps the stored one. */
  secrets: Record<string, string>;
  /** Stored secrets the user chose to remove. */
  cleared: string[];
  extra: { key: string; value: string }[];
}

const EMPTY: FormState = {
  name: "",
  uri: "",
  warehouse: "",
  auth: "none",
  oauthServer: "",
  scope: "",
  s3Endpoint: "",
  s3Region: "",
  s3PathStyle: false,
  secrets: {},
  cleared: [],
  extra: [],
};

function fromSummary(catalog: CatalogSummary): FormState {
  const p = catalog.properties;
  const has = (key: string) => catalog.secret_keys.includes(key);
  return {
    ...EMPTY,
    name: catalog.name,
    uri: p.uri ?? "",
    warehouse: p.warehouse ?? "",
    auth: has("credential") ? "oauth2" : has("token") ? "token" : "none",
    oauthServer: p["oauth2-server-uri"] ?? "",
    scope: p.scope ?? "",
    s3Endpoint: p["s3.endpoint"] ?? "",
    s3Region: p["s3.region"] ?? "",
    s3PathStyle: p["s3.path-style-access"] === "true",
    extra: Object.entries(p)
      .filter(([key]) => !KNOWN_PROPERTIES.includes(key))
      .map(([key, value]) => ({ key, value: value ?? "" })),
  };
}

function toInput(form: FormState, stored: string[]): CatalogInput {
  const properties: Record<string, string> = {};
  const set = (key: string, value: string) => {
    if (value.trim()) properties[key] = value.trim();
  };
  set("uri", form.uri);
  set("warehouse", form.warehouse);
  if (form.auth === "oauth2") {
    set("oauth2-server-uri", form.oauthServer);
    set("scope", form.scope);
  }
  set("s3.endpoint", form.s3Endpoint);
  set("s3.region", form.s3Region);
  if (form.s3PathStyle) properties["s3.path-style-access"] = "true";
  for (const { key, value } of form.extra) set(key.trim(), value);

  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(form.secrets)) {
    if (value) secrets[key] = value;
  }
  // Switching authentication removes the other method's stored secret.
  const unused = form.auth === "oauth2" ? ["token"] : form.auth === "token" ? ["credential"] : ["credential", "token"];
  const clear = [...form.cleared, ...unused].filter((key) => stored.includes(key));
  for (const key of unused) delete secrets[key];
  return { name: form.name.trim(), kind: "rest", properties, secrets, clear_secrets: clear };
}

export function CatalogFormPage() {
  const params = useParams();
  const id = params.id ? Number(params.id) : undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const existing = useQuery({
    queryKey: ["catalog", id],
    queryFn: () => api.getCatalog(id!),
    enabled: id !== undefined,
  });
  const [form, setForm] = useState<FormState>(EMPTY);
  const [testResult, setTestResult] = useState<CatalogTestResult | null>(null);
  const stored = existing.data?.secret_keys ?? [];

  useEffect(() => {
    setForm(existing.data ? fromSummary(existing.data) : EMPTY);
    setTestResult(null);
  }, [existing.data, id]);

  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));
  const setSecret = (key: string, value: string) =>
    setForm((current) => ({
      ...current,
      secrets: { ...current.secrets, [key]: value },
      cleared: current.cleared.filter((item) => item !== key),
    }));

  const save = useMutation({
    mutationFn: () => {
      const input = toInput(form, stored);
      return id === undefined ? api.createCatalog(input) : api.updateCatalog(id, input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      navigate("/");
    },
  });
  const test = useMutation({
    mutationFn: () => api.testCatalog(toInput(form, stored), id),
    onSuccess: setTestResult,
    onError: (error) => setTestResult({ ok: false, error: errorMessage(error) }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCatalog(id!),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      navigate("/");
    },
  });

  if (id !== undefined && existing.isPending) return <p className="muted">Loading…</p>;
  if (existing.isError) return <p className="error">{errorMessage(existing.error)}</p>;

  const secretInput = (key: string, label: string, hint?: string) => {
    const isStored = stored.includes(key) && !form.cleared.includes(key);
    return (
      <label>
        <span>{label}</span>
        <div className="secret-row">
          <input
            type="password"
            autoComplete="off"
            value={form.secrets[key] ?? ""}
            placeholder={isStored ? "Stored — leave blank to keep" : ""}
            onChange={(event) => setSecret(key, event.target.value)}
          />
          {isStored && (
            <button
              type="button"
              className="link"
              onClick={() => update({ cleared: [...form.cleared, key] })}
            >
              Remove
            </button>
          )}
        </div>
        {hint && <small className="muted">{hint}</small>}
      </label>
    );
  };

  return (
    <div className="page narrow">
      <h1>{id === undefined ? "Add a catalog" : `Edit ${existing.data?.name}`}</h1>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <section>
          <h2>Connection</h2>
          <label>
            <span>Name</span>
            <input
              required
              value={form.name}
              pattern="[a-z_][a-z0-9_]*"
              placeholder="prod"
              onChange={(event) => update({ name: event.target.value })}
            />
            <small className="muted">
              Lowercase letters, digits and underscores. Used in SQL: name.namespace.table
            </small>
          </label>
          <label>
            <span>Type</span>
            <select value="rest" disabled>
              <option value="rest">REST</option>
            </select>
            <small className="muted">Glue, S3 Tables and JDBC come later.</small>
          </label>
          <label>
            <span>URI</span>
            <input
              required
              value={form.uri}
              placeholder="https://catalog.example.com"
              onChange={(event) => update({ uri: event.target.value })}
            />
          </label>
          <label>
            <span>Warehouse</span>
            <input
              value={form.warehouse}
              placeholder="Optional"
              onChange={(event) => update({ warehouse: event.target.value })}
            />
          </label>
        </section>

        <section>
          <h2>Authentication</h2>
          <div className="segmented">
            {(
              [
                ["none", "None"],
                ["oauth2", "OAuth2 client"],
                ["token", "Bearer token"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={form.auth === value ? "active" : ""}
                onClick={() => update({ auth: value })}
              >
                {label}
              </button>
            ))}
          </div>
          {form.auth === "oauth2" && (
            <>
              {secretInput("credential", "Credential", "client_id:client_secret")}
              <label>
                <span>Token endpoint</span>
                <input
                  value={form.oauthServer}
                  placeholder="Optional; defaults to the catalog's"
                  onChange={(event) => update({ oauthServer: event.target.value })}
                />
              </label>
              <label>
                <span>Scope</span>
                <input
                  value={form.scope}
                  placeholder="Optional"
                  onChange={(event) => update({ scope: event.target.value })}
                />
              </label>
            </>
          )}
          {form.auth === "token" && secretInput("token", "Token")}
        </section>

        <section>
          <h2>Storage (S3)</h2>
          <p className="muted small">
            Leave empty when the catalog vends credentials or the environment provides them.
          </p>
          <label>
            <span>Endpoint</span>
            <input
              value={form.s3Endpoint}
              placeholder="Optional, e.g. http://localhost:9000"
              onChange={(event) => update({ s3Endpoint: event.target.value })}
            />
          </label>
          <label>
            <span>Region</span>
            <input
              value={form.s3Region}
              placeholder="Optional, e.g. us-east-1"
              onChange={(event) => update({ s3Region: event.target.value })}
            />
          </label>
          {secretInput("s3.access-key-id", "Access key ID")}
          {secretInput("s3.secret-access-key", "Secret access key")}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.s3PathStyle}
              onChange={(event) => update({ s3PathStyle: event.target.checked })}
            />
            <span>Path-style access (MinIO and most self-hosted storage)</span>
          </label>
        </section>

        <section>
          <h2>Additional properties</h2>
          <p className="muted small">
            Passed to the catalog as-is. Keys that look like credentials are stored encrypted.
          </p>
          {form.extra.map((row, index) => (
            <div className="kv-row" key={index}>
              <input
                value={row.key}
                placeholder="key"
                onChange={(event) => {
                  const extra = [...form.extra];
                  extra[index] = { ...row, key: event.target.value };
                  update({ extra });
                }}
              />
              <input
                value={row.value}
                placeholder="value"
                onChange={(event) => {
                  const extra = [...form.extra];
                  extra[index] = { ...row, value: event.target.value };
                  update({ extra });
                }}
              />
              <button
                type="button"
                className="link"
                onClick={() => update({ extra: form.extra.filter((_, i) => i !== index) })}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            onClick={() => update({ extra: [...form.extra, { key: "", value: "" }] })}
          >
            Add property
          </button>
          {stored.filter((key) => !KNOWN_SECRETS.includes(key)).length > 0 && (
            <p className="muted small">
              Other stored secrets:{" "}
              {stored.filter((key) => !KNOWN_SECRETS.includes(key)).join(", ")}
            </p>
          )}
        </section>

        {testResult && (
          <div className={`notice ${testResult.ok ? "ok" : "bad"}`}>
            {testResult.ok
              ? `Connected. ${testResult.namespaces ?? 0} top-level namespace${testResult.namespaces === 1 ? "" : "s"}.`
              : testResult.error}
          </div>
        )}
        {save.isError && <div className="notice bad">{errorMessage(save.error)}</div>}

        <div className="actions">
          <button type="button" className="secondary" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? "Testing…" : "Test connection"}
          </button>
          <button type="submit" className="primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
          {id !== undefined && (
            <button
              type="button"
              className="danger"
              disabled={remove.isPending}
              onClick={() => {
                if (confirm(`Remove catalog ${existing.data?.name} from BergPilot? The catalog itself is not touched.`)) {
                  remove.mutate();
                }
              }}
            >
              Remove
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
