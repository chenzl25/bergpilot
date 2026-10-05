const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatNumber(value: number | string | undefined | null): string {
  if (value === undefined || value === null || value === "") return "—";
  const number = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(number) ? number.toLocaleString() : String(value);
}

export function formatTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Relative age such as "3 min ago", for timestamps in milliseconds. */
export function formatAge(ms: number, now = Date.now()): string {
  const seconds = Math.round((now - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Path segments for a table page: namespace levels, then the table name. */
export function tablePath(catalogId: number, namespace: string[], table: string): string {
  const segments = [...namespace, table].map(encodeURIComponent).join("/");
  return `/catalogs/${catalogId}/tables/${segments}`;
}

/** SQL name of a table; nested namespaces become one quoted identifier. */
export function sqlTableName(catalog: string, namespace: string[], table: string): string {
  const quote = (part: string) => (/^[a-z_][a-z0-9_]*$/.test(part) ? part : `"${part.replace(/"/g, '""')}"`);
  return [catalog, quote(namespace.join(".")), quote(table)].join(".");
}

export function namespacePath(catalogId: number, namespace: string[]): string {
  return `/catalogs/${catalogId}/namespaces/${namespace.map(encodeURIComponent).join("/")}`;
}

/** Path segments after a route's `*`, decoded. */
export function splatSegments(splat: string | undefined): string[] {
  return (splat ?? "").split("/").filter(Boolean).map(decodeURIComponent);
}
