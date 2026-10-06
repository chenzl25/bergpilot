import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Pencil, Plug, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { api } from "@/api/client";
import type { CatalogInput } from "@/api/generated/CatalogInput";
import type { CatalogKind } from "@/api/generated/CatalogKind";
import type { CatalogSummary } from "@/api/generated/CatalogSummary";
import type { CatalogTestResult } from "@/api/generated/CatalogTestResult";
import { useConfirm } from "@/components/confirm";
import { ErrorNotice, Page, PageHeader, PageSkeleton } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field as FormField, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { detectAuth, type Field, knownKeys, LAYOUTS, STORAGE_FIELDS } from "@/pages/catalogFields";

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


/** One block of the form: a heading, an optional note, and its fields. */
function FormSection(props: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-x-10 gap-y-4 border-b py-8 first:pt-2 last:border-b-0 md:grid-cols-[220px_1fr]">
      <div>
        <h2 className="text-sm font-semibold">{props.title}</h2>
        {props.description && <p className="mt-1 text-sm text-muted-foreground">{props.description}</p>}
      </div>
      <FieldGroup className="gap-5">{props.children}</FieldGroup>
    </section>
  );
}

export function CatalogFormPage() {
  const params = useParams();
  const id = params.id ? Number(params.id) : undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
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
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries();
      toast.success(id === undefined ? `Catalog ${saved.name} added` : `Catalog ${saved.name} saved`);
      navigate(`/catalogs/${saved.id}`);
    },
  });
  const test = useMutation({
    mutationFn: () => api.testCatalog(toInput(form, stored), id),
    onSuccess: setTestResult,
    onError: (error) => setTestResult({ ok: false, error: errorMessage(error) }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCatalog(id!),
    onSuccess: () => {
      toast.success(`Catalog ${existing.data?.name} removed`);
      // Drop it from the list first so the explorer and this page unmount
      // instead of refetching a catalog that no longer exists.
      queryClient.setQueryData<CatalogSummary[]>(["catalogs"], (list) => list?.filter((item) => item.id !== id));
      navigate("/");
      queryClient.removeQueries({ predicate: (query) => query.queryKey[1] === id && query.queryKey[0] !== "jobs" });
      for (const key of ["catalogs", "jobs", "schedules"]) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });

  if (id !== undefined && existing.isPending) return <PageSkeleton />;
  if (existing.isError) {
    return (
      <Page>
        <ErrorNotice error={existing.error} />
      </Page>
    );
  }

  const layout = LAYOUTS[form.kind];
  const authMode = layout.auth.find((mode) => mode.id === form.auth) ?? layout.auth[0];
  const kinds = info.data?.catalog_kinds ?? (["rest"] as CatalogKind[]);

  const renderField = (field: Field) => {
    const inputId = `catalog-${field.key}`;
    if (field.checkbox) {
      return (
        <FormField key={field.key} orientation="horizontal">
          <Checkbox
            id={inputId}
            checked={form.values[field.key] === "true"}
            onCheckedChange={(checked) => setValue(field.key, checked === true ? "true" : "")}
          />
          <FieldLabel htmlFor={inputId} className="font-normal">
            {field.label}
          </FieldLabel>
        </FormField>
      );
    }
    if (field.secret) {
      const isStored = stored.includes(field.key) && !form.cleared.includes(field.key);
      return (
        <FormField key={field.key}>
          <FieldLabel htmlFor={inputId}>{field.label}</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id={inputId}
              type="password"
              autoComplete="off"
              value={form.secrets[field.key] ?? ""}
              placeholder={isStored ? "Stored. Leave blank to keep it." : (field.placeholder ?? "")}
              onChange={(event) => setSecret(field.key, event.target.value)}
            />
            {isStored && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="xs"
                  onClick={() => update({ cleared: [...form.cleared, field.key] })}
                  aria-label={`Remove stored ${field.label}`}
                >
                  Remove
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          {field.hint && <FieldDescription>{field.hint}</FieldDescription>}
        </FormField>
      );
    }
    return (
      <FormField key={field.key}>
        <FieldLabel htmlFor={inputId}>
          {field.label}
          {field.required && <span className="text-destructive">*</span>}
        </FieldLabel>
        <Input
          id={inputId}
          required={field.required}
          value={form.values[field.key] ?? ""}
          placeholder={field.placeholder}
          onChange={(event) => setValue(field.key, event.target.value)}
        />
        {field.hint && <FieldDescription>{field.hint}</FieldDescription>}
      </FormField>
    );
  };

  const otherSecrets = stored.filter((key) => !knownKeys(form.kind).has(key));

  return (
    <Page className="max-w-4xl">
      <PageHeader
        icon={id === undefined ? Plus : Pencil}
        title={id === undefined ? "Add a catalog" : `Edit ${existing.data?.name}`}
        meta="BergPilot keeps the connection in its own database. Secrets are encrypted and never sent back to the browser."
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="rounded-xl border bg-card px-5 shadow-xs md:px-6">
          <FormSection title="Catalog" description={layout.description}>
            <FormField>
              <FieldLabel htmlFor="catalog-name">
                Name<span className="text-destructive">*</span>
              </FieldLabel>
              <Input
                id="catalog-name"
                required
                value={form.name}
                pattern="[a-z_][a-z0-9_]*"
                placeholder="prod"
                onChange={(event) => update({ name: event.target.value })}
              />
              <FieldDescription>Lowercase letters, digits and underscores. Used in SQL: name.namespace.table</FieldDescription>
            </FormField>
            <FormField>
              <FieldLabel>Type</FieldLabel>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" role="radiogroup" aria-label="Type">
                {kinds.map((kind) => {
                  const item = LAYOUTS[kind];
                  const selected = form.kind === kind;
                  return (
                    <button
                      key={kind}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={id !== undefined && !selected}
                      onClick={() => {
                        update({ kind, auth: LAYOUTS[kind].auth[0].id });
                        setTestResult(null);
                      }}
                      className={cn(
                        "flex flex-col items-start gap-2 rounded-lg border p-3 text-left text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40",
                        selected
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "hover:border-primary/40 hover:bg-accent/40",
                      )}
                    >
                      <item.icon className={cn("size-5", selected ? "text-primary" : "text-muted-foreground")} />
                      <span className="font-medium">{item.label}</span>
                    </button>
                  );
                })}
              </div>
              {id !== undefined && <FieldDescription>The type of a saved catalog cannot change.</FieldDescription>}
            </FormField>
            {layout.connection.map(renderField)}
          </FormSection>

          {layout.auth.length > 1 && (
            <FormSection
              title={layout.authTitle}
              description={
                authMode.id === "default"
                  ? "Uses the environment, ~/.aws, or the instance role of the machine BergPilot runs on."
                  : undefined
              }
            >
              <ToggleGroup
                type="single"
                variant="outline"
                value={form.auth}
                onValueChange={(value) => value && update({ auth: value })}
                className="w-fit"
              >
                {layout.auth.map((mode) => (
                  <ToggleGroupItem key={mode.id} value={mode.id}>
                    {mode.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {authMode.fields.map(renderField)}
            </FormSection>
          )}

          <FormSection title="Storage (S3)" description={layout.storageNote}>
            {STORAGE_FIELDS.map(renderField)}
          </FormSection>

          <FormSection
            title="Additional properties"
            description="Passed to the catalog as-is. Keys that look like credentials are stored encrypted."
          >
            {form.extra.map((row, index) => (
              <div className="flex items-center gap-2" key={index}>
                <Input
                  className="font-mono text-[13px]"
                  value={row.key}
                  placeholder="key"
                  aria-label="Property key"
                  onChange={(event) => {
                    const extra = [...form.extra];
                    extra[index] = { ...row, key: event.target.value };
                    update({ extra });
                  }}
                />
                <Input
                  className="font-mono text-[13px]"
                  value={row.value}
                  placeholder="value"
                  aria-label="Property value"
                  onChange={(event) => {
                    const extra = [...form.extra];
                    extra[index] = { ...row, value: event.target.value };
                    update({ extra });
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove property"
                  onClick={() => update({ extra: form.extra.filter((_, i) => i !== index) })}
                >
                  <X />
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => update({ extra: [...form.extra, { key: "", value: "" }] })}
              >
                <Plus />
                Add property
              </Button>
            </div>
            {otherSecrets.length > 0 && (
              <FieldDescription>Other stored secrets: {otherSecrets.join(", ")}</FieldDescription>
            )}
          </FormSection>
        </div>

        <div className="mt-6 flex flex-col gap-4">
          {testResult &&
            (testResult.ok ? (
              <Alert className="border-success/40 bg-success/5">
                <CircleCheck className="text-success" />
                <AlertTitle>Connected</AlertTitle>
                <AlertDescription>
                  {testResult.namespaces ?? 0} top-level namespace{testResult.namespaces === 1 ? "" : "s"}.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>Cannot connect</AlertTitle>
                <AlertDescription className="break-words">{testResult.error}</AlertDescription>
              </Alert>
            ))}
          {save.isError && <ErrorNotice title="Could not save" error={save.error} />}
          <div className="flex flex-wrap items-center gap-2">
            {id !== undefined && (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={remove.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Remove catalog ${existing.data?.name}?`,
                    description: "BergPilot forgets the connection, its schedules and job history. The catalog itself is not touched.",
                    confirmLabel: "Remove",
                    destructive: true,
                  });
                  if (ok) remove.mutate();
                }}
              >
                <Trash2 />
                Remove
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                {test.isPending ? <Spinner /> : <Plug />}
                {test.isPending ? "Testing…" : "Test connection"}
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending && <Spinner />}
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      </form>
    </Page>
  );
}
