import { Link } from "react-router-dom";
import { ChevronRight, Folder } from "lucide-react";
import type { SecretPathFolder } from "./secret-path";
import type { ComponentProps, ReactNode } from "react";
import type { SecretStatus } from "@paperclipai/shared";
import { Copy, KeyRound, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PageTabBar } from "@/components/PageTabBar";
import { cn } from "@/lib/utils";

/** Shared Secrets presentation. Callers retain their own data and mutation authority. */
export function SecretCollectionToolbar({ label, search, onSearchChange, placeholder, searchLabel, searching, viewMode, onViewModeChange, filters, children }: {
  label: string; search: string; onSearchChange: (value: string) => void; placeholder: string; searchLabel: string;
  searching: boolean; viewMode: "folders" | "flat"; onViewModeChange: (mode: "folders" | "flat") => void;
  filters?: ReactNode; children: ReactNode;
}) {
  return <div data-canonical-toolbar="secrets" role="toolbar" aria-label={label} className="flex flex-wrap items-center gap-2">
    <div className="relative w-48 sm:w-64 md:w-80">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input value={search} onChange={event => onSearchChange(event.target.value)} placeholder={placeholder}
        className="pl-7 text-xs sm:text-sm" aria-label={searchLabel} data-page-search-target="true" />
    </div>
    {filters}
    <div role="group" aria-label="View mode" className={cn("design-view-toggle inline-flex items-center rounded-md border border-border", searching && "opacity-50")}>
      {(["folders", "flat"] as const).map(mode => <button key={mode} type="button" aria-pressed={viewMode === mode} disabled={searching}
        onClick={() => onViewModeChange(mode)} className={cn("rounded-sm px-2.5 py-1 text-xs font-medium capitalize transition-colors disabled:cursor-not-allowed",
          viewMode === mode ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>{mode}</button>)}
    </div>
    {children}
  </div>;
}

export function SecretCollectionHeader({ name = "Secret", version = "Version / coverage" }: { name?: string; version?: string }) {
  return <div role="row" className="grid grid-cols-(--gtc-54) items-center gap-3 bg-muted/40 px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
    {[name, "Status", version, "Updated"].map(label => <div key={label} role="columnheader" className="font-medium">{label}</div>)}
    <div role="columnheader" className="sr-only">Actions</div>
  </div>;
}

export function SecretCollectionRow({ selected, onOpen, children, label }: { selected: boolean; onOpen: () => void; children: ReactNode; label?: string }) {
  return <div role="row" aria-label={label} className={cn("grid cursor-pointer grid-cols-(--gtc-54) items-center gap-3 text-sm border-b border-border/60 px-3 py-3 hover:bg-accent/40", selected && "bg-accent/60")}
    onClick={onOpen} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(); } }} tabIndex={0}>
    {children}
  </div>;
}

export function SecretCollectionCard({ selected, onOpen, children }: { selected: boolean; onOpen: () => void; children: ReactNode }) {
  return <div role="button" tabIndex={0} className={cn("cursor-pointer rounded-md border border-border bg-background p-3 hover:bg-accent/30", selected && "bg-accent/60")}
    onClick={onOpen} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(); } }}>{children}</div>;
}

export function SecretStatusBadge({ status }: { status: SecretStatus }) {
  const text = status === "active" ? "text-emerald-700 dark:text-emerald-300" : status === "disabled" ? "text-amber-700 dark:text-amber-300" : status === "deleted" ? "text-destructive" : "text-muted-foreground";
  const dot = status === "active" ? "bg-emerald-500" : status === "disabled" ? "bg-amber-500" : status === "deleted" ? "bg-destructive" : "bg-muted-foreground";
  return <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", text)}><span className={cn("h-1.5 w-1.5 rounded-full", dot)} aria-hidden="true" />{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}

export function SecretMetaChip({ children }: { children: ReactNode }) {
  return <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-(length:--text-micro) text-muted-foreground">{children}</span>;
}

export function formatSecretRelative(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  if (diff < 0) return date.toLocaleString();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : date.toLocaleDateString();
}

export function SecretUpdatedWithTooltip({ updatedAt, tooltip }: { updatedAt: Date | string | null | undefined; tooltip: string }) {
  return <Tooltip><TooltipTrigger asChild><span aria-label={tooltip} className="inline-flex cursor-help border-b border-dotted border-muted-foreground/60 text-xs text-muted-foreground">{formatSecretRelative(updatedAt)}</span></TooltipTrigger>
    <TooltipContent className="max-w-72 whitespace-pre-wrap">{tooltip}</TooltipContent></Tooltip>;
}

export function SecretDetailsSheetContent(props: ComponentProps<typeof SheetContent>) {
  return <SheetContent {...props} className={cn("w-full sm:max-w-xl flex flex-col gap-0", props.className)} />;
}
export function SecretDetailsHeader({ name, status, description, identifier, onCopyIdentifier, children }: {
  name: string; status: SecretStatus; description: string; identifier: string; onCopyIdentifier: () => void; children: ReactNode;
}) {
  return <SheetHeader className="space-y-3"><SheetTitle className="flex min-w-0 items-center gap-2 pr-8 text-base">
    <KeyRound className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{name}</span><span className="shrink-0"><SecretStatusBadge status={status} /></span>
  </SheetTitle><SheetDescription className="sr-only">{description}</SheetDescription>
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/20 px-2 py-1.5"><code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{identifier}</code>
      <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={onCopyIdentifier}><Copy className="mr-1 h-3.5 w-3.5" /> Copy</Button></div>
    <div className="flex flex-wrap gap-1.5">{children}</div>
  </SheetHeader>;
}
export function SecretDetailsActions({ children }: { children: ReactNode }) { return <div className="flex items-center gap-2 px-4 pb-2">{children}</div>; }
export function SecretDetailsTabBar(props: ComponentProps<typeof PageTabBar>) { return <div className="border-b border-border px-4"><PageTabBar {...props} /></div>; }
export function SecretDetailsBody({ children }: { children: ReactNode }) { return <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">{children}</div>; }

export function SecretCollectionFolder({ folder, to, variant, counts }: {
  folder: SecretPathFolder; to: ComponentProps<typeof Link>["to"]; variant: "table" | "card"; counts: string;
}) {
  return variant === "table" ? <Link to={to} role="row" className="grid grid-cols-(--gtc-54) items-center gap-3 border-b border-border/60 px-3 py-3 hover:bg-accent/40">
    <div role="cell" className="min-w-0"><div className="flex min-w-0 items-center gap-2"><Folder className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate font-medium text-foreground">{folder.name}</span></div><div className="mt-0.5 pl-6 text-xs text-muted-foreground">{counts}</div></div>
    <div role="cell" aria-hidden="true" /><div role="cell" aria-hidden="true" /><div role="cell" aria-hidden="true" /><div role="cell" className="flex justify-end"><ChevronRight className="h-4 w-4 text-muted-foreground" /></div>
  </Link> : <Link to={to} className="flex items-center justify-between gap-2 rounded-md border border-border bg-background p-3 hover:bg-accent/30"><div className="flex min-w-0 items-center gap-2"><Folder className="h-4 w-4 shrink-0 text-muted-foreground" /><div className="min-w-0"><div className="truncate font-medium text-foreground">{folder.name}</div><div className="text-xs text-muted-foreground">{counts}</div></div></div><ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" /></Link>;
}

export function SecretCollectionIdentity({ name, identifier, indicator, metadata }: {
  name: ReactNode; identifier: string; indicator?: ReactNode; metadata: ReactNode;
}) {
  return <div role="cell" className="min-w-0"><div className="flex min-w-0 items-center gap-1.5">{name}{indicator}</div>
    <code className="mt-0.5 block truncate text-(length:--text-micro) text-muted-foreground">{identifier}</code>
    <div className="mt-1">{metadata}</div>
  </div>;
}
