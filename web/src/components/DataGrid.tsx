// Query results: a virtualized grid (up to 10,000 rows) with a sticky header,
// right-aligned numbers, and copy on double-click.

import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Download } from "lucide-react";
import { toast } from "sonner";

import type { QueryColumn } from "@/api/generated/QueryColumn";
import type { QueryResult } from "@/api/generated/QueryResult";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/format";
import { cn } from "@/lib/utils";

const ROW_HEIGHT = 32;
const NUMBER_WIDTH = 52;

/** RFC 4180 CSV; NULL becomes an empty field. */
function toCsv(result: QueryResult): string {
  const field = (value: string | null) =>
    value === null ? "" : /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines = [result.columns.map((column) => field(column.name)).join(",")];
  for (const row of result.rows) lines.push(row.map(field).join(","));
  return lines.join("\r\n") + "\r\n";
}

function downloadCsv(result: QueryResult) {
  const blob = new Blob([toCsv(result)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `bergpilot-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const isNumeric = (column: QueryColumn) => /^(U?Int|Float|Decimal)/.test(column.type);

/** Column widths from the header and the first rows, so scrolling does not reflow. */
function columnWidths(result: QueryResult): number[] {
  const sample = result.rows.slice(0, 200);
  return result.columns.map((column, index) => {
    let chars = Math.max(column.name.length, Math.min(column.type.length, 24));
    for (const row of sample) chars = Math.max(chars, Math.min((row[index] ?? "NULL").length, 64));
    return Math.round(Math.min(Math.max(chars * 7.6 + 28, 80), 460));
  });
}

export function Results({ result }: { result: QueryResult }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {formatNumber(result.rows.length)} row{result.rows.length === 1 ? "" : "s"}
        </span>
        {result.truncated && <span>More rows exist; showing the first ones.</span>}
        <span>{formatNumber(result.elapsed_ms)} ms</span>
        {result.rows.length > 0 && <span className="hidden sm:inline">Double-click a cell to copy it.</span>}
        {result.rows.length > 0 && (
          <Button variant="ghost" size="xs" className="ml-auto" onClick={() => downloadCsv(result)}>
            <Download />
            CSV
          </Button>
        )}
      </div>
      <DataGrid result={result} />
    </div>
  );
}

export function DataGrid({ result, maxHeight = "min(600px, 70vh)" }: { result: QueryResult; maxHeight?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const widths = useMemo(() => columnWidths(result), [result]);
  const numeric = useMemo(() => result.columns.map(isNumeric), [result]);
  const totalWidth = NUMBER_WIDTH + widths.reduce((sum, width) => sum + width, 0);
  const virtualizer = useVirtualizer({
    count: result.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const copy = (value: string | null) => {
    void navigator.clipboard.writeText(value ?? "").then(
      () => toast.success("Copied", { description: value === null ? "NULL (empty)" : value.slice(0, 120) }),
      () => toast.error("Could not copy to the clipboard."),
    );
  };

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <div ref={scrollRef} className="relative overflow-auto" style={{ maxHeight }}>
        <div style={{ width: totalWidth, minWidth: "100%" }}>
          <div className="sticky top-0 z-10 flex border-b bg-muted/80 text-xs backdrop-blur" role="row">
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center justify-end border-r bg-muted px-3 text-muted-foreground"
              style={{ width: NUMBER_WIDTH }}
            >
              #
            </div>
            {result.columns.map((column, index) => (
              <div
                key={index}
                role="columnheader"
                className={cn("flex shrink-0 flex-col justify-center px-3 py-1.5", numeric[index] && "items-end")}
                style={{ width: widths[index] }}
                title={`${column.name}: ${column.type}`}
              >
                <span className="max-w-full truncate font-medium text-foreground">{column.name}</span>
                <span className="max-w-full truncate font-mono text-[10px] text-muted-foreground">{column.type}</span>
              </div>
            ))}
          </div>
          {result.rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No rows.</p>
          ) : (
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = result.rows[item.index];
                return (
                  <div
                    key={item.key}
                    role="row"
                    className="group/row absolute left-0 flex w-full border-b border-border/60 hover:bg-muted/50"
                    style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
                  >
                    <div
                      className="sticky left-0 flex shrink-0 items-center justify-end border-r bg-card px-3 text-xs text-muted-foreground tabular-nums group-hover/row:bg-muted"
                      style={{ width: NUMBER_WIDTH }}
                    >
                      {item.index + 1}
                    </div>
                    {row.map((value, index) => (
                      <div
                        key={index}
                        role="cell"
                        className={cn(
                          "shrink-0 cursor-default truncate px-3 font-mono text-[12.5px] leading-8 select-text",
                          numeric[index] && "text-right tabular-nums",
                        )}
                        style={{ width: widths[index] }}
                        title={value ?? "NULL"}
                        onDoubleClick={() => copy(value)}
                      >
                        {value === null ? <span className="text-muted-foreground/70 italic">NULL</span> : value}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
