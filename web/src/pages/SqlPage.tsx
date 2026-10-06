import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import CodeMirror, { EditorView, keymap, Prec } from "@uiw/react-codemirror";
import { sql as sqlLanguage } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { History, Play, SquareTerminal, TriangleAlert } from "lucide-react";
import { useSearchParams } from "react-router";

import { api } from "@/api/client";
import type { CatalogNames } from "@/api/generated/CatalogNames";
import { Results } from "@/components/DataGrid";
import { Page, PageHeader } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/errors";

const STORAGE_KEY = "bergpilot.sql";
const HISTORY_KEY = "bergpilot.sql-history";
const HISTORY_SIZE = 30;

function loadHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function remember(statement: string): string[] {
  const history = [statement, ...loadHistory().filter((item) => item !== statement)].slice(0, HISTORY_SIZE);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  return history;
}

const DEFAULT_SQL = `-- Tables are named catalog.namespace.table.
-- Metadata tables: catalog.namespace."table$snapshots", $history, $refs,
-- $manifests, $files and $partitions. Time travel: "table@<snapshot id>"
-- or "table@<branch or tag>".
SELECT 1 AS ok`;

type SqlSchema = { [name: string]: SqlSchema | readonly string[] };

const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const quoteIdentifier = (name: string) => (PLAIN_IDENTIFIER.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

/**
 * catalog → namespace → table, the shape @codemirror/lang-sql completes.
 * lang-sql reads a dot in a key as nesting, so multi-level namespaces (one
 * quoted identifier with dots in SQL) are left out of completion.
 */
function completionSchema(catalogs: { name: string; names?: CatalogNames }[]): SqlSchema {
  const schema: SqlSchema = {};
  for (const catalog of catalogs) {
    const namespaces: SqlSchema = {};
    for (const entry of catalog.names?.namespaces ?? []) {
      if (entry.namespace.length !== 1 || entry.namespace[0].includes(".")) continue;
      const tables: SqlSchema = {};
      for (const table of entry.tables) tables[quoteIdentifier(table)] = [];
      namespaces[quoteIdentifier(entry.namespace[0])] = tables;
    }
    schema[catalog.name] = namespaces;
  }
  return schema;
}

// Editor colors come from the app's CSS variables, so one theme serves light and dark.
const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--foreground)", fontSize: "13px", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--primary)", padding: "10px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--accent) 45%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklch, var(--primary) 24%, transparent) !important",
  },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in oklch, var(--primary) 18%, transparent)", outline: "none" },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    overflow: "hidden",
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.12)",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "12.5px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-completionDetail": { color: "var(--muted-foreground)" },
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: "var(--primary)", fontWeight: "500" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--chart-2)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--chart-3)" },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [tags.typeName, tags.standard(tags.name)], color: "var(--chart-4)" },
  { tag: [tags.special(tags.name), tags.quote], color: "var(--chart-2)" },
  { tag: tags.punctuation, color: "var(--muted-foreground)" },
]);

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function SqlPage() {
  const [search, setSearch] = useSearchParams();
  const [text, setText] = useState(() => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_SQL);

  // "Query" buttons elsewhere open this page with ?q=.
  useEffect(() => {
    const q = search.get("q");
    if (q) {
      setText(q);
      setSearch({}, { replace: true });
    }
  }, [search, setSearch]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, text);
  }, [text]);

  const [history, setHistory] = useState(loadHistory);
  const run = useMutation({
    mutationFn: (statement: string) => api.query(statement),
    onSuccess: (_, statement) => setHistory(remember(statement.trim())),
  });
  const execute = useCallback(() => {
    if (text.trim() && !run.isPending) run.mutate(text);
  }, [run, text]);

  const catalogs = useQuery({ queryKey: ["catalogs"], queryFn: api.listCatalogs });
  const names = useQueries({
    queries: (catalogs.data ?? []).map((catalog) => ({
      queryKey: ["names", catalog.id],
      queryFn: () => api.names(catalog.id),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const namesKey = names.map((result) => result.dataUpdatedAt).join(",");
  const schema = useMemo(
    () =>
      completionSchema(
        (catalogs.data ?? []).map((catalog, index) => ({ name: catalog.name, names: names[index]?.data })),
      ),
    // `names` is a new array every render; its update times say when data changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogs.data, namesKey],
  );

  const extensions = useMemo(
    () => [
      editorTheme,
      syntaxHighlighting(highlight),
      sqlLanguage({ schema }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              execute();
              return true;
            },
          },
        ]),
      ),
    ],
    [execute, schema],
  );

  return (
    <Page>
      <PageHeader
        icon={SquareTerminal}
        title="SQL"
        meta="Read-only queries through Apache DataFusion. Tables are named catalog.namespace.table."
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" disabled={history.length === 0}>
                  <History />
                  History
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[min(560px,90vw)]">
                <DropdownMenuLabel>Recent queries</DropdownMenuLabel>
                {history.map((statement) => (
                  <DropdownMenuItem key={statement} onSelect={() => setText(statement)} title={statement}>
                    <span className="truncate font-mono text-xs">{statement.replace(/\s+/g, " ")}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-muted-foreground"
                  onSelect={() => {
                    localStorage.removeItem(HISTORY_KEY);
                    setHistory([]);
                  }}
                >
                  Clear history
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={execute} disabled={run.isPending}>
              {run.isPending ? <Spinner /> : <Play />}
              {run.isPending ? "Running…" : "Run"}
              <KbdGroup className="ml-1 hidden sm:inline-flex">
                <Kbd className="bg-primary-foreground/15 text-primary-foreground">{isMac ? "⌘" : "Ctrl"}</Kbd>
                <Kbd className="bg-primary-foreground/15 text-primary-foreground">↵</Kbd>
              </KbdGroup>
            </Button>
          </>
        }
      />
      <div className="h-64 min-h-32 resize-y overflow-hidden rounded-xl border bg-card shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
        <CodeMirror
          value={text}
          height="100%"
          className="h-full"
          theme="none"
          extensions={extensions}
          onChange={setText}
          aria-label="SQL editor"
        />
      </div>
      {run.isError && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Query failed</AlertTitle>
          <AlertDescription className="font-mono text-xs break-words whitespace-pre-wrap">
            {errorMessage(run.error)}
          </AlertDescription>
        </Alert>
      )}
      {run.data && !run.isPending && <Results result={run.data} />}
    </Page>
  );
}
