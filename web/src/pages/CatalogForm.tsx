import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";

import { api } from "../api/client";
import type { CatalogInput } from "../api/generated/CatalogInput";
import type { CatalogKind } from "../api/generated/CatalogKind";
import type { CatalogSummary } from "../api/generated/CatalogSummary";
import type { CatalogTestResult } from "../api/generated/CatalogTestResult";
import { errorMessage } from "../components/Layout";
import { detectAuth, type Field, knownKeys, LAYOUTS, STORAGE_FIELDS } from "./catalogFields";

interface FormState {
  name: string;
  kind: CatalogKind;
  auth: string;
  /** Plain values of the fields the layout shows. */
  values: Record<string, string>;
  /** Secret values typed in this session; blank keeps the stored one. */
  secrets: Record<string, string>;
  /** Stored secrets the user chose to remove. */
  cleared: string[];
  extra: { key: string; value: string }[];
}

function emptyForm(kind: CatalogKind = "rest"): FormState {
  return {
    name: "",
    kind,
    auth: LAYOUTS[kind].auth[0].id,
    values: {},
    secrets: {},
    cleared: [],
    extra: [],
  };
}

function fromSummary(catalog: CatalogSummary): FormState {
  const known = knownKeys(catalog.kind);
  const values: Record<string, string> = {};
  const extra: FormState["extra"] = [];
  for (const [key, value] of Object.entries(catalog.properties)) {
    if (known.has(key)) values[key] = value ?? "";
    else extra.push({ key, value: value ?? "" });
  }
  return {
    ...emptyForm(catalog.kind),
    name: catalog.name,
    auth: detectAuth(catalog.kind, [...Object.keys(catalog.properties), ...catalog.secret_keys]),
    values,
    extra,
  };
}

/** Fields that apply with the current kind and authentication mode. */
function activeFields(form: FormState): Field[] {
  const layout = LAYOUTS[form.kind];
  const mode = layout.auth.find((item) => item.id === form.auth) ?? layout.auth[0];
  return [...layout.connection, ...mode.fields, ...STORAGE_FIELDS];
}

function toInput(form: FormState, stored: string[]): CatalogInput {
  const active = activeFields(form);
  const activeKeys = new Set(active.map((field) => field.key));
  const properties: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of active) {
    if (field.secret) {
      const value = form.secrets[field.key];
      if (value) secrets[field.key] = value;
    } else {
      const value = (form.values[field.key] ?? "").trim();
      if (value) properties[field.key] = value;
    }
  }
  for (const { key, value } of form.extra) {
    if (key.trim() && value.trim()) properties[key.trim()] = value.trim();
  }
  // Secrets of fields that no longer apply (another auth mode or kind) go.
  const known = new Set((Object.keys(LAYOUTS) as CatalogKind[]).flatMap((kind) => [...knownKeys(kind)]));
  const clear = stored.filter(
    (key) => form.cleared.includes(key) || (known.has(key) && !activeKeys.has(key)),
  );
  return { name: form.name.trim(), kind: form.kind, properties, secrets, clear_secrets: clear };
}

export function CatalogFormPage() {
  const params = useParams();
  const id = params.id ? Number(params.id) : undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const info = useQuery({ queryKey: ["info"], queryFn: api.info });
  const existing = useQuery({
    queryKey: ["catalog", id],
    queryFn: () => api.getCatalog(id!),
    enabled: id !== undefined,
  });
  const [form, setForm] = useState<FormState>(emptyForm());
  const [testResult, setTestResult] = useState<CatalogTestResult | null>(null);
  const stored = existing.data?.secret_keys ?? [];

  useEffect(() => {
    setForm(existing.data ? fromSummary(existing.data) : emptyForm());
    setTestResult(null);
  }, [existing.data, id]);

  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));
  const setValue = (key: string, value: string) =>
    setForm((current) => ({ ...current, values: { ...current.values, [key]: value } }));
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

  const layout = LAYOUTS[form.kind];
  const authMode = layout.auth.find((mode) => mode.id === form.auth) ?? layout.auth[0];
  const kinds = info.data?.catalog_kinds ?? (["rest"] as CatalogKind[]);

  const renderField = (field: Field) => {
    if (field.checkbox) {
      return (
        <label className="checkbox" key={field.key}>
          <input
            type="checkbox"
            checked={form.values[field.key] === "true"}
            onChange={(event) => setValue(field.key, event.target.checked ? "true" : "")}
          />
          <span>{field.label}</span>
        </label>
      );
    }
    if (field.secret) {
      const isStored = stored.includes(field.key) && !form.cleared.includes(field.key);
      return (
        <label key={field.key}>
          <span>{field.label}</span>
          <div className="secret-row">
            <input
              type="password"
              autoComplete="off"
              value={form.secrets[field.key] ?? ""}
              placeholder={isStored ? "Stored — leave blank to keep" : field.placeholder ?? ""}
              onChange={(event) => setSecret(field.key, event.target.value)}
            />
            {isStored && (
              <button
                type="button"
                className="link"
                onClick={() => update({ cleared: [...form.cleared, field.key] })}
              >
                Remove
              </button>
            )}
          </div>
          {field.hint && <small className="muted">{field.hint}</small>}
        </label>
      );
    }
    return (
      <label key={field.key}>
        <span>{field.label}</span>
        <input
          required={field.required}
          value={form.values[field.key] ?? ""}
          placeholder={field.placeholder}
          onChange={(event) => setValue(field.key, event.target.value)}
        />
        {field.hint && <small className="muted">{field.hint}</small>}
      </label>
    );
  };

  const otherSecrets = stored.filter((key) => !knownKeys(form.kind).has(key));

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
          <h2>Catalog</h2>
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
            <select
              value={form.kind}
              disabled={id !== undefined}
              onChange={(event) => {
                const kind = event.target.value as CatalogKind;
                update({ kind, auth: LAYOUTS[kind].auth[0].id });
                setTestResult(null);
              }}
            >
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {LAYOUTS[kind].label}
                </option>
              ))}
            </select>
            <small className="muted">{layout.description}</small>
          </label>
          {layout.connection.map(renderField)}
        </section>

        {layout.auth.length > 1 && (
          <section>
            <h2>{layout.authTitle}</h2>
            <div className="segmented">
              {layout.auth.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={form.auth === mode.id ? "active" : ""}
                  onClick={() => update({ auth: mode.id })}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            {authMode.id === "default" && (
              <p className="muted small">
                Uses the environment, ~/.aws, or the instance role of the machine BergPilot runs on.
              </p>
            )}
            {authMode.fields.map(renderField)}
          </section>
        )}

        <section>
          <h2>Storage (S3)</h2>
          <p className="muted small">{layout.storageNote}</p>
          {STORAGE_FIELDS.map(renderField)}
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
          {otherSecrets.length > 0 && (
            <p className="muted small">Other stored secrets: {otherSecrets.join(", ")}</p>
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
                if (
                  confirm(
                    `Remove catalog ${existing.data?.name} from BergPilot? The catalog itself is not touched.`,
                  )
                ) {
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
