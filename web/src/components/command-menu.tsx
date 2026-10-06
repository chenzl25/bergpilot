// ⌘K: jump to any table, catalog or page, or switch the theme.

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Database, ListChecks, Plus, SquareTerminal, Table2 } from "lucide-react";
import { useTheme } from "next-themes";
import { useNavigate } from "react-router";

import { api } from "@/api/client";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import { THEMES } from "@/components/theme";
import { tablePath } from "@/format";

const CommandMenuContext = createContext<() => void>(() => {});

/** Opens the command menu. */
export function useOpenCommandMenu() {
  return useContext(CommandMenuContext);
}

export function CommandMenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <CommandMenuContext.Provider value={() => setOpen(true)}>
      {children}
      <CommandMenu open={open} onOpenChange={setOpen} />
    </CommandMenuContext.Provider>
  );
}

function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const { setTheme } = useTheme();
  const catalogs = useQuery({ queryKey: ["catalogs"], queryFn: api.listCatalogs });
  const names = useQueries({
    queries: (catalogs.data ?? []).map((catalog) => ({
      queryKey: ["names", catalog.id],
      queryFn: () => api.names(catalog.id),
      staleTime: 5 * 60_000,
      retry: false,
      enabled: open,
    })),
  });
  const namesKey = names.map((result) => result.dataUpdatedAt).join(",");
  const tables = useMemo(() => {
    const list: { key: string; catalogId: number; namespace: string[]; table: string; path: string }[] = [];
    (catalogs.data ?? []).forEach((catalog, index) => {
      for (const entry of names[index]?.data?.namespaces ?? []) {
        for (const table of entry.tables) {
          const path = `${catalog.name}.${entry.namespace.join(".")}`;
          list.push({ key: `${path}.${table}`, catalogId: catalog.id, namespace: entry.namespace, table, path });
        }
      }
    });
    return list;
    // `names` is a new array every render; its update times say when data changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogs.data, namesKey]);
  const loading = names.some((result) => result.isFetching && !result.data);

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search" description="Find a table, catalog or page">
      <Command>
        <CommandInput placeholder="Search tables, catalogs and pages…" />
        <CommandList>
          <CommandEmpty>{loading ? "Loading table names…" : "Nothing matches."}</CommandEmpty>
          {tables.length > 0 && (
            <CommandGroup heading="Tables">
              {tables.map((item) => (
                <CommandItem
                  key={item.key}
                  value={item.key}
                  onSelect={() => go(tablePath(item.catalogId, item.namespace, item.table))}
                >
                  <Table2 />
                  <span className="truncate">{item.table}</span>
                  <span className="ml-auto truncate pl-4 font-mono text-xs text-muted-foreground">{item.path}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {loading && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Spinner className="size-3" /> Loading table names…
            </div>
          )}
          {(catalogs.data?.length ?? 0) > 0 && (
            <CommandGroup heading="Catalogs">
              {catalogs.data?.map((catalog) => (
                <CommandItem key={catalog.id} value={`catalog ${catalog.name}`} onSelect={() => go(`/catalogs/${catalog.id}`)}>
                  <Database />
                  {catalog.name}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandSeparator />
          <CommandGroup heading="Go to">
            <CommandItem value="page catalogs home" onSelect={() => go("/")}>
              <Database />
              Catalogs
            </CommandItem>
            <CommandItem value="page sql query editor" onSelect={() => go("/sql")}>
              <SquareTerminal />
              SQL
            </CommandItem>
            <CommandItem value="page jobs schedules history" onSelect={() => go("/jobs")}>
              <ListChecks />
              Jobs
            </CommandItem>
            <CommandItem value="add a catalog new connect" onSelect={() => go("/catalogs/new")}>
              <Plus />
              Add a catalog
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Theme">
            {THEMES.map((theme) => (
              <CommandItem
                key={theme.id}
                value={`theme ${theme.label}`}
                onSelect={() => {
                  setTheme(theme.id);
                  onOpenChange(false);
                }}
              >
                <theme.icon />
                {theme.label} theme
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
