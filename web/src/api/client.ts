// Typed access to the BergPilot API. Types come from the Rust server via
// ts-rs (src/api/generated); do not edit those files by hand.

import type { CatalogInput } from "./generated/CatalogInput";
import type { CatalogSummary } from "./generated/CatalogSummary";
import type { CatalogTestResult } from "./generated/CatalogTestResult";
import type { FileStats } from "./generated/FileStats";
import type { NamespaceList } from "./generated/NamespaceList";
import type { QueryResult } from "./generated/QueryResult";
import type { ServerInfo } from "./generated/ServerInfo";
import type { TableDetail } from "./generated/TableDetail";
import type { TableList } from "./generated/TableList";

const TOKEN_KEY = "bergpilot.token";
export const UNAUTHORIZED_EVENT = "bergpilot:unauthorized";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/**
 * Move `?token=` from the address bar into storage. Runs before the first
 * render so no request goes out without it.
 */
export function consumeTokenFromUrl() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (!token) return;
  setToken(token);
  url.searchParams.delete("token");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, { ...init, headers });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Fall through with the raw text as the message.
  }
  // Ask for the token again (Layout listens), unless the token changed while
  // this request was in flight.
  if (response.status === 401 && getToken() === token) {
    setToken(null);
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : text || response.statusText;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

/** Namespace levels joined by U+001F, the separator the server expects. */
export function encodeNamespace(levels: string[]): string {
  return encodeURIComponent(levels.join("\u001f"));
}

export const api = {
  info: () => request<ServerInfo>("/info"),

  listCatalogs: () => request<CatalogSummary[]>("/catalogs"),
  getCatalog: (id: number) => request<CatalogSummary>(`/catalogs/${id}`),
  createCatalog: (input: CatalogInput) =>
    request<CatalogSummary>("/catalogs", { method: "POST", body: JSON.stringify(input) }),
  updateCatalog: (id: number, input: CatalogInput) =>
    request<CatalogSummary>(`/catalogs/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteCatalog: (id: number) => request<void>(`/catalogs/${id}`, { method: "DELETE" }),
  testCatalog: (catalog: CatalogInput, id?: number) =>
    request<CatalogTestResult>("/catalogs/test", {
      method: "POST",
      body: JSON.stringify({ id, catalog }),
    }),

  namespaces: (id: number, parent?: string[]) =>
    request<NamespaceList>(
      `/catalogs/${id}/namespaces${parent?.length ? `?parent=${encodeNamespace(parent)}` : ""}`,
    ),
  tables: (id: number, namespace: string[]) =>
    request<TableList>(`/catalogs/${id}/tables?namespace=${encodeNamespace(namespace)}`),
  table: (id: number, namespace: string[], name: string) =>
    request<TableDetail>(
      `/catalogs/${id}/table?namespace=${encodeNamespace(namespace)}&name=${encodeURIComponent(name)}`,
    ),
  files: (id: number, namespace: string[], name: string, snapshotId?: string) =>
    request<FileStats>(
      `/catalogs/${id}/table/files?namespace=${encodeNamespace(namespace)}&name=${encodeURIComponent(name)}` +
        (snapshotId ? `&snapshot_id=${snapshotId}` : ""),
    ),

  query: (sql: string, limit?: number) =>
    request<QueryResult>("/query", { method: "POST", body: JSON.stringify({ sql, limit }) }),
};
