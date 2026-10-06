import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, KeyRound, ListChecks, Plus, Search, SquareTerminal } from "lucide-react";
import { Link, NavLink, Outlet, useLocation } from "react-router";

import { api, getToken, setToken, UNAUTHORIZED_EVENT } from "@/api/client";
import { CommandMenuProvider, useOpenCommandMenu } from "@/components/command-menu";
import { Explorer } from "@/components/Explorer";
import { useJobWatcher } from "@/components/job-status";
import { ThemeMenu } from "@/components/theme";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { namespacePath, splatSegments } from "@/format";
import { errorMessage } from "@/lib/errors";

export function Layout() {
  const queryClient = useQueryClient();
  const info = useQuery({ queryKey: ["info"], queryFn: api.info });
  const [token, setTokenState] = useState(getToken());
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => {
      setTokenState(null);
      setRejected(true);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (!info.isSuccess) {
    return (
      <Centered>
        {info.isError ? (
          <p className="max-w-md text-center text-sm text-destructive">
            Cannot reach the BergPilot server: {errorMessage(info.error)}
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Connecting…
          </p>
        )}
      </Centered>
    );
  }
  if (info.data.auth_required && !token) {
    return (
      <TokenPrompt
        rejected={rejected}
        onSave={(value) => {
          setToken(value);
          setTokenState(value);
          void queryClient.invalidateQueries();
        }}
      />
    );
  }
  return (
    <CommandMenuProvider>
      <SidebarProvider>
        <AppSidebar version={info.data.version} />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-center" />
            <RouteBreadcrumbs />
          </header>
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </CommandMenuProvider>
  );
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function AppSidebar({ version }: { version: string }) {
  const openCommandMenu = useOpenCommandMenu();
  const activeJobs = useJobWatcher();
  const { pathname } = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();

  // On phones the sidebar is a sheet; close it once a link was followed.
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [pathname, isMobile, setOpenMobile]);

  const nav = [
    { to: "/", label: "Catalogs", icon: Database, active: pathname === "/" },
    { to: "/sql", label: "SQL", icon: SquareTerminal, active: pathname.startsWith("/sql") },
    { to: "/jobs", label: "Jobs", icon: ListChecks, active: pathname.startsWith("/jobs"), badge: activeJobs },
  ];

  return (
    <Sidebar>
      <SidebarHeader className="gap-3">
        <Link to="/" className="flex items-center gap-2 px-1.5 pt-1">
          <img src="/favicon.svg" alt="" className="size-6" />
          <span className="text-[15px] font-semibold tracking-tight">BergPilot</span>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">v{version}</span>
        </Link>
        <button
          type="button"
          onClick={openCommandMenu}
          className="flex h-8 w-full items-center gap-2 rounded-lg border bg-background px-2.5 text-sm text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground dark:bg-input/30"
        >
          <Search className="size-4" />
          <span>Search</span>
          <KbdGroup className="ml-auto">
            <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {nav.map((item) => (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton asChild isActive={item.active} tooltip={item.label}>
                  <NavLink to={item.to}>
                    <item.icon />
                    <span>{item.label}</span>
                  </NavLink>
                </SidebarMenuButton>
                {item.badge ? <SidebarMenuBadge className="text-primary">{item.badge} running</SidebarMenuBadge> : null}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="min-h-0 flex-1">
          <SidebarGroupLabel>Explorer</SidebarGroupLabel>
          <SidebarGroupAction asChild title="Add a catalog">
            <Link to="/catalogs/new">
              <Plus />
              <span className="sr-only">Add a catalog</span>
            </Link>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <Explorer />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <ThemeMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** Where the current page sits: Catalogs › catalog › namespace › table. */
function RouteBreadcrumbs() {
  const { pathname } = useLocation();
  const catalogs = useQuery({ queryKey: ["catalogs"], queryFn: api.listCatalogs });
  const crumbs: { label: string; to?: string; mono?: boolean }[] = [];

  if (pathname === "/sql") crumbs.push({ label: "SQL" });
  else if (pathname === "/jobs") crumbs.push({ label: "Jobs" });
  else {
    crumbs.push({ label: "Catalogs", to: "/" });
    const match = pathname.match(/^\/catalogs\/(\d+|new)(?:\/(namespaces|tables|edit)(?:\/(.*))?)?$/);
    if (match?.[1] === "new") crumbs.push({ label: "Add a catalog" });
    else if (match) {
      const id = Number(match[1]);
      const name = catalogs.data?.find((catalog) => catalog.id === id)?.name ?? "…";
      crumbs.push({ label: name, to: `/catalogs/${id}` });
      if (match[2] === "edit") crumbs.push({ label: "Edit connection" });
      const segments = splatSegments(match[3]);
      const namespace = match[2] === "tables" ? segments.slice(0, -1) : segments;
      namespace.forEach((level, index) =>
        crumbs.push({ label: level, to: namespacePath(id, namespace.slice(0, index + 1)) }),
      );
      if (match[2] === "tables" && segments.length > 0) crumbs.push({ label: segments[segments.length - 1] });
    }
  }
  // The last crumb is the current page.
  const last = crumbs.length - 1;
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((crumb, index) => {
          // On phones only the last two crumbs show.
          const hide = index < last - 1 ? "hidden md:inline-flex" : "";
          return (
            <Fragment key={index}>
              {index > 0 && <BreadcrumbSeparator className={index <= last - 1 ? "hidden md:block" : ""} />}
              <BreadcrumbItem className={`min-w-0 ${hide}`}>
                {index === last || !crumb.to ? (
                  <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild className="truncate">
                    <Link to={crumb.to}>{crumb.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-svh items-center justify-center p-6">{children}</div>;
}

function TokenPrompt({ onSave, rejected }: { onSave: (token: string) => void; rejected: boolean }) {
  const [value, setValue] = useState("");
  return (
    <Centered>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg border bg-muted text-primary">
            <KeyRound className="size-5" />
          </div>
          <CardTitle>Access token</CardTitle>
          <CardDescription>
            This BergPilot server requires the token it was started with (BERGPILOT_TOKEN).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (value.trim()) onSave(value.trim());
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="token">Token</FieldLabel>
                <Input
                  id="token"
                  type="password"
                  autoFocus
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder="Token"
                  aria-invalid={rejected || undefined}
                />
                {rejected && <FieldError>That token was not accepted.</FieldError>}
              </Field>
              <Button type="submit">Continue</Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </Centered>
  );
}
