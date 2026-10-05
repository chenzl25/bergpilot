// Observations that suggest maintenance, shared by the namespace and table
// pages. They state facts; the Maintenance tab is where to act on them.

import { formatNumber } from "./format";

export const SMALL_FILE_BYTES = 32 * 1024 * 1024;

export interface TableTotals {
  data_files?: number;
  data_bytes?: number;
  delete_files?: number;
  snapshots: number;
}

export function attention(table: TableTotals): string[] {
  const notes: string[] = [];
  const files = table.data_files ?? 0;
  if (files >= 16 && (table.data_bytes ?? 0) / files < SMALL_FILE_BYTES) notes.push("small files");
  if ((table.delete_files ?? 0) > 0) notes.push(`${formatNumber(table.delete_files)} delete files`);
  if (table.snapshots > 100) notes.push(`${formatNumber(table.snapshots)} snapshots`);
  return notes;
}
