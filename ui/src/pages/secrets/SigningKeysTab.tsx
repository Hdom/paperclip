import { Link, useSearchParams } from "@/lib/router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SecretStatus, SigningKeySummary } from "@paperclipai/shared";
import { signingKeysApi } from "@/api/signing-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet } from "@/components/ui/sheet";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CornerLeftUp, Eye, Filter, Folder, KeyRound, Link2, MoreHorizontal, Pencil, Plus, RefreshCw } from "lucide-react";
import { GitHubAppKeyLifecycle } from "./GitHubAppKeyLifecycle";
import { useGitHubProjectApps } from "@/components/GitHubProjectAppControls";
import { SecretPathName } from "./SecretPathName";
import { buildSecretPathBreadcrumbs, buildSecretPathListing, normalizeSecretPath, validateSecretFolderSegment } from "./secret-path";
import { SecretCollectionToolbar, SecretCollectionIdentity, SecretCollectionFolder, SecretCollectionHeader, SecretCollectionRow, SecretCollectionCard, SecretStatusBadge,
  SecretMetaChip, SecretUpdatedWithTooltip, formatSecretRelative, SecretDetailsSheetContent, SecretDetailsHeader,
  SecretDetailsActions, SecretDetailsTabBar, SecretDetailsBody } from "./SecretCollection";
import { copyTextToClipboard } from "@/lib/clipboard";
import { signingKeyDisplayName, signingKeyTypeLabel } from "./signing-key-presentation";

const EMPTY_KEYS: SigningKeySummary[] = [];
const queryKey = (companyId: string) => ["signing-keys", companyId];
type Action = "import" | "rotate" | "edit" | "move" | "status";

/** Shares Secrets presentation; signing authority remains in dedicated APIs. */
export function SigningKeysTab({ companyId, selection, onSelectionChange }: {
  companyId: string; selection?: string | null; onSelectionChange?: (id: string | null) => void;
}) {
  const client = useQueryClient(), [params, setParams] = useSearchParams();
  const catalog = useQuery({ queryKey: queryKey(companyId), queryFn: () => signingKeysApi.list(companyId) });
  const apps = useGitHubProjectApps(companyId);
  const keys = catalog.data?.keys ?? EMPTY_KEYS;
  const [search, setSearch] = useState(""), [status, setStatus] = useState("all"), [type, setType] = useState("all");
  const [view, setView] = useState<"folders" | "flat" | null>(() => {
    try { const v = localStorage.getItem("paperclip.secrets.viewMode"); return v === "folders" || v === "flat" ? v : null; } catch { return null; }
  });
  const path = normalizeSecretPath(params.get("signingPath") ?? "");
  const searching = Boolean(search.trim());
  const resolvedView = path ? "folders" : view ?? (keys.some(key => signingKeyDisplayName(key).includes("/")) ? "folders" : "flat");
  const folderView = resolvedView === "folders" && !searching;
  const [newFolder, setNewFolder] = useState<string | null>(null), [folderError, setFolderError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null), [detailTab, setDetailTab] = useState("details");
  const [modal, setModal] = useState<Action | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(""), [description, setDescription] = useState(""), [destination, setDestination] = useState("");
  const [targetStatus, setTargetStatus] = useState<"active" | "disabled" | "archived">("disabled");
  const [file, setFile] = useState<File>(), [confirmation, setConfirmation] = useState<string | null>(null);
  const selected = keys.find(key => key.id === (selection === undefined ? selectedId : selection));
  const generic = selected?.type === "generic" && selected.revision !== null;
  const app = selected?.githubApp ? apps.data?.roles.find(row => row.secretId === selected.id) : undefined;
  const events = useQuery({ queryKey: ["signing-key-access", companyId, selected?.id], queryFn: () => signingKeysApi.events(companyId, selected!.id), enabled: !!selected && detailTab === "access" });
  const versions = useQuery({ queryKey: ["signing-key-versions", companyId, selected?.id, selected?.latestVersion], queryFn: () => signingKeysApi.versions(companyId, selected!.id), enabled: !!selected && detailTab === "versions" });
  const identity = JSON.stringify([companyId, modal, selected?.id, selected?.revision, selected?.organizationRevision, selected?.updatedAt, selected?.latestVersion, selected?.status,
    name, description, destination, targetStatus, file?.name, file?.size, file?.lastModified]);
  const currentReview = useRef<string | null>(identity); currentReview.current = identity;
  useEffect(() => { currentReview.current = identity; return () => { currentReview.current = null; }; }, [identity]);
  useEffect(() => { setConfirmation(null); setFile(undefined); }, [companyId, selected?.id, selected?.updatedAt, selected?.latestVersion]);
  useEffect(() => { setModal(null); setSelectedId(null); setSearch(""); setStatus("all"); setType("all"); setError(null); setNewFolder(null); }, [companyId]);
  const confirmed = confirmation === identity;
  const filtered = useMemo(() => keys.filter(key => (status === "all" || key.status === status) && (type === "all" || key.type === type)
    && `${signingKeyDisplayName(key)} ${key.name} ${key.id} ${key.publicFingerprint ?? ""} ${signingKeyTypeLabel(key)}`.toLowerCase().includes(search.trim().toLowerCase())), [keys, search, status, type]);
  const pathRows = useMemo(() => filtered.map(key => ({ id: key.id, kind: "company" as const, secret: { name: signingKeyDisplayName(key) }, key })), [filtered]);
  const listing = useMemo(() => buildSecretPathListing(pathRows, folderView ? path : ""), [pathRows, path, folderView]);
  const rows = folderView ? listing.secrets : pathRows;
  const filterCount = Number(status !== "all") + Number(type !== "all");
  function goToFolder(nextPath: string) { setParams(previous => { const next = new URLSearchParams(previous); const value = normalizeSecretPath(nextPath); next.set("secretsTab", "signing-keys"); if (value) next.set("signingPath", value); else next.delete("signingPath"); return next; }); }
  function open(key: SigningKeySummary, tab = "details") { setSelectedId(key.id); onSelectionChange?.(key.id); setDetailTab(tab); setError(null); }
  function close() { setSelectedId(null); onSelectionChange?.(null); setModal(null); setFile(undefined); setConfirmation(null); setError(null); }
  function start(action: Action, key = selected) {
    if (action === "import") key = undefined;
    if (key) open(key); else { setSelectedId(null); onSelectionChange?.(null); }
    setModal(action); setName(key?.name ?? (folderView && path ? `${path}/` : "")); setDescription(key?.description ?? "");
    setDestination(key ? signingKeyDisplayName(key).split("/").slice(0, -1).join("/") : path);
    setFile(undefined); setConfirmation(null); setError(null);
  }
  async function perform(operation: () => Promise<unknown>) {
    if (!confirmed || busy) return;
    setBusy(true); setError(null);
    try { await operation(); await client.invalidateQueries({ queryKey: queryKey(companyId) }); setModal(null); setFile(undefined); setConfirmation(null); }
    catch { setError("The signing key change could not be confirmed. Reload the key details and review the current version before retrying."); }
    finally { setBusy(false); setConfirmation(null); }
  }
  async function importOrRotate() {
    if (!file || file.size > 16384 || !confirmed) return;
    await perform(async () => {
      const authorized = identity, material = await file.text();
      if (currentReview.current !== authorized) throw new Error("Signing key review changed");
      if (modal === "import") { const key = await signingKeysApi.create(companyId, { name, description, privateKey: material, confirmed: true }); open(key); }
      else if (generic && selected) await signingKeysApi.rotate(companyId, selected.id, { privateKey: material, expectedLatestVersion: selected.latestVersion, expectedRevision: selected.revision!, confirmed: true });
    });
  }
  function menu(key: SigningKeySummary) { return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${signingKeyDisplayName(key)}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-52"><DropdownMenuItem onSelect={() => open(key)}><Eye className="h-4 w-4" />View details</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => open(key, "usage")}><Link2 className="h-4 w-4" />View usage</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => open(key, "versions")}><KeyRound className="h-4 w-4" />Version history</DropdownMenuItem>
      {catalog.data?.canManage && <><DropdownMenuSeparator />{key.canOrganize && <DropdownMenuItem onSelect={() => start("move", key)}><Folder className="h-4 w-4" />Move to folder…</DropdownMenuItem>}
        {(key.type === "github_app" || (key.type === "generic" && key.revision !== null)) && <DropdownMenuItem onSelect={() => start("rotate", key)}><RefreshCw className="h-4 w-4" />Rotate key…</DropdownMenuItem>}
        {key.type === "generic" && key.revision !== null && <><DropdownMenuItem onSelect={() => start("edit", key)}><Pencil className="h-4 w-4" />Edit details…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { start("status", key); setTargetStatus(key.status === "active" ? "disabled" : "active"); }}>{key.status === "active" ? "Disable" : "Enable"} key…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { start("status", key); setTargetStatus("archived"); }}>Archive key…</DropdownMenuItem></>}
      </>}
    </DropdownMenuContent></DropdownMenu>; }
  function folderRows(variant: "table" | "card") { return folderView ? listing.folders.map(folder => {
    const next = new URLSearchParams(params); next.set("signingPath", folder.path); next.set("secretsTab", "signing-keys");
    const counts = `${folder.secretCount} ${folder.secretCount === 1 ? "signing key" : "signing keys"}${folder.folderCount ? ` · ${folder.folderCount} ${folder.folderCount === 1 ? "folder" : "folders"}` : ""}`;
    return <SecretCollectionFolder key={folder.path} folder={folder} to={{ search: `?${next}` }} variant={variant} counts={counts} />;
  }) : null; }
  function keyName(key: SigningKeySummary) { return <SecretPathName name={signingKeyDisplayName(key)} basePath={folderView ? path : ""} className="text-sm" />; }
  function version(key: SigningKeySummary) { const usage = apps.data?.roles.find(row => row.secretId === key.id); return <><span className="font-mono text-foreground">v{key.latestVersion}</span><span className="text-muted-foreground"> · {usage ? `GitHub · ${usage.role}` : key.type === "generic" ? "No connected service" : "Managed service"}</span></>; }
  const filters = <Popover><PopoverTrigger asChild><Button variant="outline" size="sm"><Filter className="mr-1 h-3.5 w-3.5" />Filters{filterCount ? ` (${filterCount})` : ""}</Button></PopoverTrigger><PopoverContent align="start" className="w-72 space-y-3">
    <label className="block text-sm">Status<select className="mt-1 block w-full rounded-md border border-input bg-background p-2 text-sm" value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option>{["active", "disabled", "archived"].map(value => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</select></label>
    <label className="block text-sm">Type<select className="mt-1 block w-full rounded-md border border-input bg-background p-2 text-sm" value={type} onChange={event => setType(event.target.value)}><option value="all">All types</option><option value="github_app">GitHub App</option><option value="generic">Generic</option><option value="managed">Managed service</option></select></label>
    <Button variant="ghost" size="sm" onClick={() => { setStatus("all"); setType("all"); }}>Reset filters</Button>
  </PopoverContent></Popover>;
  const publicDescription = "Signing keys let Paperclip sign requests for connected services. Private values stay in encrypted storage and are never delivered to agents.";
  return <TooltipProvider><div className="flex flex-col gap-3">
    <div className="rounded-md border border-border p-3 text-sm text-muted-foreground">{publicDescription}</div>
    <SecretCollectionToolbar label="Signing key controls" search={search} onSearchChange={setSearch} placeholder="Search by name, type, fingerprint" searchLabel="Search signing keys"
      searching={searching} viewMode={searching ? "flat" : resolvedView} onViewModeChange={value => { setView(value); try { localStorage.setItem("paperclip.secrets.viewMode", value); } catch {} if (value === "flat") goToFolder(""); }} filters={filters}>
      {catalog.data?.canManage && <>{folderView && <Button variant="outline" size="sm" onClick={() => { setNewFolder(""); setFolderError(null); }}><Folder className="mr-1 h-3.5 w-3.5" />New folder</Button>}
        <Button data-toolbar-primary size="sm" onClick={() => start("import")}><Plus className="mr-1 h-3.5 w-3.5" />New signing key</Button></>}
    </SecretCollectionToolbar>
    {newFolder !== null && folderView && <form className="flex flex-wrap items-start gap-2" aria-label="Create folder" onSubmit={event => { event.preventDefault(); const problem = validateSecretFolderSegment(newFolder); if (problem) { setFolderError(problem); return; } goToFolder([path, newFolder.trim()].filter(Boolean).join("/")); setNewFolder(null); }}>
      <label className="min-w-48 sm:max-w-80">Folder name<Input aria-label="Folder name" value={newFolder} onChange={event => setNewFolder(event.target.value)} aria-invalid={!!folderError} /></label><Button type="submit" size="sm">Create folder</Button><Button type="button" size="sm" variant="ghost" onClick={() => setNewFolder(null)}>Cancel</Button>{folderError && <p role="alert">{folderError}</p>}
    </form>}
    {folderView && <nav aria-label="Signing key folders" className="flex flex-wrap items-center gap-1 text-sm"><Button variant="ghost" size="sm" onClick={() => goToFolder("")}>All signing keys</Button>{buildSecretPathBreadcrumbs(path).map(part => <span key={part.path}>/<Button variant="ghost" size="sm" onClick={() => goToFolder(part.path)}>{part.name}</Button></span>)}</nav>}
    {catalog.isPending && <p role="status">Loading signing keys…</p>}{catalog.isError && <div role="alert">Signing keys could not be loaded. <Button variant="link" onClick={() => void catalog.refetch()}>Try again</Button></div>}
    {catalog.data && <div className="@container">
      {!rows.length && (!folderView || !listing.folders.length) ? <div className="py-8 text-center"><h3 className="text-sm font-medium">{searching || filterCount ? "No matching signing keys" : folderView && path ? "This folder is empty" : "No signing keys yet"}</h3><p className="mt-1 text-sm text-muted-foreground">{searching || filterCount ? "Try another search or clear the filters." : "Import a signing key or move an existing key here. Empty folders are kept only while you navigate, like regular Secrets."}</p>{(searching || !!filterCount) && <Button variant="ghost" onClick={() => { setSearch(""); setStatus("all"); setType("all"); }}>Clear search and filters</Button>}</div> : <>
        {folderView && path && <Button variant="ghost" size="sm" className="justify-start" onClick={() => goToFolder(path.split("/").slice(0, -1).join("/"))}><CornerLeftUp className="mr-1 h-4 w-4" />Up one folder</Button>}

        <div role="table" aria-label="Signing keys" className="hidden min-w-0 @min-[40rem]:block" data-testid="signing-keys-table-view"><SecretCollectionHeader name="Signing key" version="Version / usage" /><div role="rowgroup">{folderRows("table")}{rows.map(({ key }) => <SecretCollectionRow key={key.id} selected={selected?.id === key.id} onOpen={() => open(key)}>
          <SecretCollectionIdentity name={keyName(key)} identifier={key.id} metadata={<SecretMetaChip>{signingKeyTypeLabel(key)}</SecretMetaChip>} />
          <div role="cell"><SecretStatusBadge status={key.status as SecretStatus} /></div><div role="cell" className="min-w-0 text-xs">{version(key)}</div><div role="cell"><SecretUpdatedWithTooltip updatedAt={key.updatedAt} tooltip={`Updated: ${formatSecretRelative(key.updatedAt)}`} /></div><div role="cell" className="text-right" onClick={event => event.stopPropagation()}>{menu(key)}</div>
        </SecretCollectionRow>)}</div></div>
        <div className="space-y-2 @min-[40rem]:hidden" data-testid="signing-keys-card-view">{folderRows("card")}{rows.map(({ key }) => <SecretCollectionCard key={key.id} selected={selected?.id === key.id} onOpen={() => open(key)}><div className="flex min-w-0 items-start justify-between gap-2"><div className="min-w-0">{keyName(key)}<code className="mt-0.5 block truncate text-(length:--text-micro) text-muted-foreground">{key.id}</code></div><div onClick={event => event.stopPropagation()}>{menu(key)}</div></div><div className="mt-2 flex flex-wrap items-center gap-2"><SecretMetaChip>{signingKeyTypeLabel(key)}</SecretMetaChip><SecretStatusBadge status={key.status as SecretStatus} /></div><div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground"><span className="min-w-0 truncate">{version(key)}</span><span>Updated {formatSecretRelative(key.updatedAt)}</span></div></SecretCollectionCard>)}</div>
      </>}
    </div>}
    <Sheet open={!!selected} onOpenChange={value => { if (!value) close(); }}><SecretDetailsSheetContent>{selected && <>
      <SecretDetailsHeader name={signingKeyDisplayName(selected)} status={selected.status as SecretStatus} description="Signing-key metadata only. Private material cannot be revealed or exported." identifier={selected.id} onCopyIdentifier={() => void copyTextToClipboard(selected.id)}>
        <SecretMetaChip>{signingKeyTypeLabel(selected)}</SecretMetaChip><SecretMetaChip>Paperclip use only</SecretMetaChip><SecretMetaChip>{selected.algorithm?.toUpperCase() ?? (selected.type === "github_app" ? "RSA" : "Algorithm unavailable")}</SecretMetaChip>
      </SecretDetailsHeader>
      <SecretDetailsActions>{catalog.data?.canManage && (generic || app) && <Button size="sm" onClick={() => start("rotate")}><RefreshCw className="mr-1 h-3.5 w-3.5" />Rotate key</Button>}<Button variant="outline" size="sm" onClick={() => void copyTextToClipboard(window.location.href)}><Link2 className="mr-1 h-3.5 w-3.5" />Copy link</Button>{menu(selected)}</SecretDetailsActions>
      <Tabs value={detailTab} onValueChange={setDetailTab} className="flex-1 min-h-0 flex flex-col"><SecretDetailsTabBar ariaLabel="Signing key details section" align="start" value={detailTab} onValueChange={setDetailTab} items={[{ value: "details", label: "Details" }, { value: "usage", label: app ? "Usage (1)" : "Usage" }, { value: "versions", label: "Versions" }, { value: "access", label: "Access events" }]} />
        <SecretDetailsBody><TabsContent value="details"><div className="space-y-3"><p className="text-sm text-muted-foreground">{publicDescription}</p><dl className="grid grid-cols-2 gap-3 text-sm"><dt className="text-muted-foreground">Name</dt><dd className="break-words">{selected.name}</dd><dt className="text-muted-foreground">Description</dt><dd className="break-words">{selected.description || "—"}</dd><dt className="text-muted-foreground">Algorithm</dt><dd>{selected.algorithm?.toUpperCase() ?? (selected.type === "github_app" ? "RSA · GitHub App" : "Unavailable")}</dd><dt className="text-muted-foreground">Public fingerprint</dt><dd className="break-all font-mono text-xs">{selected.publicFingerprint ?? app?.publicFingerprint ?? "Unavailable"}</dd><dt className="text-muted-foreground">Latest stored version</dt><dd>v{selected.latestVersion}</dd>{app && <><dt className="text-muted-foreground">Active connection version</dt><dd>v{app.pinnedVersion}</dd></>}</dl><div className="space-y-1"><h3 className="text-sm font-medium">Used by</h3>{app?.connectionId ? <Link className="text-sm underline underline-offset-4" to={`/apps/${app.connectionId}/permissions`}>View connection</Link> : <p className="text-sm text-muted-foreground">{generic ? "No connected service" : "Connected service usage unavailable"}</p>}<Button variant="link" className="p-0" onClick={() => setDetailTab("usage")}>View usage</Button></div></div></TabsContent>
        <TabsContent value="usage"><div className="space-y-3"><h3 className="text-sm font-medium">Used by</h3>{apps.isError ? <p role="alert">Connected service usage could not be loaded. Refresh before changing this key.</p> : app ? <><p className="text-sm">GitHub · {app.role} · Active v{app.pinnedVersion}</p>{app.connectionId ? <Link className="text-sm underline underline-offset-4" to={`/apps/${app.connectionId}/permissions`}>View connection</Link> : <p className="text-sm text-muted-foreground">Connect the prepared identities from GitHub setup.</p>}</> : <p className="text-sm text-muted-foreground">{generic ? "No connected service. A service integration must explicitly adopt this key before use." : "Service usage is unavailable; check its connection before changing this key."}</p>}<p className="text-xs text-muted-foreground">Signing keys cannot be assigned to agents or projected as connection credentials.</p></div></TabsContent>
        <TabsContent value="versions"><div className="space-y-3 text-sm">{versions.isPending && <p role="status">Loading versions…</p>}{versions.isError && <p role="alert">Version history could not be loaded.</p>}{versions.data?.map(item => <div key={item.id} className="flex flex-wrap justify-between gap-2"><span>v{item.version} · {item.version === selected.latestVersion ? "Latest stored" : "Stored"}{app?.pinnedVersion === item.version ? " · Active in GitHub connection" : ""}</span><span className="text-muted-foreground">{formatSecretRelative(item.createdAt)}</span></div>)}</div></TabsContent>
        <TabsContent value="access"><div className="space-y-3 text-sm">{events.isPending && <p role="status">Loading access events…</p>}{events.isError && <p role="alert">Access events could not be loaded. Refresh to try again.</p>}{events.data?.length === 0 && <p className="text-muted-foreground">No access events recorded.</p>}{events.data?.map(item => <div key={item.id} className="flex flex-wrap justify-between gap-2"><span>{item.outcome} · v{item.version ?? "—"}</span><span className="text-muted-foreground">{formatSecretRelative(item.createdAt)}</span></div>)}</div></TabsContent>
        </SecretDetailsBody></Tabs>
    </>}</SecretDetailsSheetContent></Sheet>
    <Dialog open={!!modal} onOpenChange={value => { if (!value && !busy) { setModal(null); setFile(undefined); setConfirmation(null); setError(null); } }}><DialogContent className="max-h-(--sz-calc-18) overflow-y-auto"><DialogHeader><DialogTitle>{modal === "import" ? "New signing key" : modal === "rotate" ? "Rotate signing key" : modal === "move" ? "Move to folder" : modal === "edit" ? "Edit signing key details" : "Change signing key status"}</DialogTitle><DialogDescription>{modal === "move" ? "Organize this key without changing its name, identity, App binding, signing material or active version." : "Private signing values cannot be revealed, exported or assigned to agents."}</DialogDescription></DialogHeader>
      {modal === "rotate" && selected?.type === "github_app" ? app && apps.data ? <GitHubAppKeyLifecycle key={`${companyId}-${app.role}-${app.secretId}`} companyId={companyId} app={app} settings={apps.data} /> : <p role="alert">The connected service could not be loaded. Refresh before rotating this key.</p> : <div className="space-y-3">
        {(modal === "import" || modal === "edit") && <><label className="block text-sm">Name<Input aria-label="Signing key name" value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label><label className="block text-sm">Description<Textarea aria-label="Signing key description" value={description} onChange={event => setDescription(event.target.value)} disabled={busy} /></label></>}
        {modal === "move" && <label className="block text-sm">Folder path<Input aria-label="Signing key folder path" value={destination} onChange={event => setDestination(event.target.value)} placeholder="services/github (leave empty for root)" disabled={busy} /><span className="mt-1 block text-xs text-muted-foreground">Slash-separated folder names. Empty folders are not persisted.</span></label>}
        {(modal === "import" || modal === "rotate") && <><label className="block text-sm">{modal === "import" ? "Private key file" : "Replacement private key file"}<Input type="file" aria-label="Signing key file" accept=".pem" disabled={busy} onChange={event => { const next = event.target.files?.[0]; setFile(next && next.size <= 16384 ? next : undefined); setConfirmation(null); setError(next && next.size > 16384 ? "Key files must be no larger than 16 KiB." : null); }} /></label><p className="text-xs text-muted-foreground">RSA, EC or Ed25519 · Unencrypted PEM · 16 KiB maximum. Sent only when you confirm an import or rotation.</p></>}
        {modal === "status" && <p className="text-sm">Set this generic signing key to {targetStatus}?</p>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmation(event.target.checked ? identity : null)} />I confirm this signing key change.</label>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="flex-row flex-wrap items-center justify-between sm:justify-between"><Button variant="ghost" disabled={busy} onClick={() => { setModal(null); setFile(undefined); setConfirmation(null); setError(null); }}>Cancel</Button>
        {(modal === "import" || (modal === "rotate" && generic)) && <Button disabled={busy || !confirmed || !file || (modal === "import" && !name.trim()) || (modal === "rotate" && selected?.status !== "active")} onClick={() => void importOrRotate()}>{modal === "import" ? "Import key" : "Rotate key"}</Button>}
        {modal === "move" && selected && <Button disabled={busy || !confirmed || !selected.canOrganize} onClick={() => void perform(() => signingKeysApi.organize(companyId, selected.id, { folderPath: destination, expectedLatestVersion: selected.latestVersion, expectedUpdatedAt: selected.updatedAt, expectedOrganizationRevision: selected.organizationRevision ?? 0, confirmed: true }))}>Move key</Button>}
        {modal === "edit" && generic && selected && <Button disabled={busy || !confirmed || !name.trim()} onClick={() => void perform(() => signingKeysApi.update(companyId, selected.id, { name, description, expectedLatestVersion: selected.latestVersion, expectedRevision: selected.revision!, confirmed: true }))}>Save details</Button>}
        {modal === "status" && generic && selected && <Button disabled={busy || !confirmed} onClick={() => void perform(() => signingKeysApi.update(companyId, selected.id, { status: targetStatus, expectedLatestVersion: selected.latestVersion, expectedRevision: selected.revision!, confirmed: true }))}>Confirm status change</Button>}
      </DialogFooter>
    </DialogContent></Dialog>
  </div></TooltipProvider>;
}
