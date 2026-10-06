// Building blocks every page shares: header, sections, stat tiles, key/value
// lists, and loading and error states.

import { type ComponentType, type ReactNode, useState } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errors";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Icon = ComponentType<{ className?: string }>;

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-6 md:px-8", className)}>
      {children}
    </div>
  );
}

export function PageHeader(props: {
  icon?: Icon;
  title: ReactNode;
  /** One line under the title: path, type, timestamps. */
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {props.icon && (
          <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg border bg-card text-primary shadow-xs">
            <props.icon className="size-5" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">{props.title}</h1>
          {props.meta && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {props.meta}
            </div>
          )}
        </div>
      </div>
      {props.actions && <div className="flex flex-wrap items-center gap-2">{props.actions}</div>}
    </header>
  );
}

export function Section(props: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-3", props.className)}>
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{props.title}</h2>
          {props.description && <p className="mt-0.5 text-sm text-muted-foreground">{props.description}</p>}
        </div>
        {props.actions && <div className="flex items-center gap-2">{props.actions}</div>}
      </div>
      {props.children}
    </section>
  );
}

/** A bordered surface for tables and lists. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("overflow-hidden rounded-xl border bg-card shadow-xs", className)}>{children}</div>;
}

export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6", className)}>{children}</div>;
}

export function Stat(props: { label: string; value: ReactNode; hint?: ReactNode; icon?: Icon; title?: string; tone?: "warning" }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-xs" title={props.title}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {props.icon && <props.icon className="size-3.5" />}
        {props.label}
      </div>
      <div
        className={cn(
          "mt-1 truncate text-xl font-semibold tracking-tight tabular-nums",
          props.tone === "warning" && "text-warning",
        )}
      >
        {props.value}
      </div>
      {props.hint && <div className="mt-0.5 truncate text-xs text-muted-foreground">{props.hint}</div>}
    </div>
  );
}

export interface Fact {
  label: string;
  value: ReactNode;
  mono?: boolean;
  /** Text a copy button puts on the clipboard. */
  copy?: string;
}

export function FactList({ facts }: { facts: Fact[] }) {
  return (
    <dl className="divide-y text-sm">
      {facts.map((fact) => (
        <div key={fact.label} className="grid grid-cols-1 gap-1 px-4 py-2.5 sm:grid-cols-[170px_1fr] sm:gap-4">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className={cn("group/fact flex min-w-0 items-center gap-1", fact.mono && "font-mono text-[13px]")}>
            <span className="min-w-0 break-all">{fact.value}</span>
            {fact.copy && <CopyButton value={fact.copy} className="opacity-0 group-hover/fact:opacity-100" />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyButton({ value, className, label = "Copy" }: { value: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className={cn("shrink-0 text-muted-foreground", className)}
          aria-label={label}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              },
              () => toast.error("Could not copy to the clipboard."),
            );
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Spinner />
      {label}
    </div>
  );
}

/** Placeholder blocks shaped like a page while it loads. */
export function PageSkeleton() {
  return (
    <Page>
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-[74px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </Page>
  );
}

export function ErrorNotice({ error, title }: { error: unknown; title?: string }) {
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>{title ?? "Something went wrong"}</AlertTitle>
      <AlertDescription className="break-words">{errorMessage(error)}</AlertDescription>
    </Alert>
  );
}

/** Small colored dot plus label, for statuses and legends. */
export function Dot({ className }: { className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", className)} />;
}
