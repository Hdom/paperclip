import { Link } from "@/lib/router";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SigningKeySummary } from "@paperclipai/shared";
import { signingKeysApi } from "@/api/signing-keys";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { TabBar } from "@/components/TabBar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { MoreHorizontal } from "lucide-react";
import { CollectionToolbar } from "@/components/CollectionToolbar";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { GitHubAppKeyLifecycle } from "./GitHubAppKeyLifecycle";
import { useGitHubProjectApps } from "@/components/GitHubProjectAppControls";

const queryKey = (companyId: string) => ["signing-keys", companyId];
export function SigningKeysTab({ companyId, selection, onSelectionChange }: {
  companyId: string; selection?: string | null; onSelectionChange?: (id: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const catalog = useQuery({ queryKey: queryKey(companyId), queryFn: () => signingKeysApi.list(companyId) });
  const apps = useGitHubProjectApps(companyId);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState("details");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | undefined>();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const selected = catalog.data?.keys.find(row => row.id === (selection === undefined ? selectedId : selection));
  const events = useQuery({ queryKey: ["signing-key-access", companyId, selected?.id],
    queryFn: () => signingKeysApi.events(companyId, selected!.id), enabled: !!selected && detailTab === "access" });
  const versions = useQuery({ queryKey: ["signing-key-versions", companyId, selected?.id, selected?.latestVersion],
    queryFn: () => signingKeysApi.versions(companyId, selected!.id), enabled: !!selected });
  const reviewIdentity = JSON.stringify([companyId, creating, selected?.id, selected?.revision, selected?.latestVersion, selected?.status, selected?.updatedAt, name, description, file?.name, file?.size, file?.lastModified]);
  const confirmed = confirmation === reviewIdentity;
  const currentReview = useRef<string | null>(reviewIdentity); currentReview.current = reviewIdentity;
  useEffect(() => { currentReview.current = reviewIdentity; return () => { currentReview.current = null; }; }, [reviewIdentity]);
  function setConfirmed(value: boolean) { setConfirmation(value ? reviewIdentity : null); }
  useEffect(() => {
    setSelectedId(null); setCreating(false); setName(""); setDescription(""); setFile(undefined); setConfirmation(null); setError(null);
  }, [companyId]);
  useEffect(() => {
    setFile(undefined); setConfirmation(null);
    if (selected) { setName(selected.name); setDescription(selected.description ?? ""); }
  }, [selected?.id, selected?.revision, selected?.latestVersion, selected?.status, selected?.updatedAt]);
  function open(row?: SigningKeySummary) {
    setSelectedId(row?.id ?? null); onSelectionChange?.(row?.id ?? null); setDetailTab("details"); setCreating(!row); setName(row?.name ?? ""); setDescription(row?.description ?? "");
    setFile(undefined); setConfirmed(false); setError(null);
  }
  async function action(operation: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await operation(); await queryClient.invalidateQueries({ queryKey: queryKey(companyId) }); setFile(undefined); setConfirmed(false); }
    catch { setError("The signing key change failed. Refresh the details and check your access before retrying."); }
    finally { setBusy(false); }
  }
  async function importKey() {
    if (!file || !confirmed || file.size > 16384) return;
    await action(async () => {
      const authorized = reviewIdentity;
      const privateKey = await file.text();
      if (currentReview.current !== authorized) throw new Error("Signing key review changed");
      if (creating) {
        const key = await signingKeysApi.create(companyId, { name, description, privateKey, confirmed: true });
        setCreating(false); setSelectedId(key.id); onSelectionChange?.(key.id);
      } else if (selected?.revision) {
        await signingKeysApi.rotate(companyId, selected.id, { privateKey, expectedLatestVersion: selected.latestVersion,
          expectedRevision: selected.revision, confirmed: true });
      }
    });
  }
  const generic = selected?.type === "generic" && selected.revision !== null;
  const writable = !!catalog.data?.canManage && (creating || generic);
  const app = selected?.githubApp ? apps.data?.roles.find(row => row.secretId === selected.id
    || (row.role === selected.githubApp!.role && row.appId === selected.githubApp!.appId)) : undefined;
  return <div className="flex flex-col gap-3">
    <CollectionToolbar ariaLabel="Signing key controls"
      search={<ToolbarSearch label="Search signing keys" placeholder="Search signing keys" query={search} onQueryChange={setSearch} />}
      actions={catalog.data?.canManage && <Button onClick={() => open()}>Import signing key</Button>} />
    <p className="text-sm text-muted-foreground">Encrypted keys used by Paperclip to sign requests. Key values cannot be revealed, exported, or bound to agents. Connected services control verification and activation.</p>
    {catalog.isPending && <p>Loading signing keys…</p>}
    {catalog.error && <p role="alert">Signing keys could not be loaded.</p>}
    {catalog.data && <div className="overflow-x-auto rounded-md border"><table className="w-full text-left text-sm">
      <thead className="border-b bg-muted/40"><tr>{["Name", "Type", "Status", "Version", "Updated", "Actions"].map(label => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead>
      <tbody>{catalog.data.keys.filter(row => `${row.name} ${row.type} ${row.status}`.toLowerCase().includes(search.toLowerCase())).map(row => <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30">
        <td className="p-3"><button className="font-medium underline-offset-4 hover:underline" onClick={() => open(row)}>{row.name}</button>{row.description && <p className="mt-1 text-xs text-muted-foreground">{row.description}</p>}</td>
        <td className="p-3">{row.type === "github_app" ? "GitHub App" : row.type === "generic" ? "Signing key" : "Managed service"}</td>
        <td className="p-3">{row.status}</td><td className="p-3">{row.latestVersion}</td><td className="p-3 whitespace-nowrap">{new Date(row.updatedAt).toLocaleDateString()}</td>
        <td className="p-3"><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${row.name}`}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => open(row)}>Open details</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { open(row); setDetailTab("usage"); }}>View usage</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { open(row); setDetailTab("versions"); }}>Version history</DropdownMenuItem>
            {catalog.data.canManage && row.type === "generic" && row.revision !== null && <>
              <DropdownMenuItem disabled={row.status !== "active"} onSelect={() => open(row)}>Rotate key…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => open(row)}>{row.status === "active" ? "Disable key…" : "Enable key…"}</DropdownMenuItem>
            </>}
          </DropdownMenuContent></DropdownMenu></td>
      </tr>)}</tbody></table>{!catalog.data.keys.length && <p className="p-6 text-sm text-muted-foreground">No signing keys.</p>}</div>}
    <Sheet open={creating || !!selected} onOpenChange={open => { if (!busy && !open) { setCreating(false); setSelectedId(null); onSelectionChange?.(null); setFile(undefined); setConfirmed(false); } }}>
      <SheetContent className="w-full sm:max-w-xl flex flex-col gap-0"><SheetHeader><SheetTitle>{creating ? "Import signing key" : selected?.name}</SheetTitle>
        <SheetDescription>Managed by Paperclip. Only public key metadata is available after import.</SheetDescription>
        {selected && <div className="flex flex-wrap gap-2"><Badge variant="outline">{selected.status}</Badge><Badge variant="outline">Signing key</Badge><Badge variant="outline">{selected.algorithm ?? "Managed service"}</Badge><Badge variant="outline">v{selected.latestVersion}</Badge></div>}
        </SheetHeader><div className="min-h-0 flex-1 overflow-y-auto p-4"><Tabs value={detailTab} onValueChange={setDetailTab} className="flex flex-col gap-4">
          {!creating && <TabBar size="compact" label="Signing key details" items={[
            { value: "details", label: "Details" }, { value: "usage", label: "Usage" }, { value: "versions", label: "Versions" }, { value: "access", label: "Access events" }]} />}
        <TabsContent value="details" className="flex flex-col gap-4">
        {error && <p role="alert" className="text-sm">{error}</p>}
        <label className="text-sm">Name<input aria-label="Signing key name" className="mt-1 w-full rounded border bg-background p-2" value={name} disabled={!writable || busy} onChange={event => setName(event.target.value)} maxLength={200} /></label>
        <label className="text-sm">Description<textarea aria-label="Signing key description" className="mt-1 w-full rounded border bg-background p-2" value={description} disabled={!writable || busy} onChange={event => setDescription(event.target.value)} maxLength={4000} /></label>
        {selected && <dl className="space-y-2 text-sm"><div><dt className="text-muted-foreground">Status</dt><dd>{selected.status}</dd></div><div><dt className="text-muted-foreground">Latest stored version</dt><dd>{selected.latestVersion}</dd></div>
          <div><dt className="text-muted-foreground">Algorithm</dt><dd>{selected.algorithm ?? (selected.githubApp ? "RSA · GitHub App" : "Not recorded")}</dd></div>
          <div><dt className="text-muted-foreground">Public fingerprint{selected.publicFingerprint ? ` · stored version ${selected.latestVersion}` : app?.publicFingerprint ? ` · active version ${app.pinnedVersion}` : ""}</dt><dd className="break-all font-mono text-xs">{selected.publicFingerprint ?? app?.publicFingerprint ?? "Not recorded; verify through the connected service."}</dd></div></dl>}
        {selected?.githubApp && <div className="space-y-2 rounded border p-3 text-sm"><p>GitHub App {selected.githubApp.appId} · {selected.githubApp.role}</p>
          <p>Active version: {app?.pinnedVersion ?? "Not verified"} · {app?.status ?? "Status unavailable"}</p>
          <p>GitHub verifies replacement keys before activation. Repository selection and App permissions remain controlled by GitHub.</p>
          {app?.connectionId && <Link className="underline underline-offset-4" to={`/apps/${app.connectionId}/permissions`}>View GitHub connection</Link>}
          {app && apps.data && <GitHubAppKeyLifecycle companyId={companyId} app={app} settings={apps.data} />}
        </div>}
        {generic && <p className="text-sm text-muted-foreground">No connected service. A service integration must explicitly adopt a signing key before it can be used.</p>}
        {writable && <div className="space-y-3">
          <label className="block text-sm">{creating ? "Private key file" : "Replacement private key file"}<input key={`${selected?.latestVersion ?? "new"}-${creating}`} className="mt-1 block w-full" aria-label="Signing key file" type="file" accept=".pem" disabled={busy} onChange={event => { const next = event.target.files?.[0]; setFile(next && next.size <= 16384 ? next : undefined); setConfirmed(false); setError(next && next.size > 16384 ? "Key files must be no larger than 16 KiB." : null); }} /></label>
          <p className="text-xs text-muted-foreground">RSA, EC or Ed25519 · Unencrypted PEM · 16 KiB maximum. The file is sent only when you confirm an import or rotation.</p>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I confirm this signing key change.</label>
          <div className="flex flex-wrap gap-2"><Button disabled={busy || !confirmed || !file || !name.trim() || (!creating && selected?.status !== "active")} onClick={() => void importKey()}>{creating ? "Import key" : "Rotate key"}</Button>
            {selected && generic && <><Button variant="outline" disabled={busy || !confirmed} onClick={() => void action(() => signingKeysApi.update(companyId, selected.id, { name, description, expectedLatestVersion: selected.latestVersion, expectedRevision: selected.revision!, confirmed: true }))}>Save details</Button>
              <Button variant="outline" disabled={busy || !confirmed} onClick={() => void action(() => signingKeysApi.update(companyId, selected.id, { status: selected.status === "active" ? "disabled" : "active", expectedLatestVersion: selected.latestVersion, expectedRevision: selected.revision!, confirmed: true }))}>{selected.status === "active" ? "Disable key" : "Enable key"}</Button>
              <Button variant="outline" disabled={busy || !confirmed || selected.status === "archived"} onClick={() => void action(() => signingKeysApi.update(companyId, selected.id, { status: "archived", expectedLatestVersion: selected.latestVersion, expectedRevision: selected.revision!, confirmed: true }))}>Archive key</Button></>}
          </div>
        </div>}
        </TabsContent>
        <TabsContent value="usage"><div className="flex flex-col gap-3"><h3 className="text-sm font-medium">Used by</h3>
          {app ? <><p className="text-sm">GitHub · {app.role} · Active version {app.pinnedVersion}</p>
            {app.connectionId ? <Link className="text-sm underline underline-offset-4" to={`/apps/${app.connectionId}/permissions`}>View connection</Link> : <p className="text-sm text-muted-foreground">Import the prepared identities from GitHub connection setup.</p>}</>
            : <p className="text-sm text-muted-foreground">{generic ? "No connected service. A service integration must explicitly adopt this key before use." : "Connected service usage is unavailable. Check the service configuration before changing this key."}</p>}
          <p className="text-xs text-muted-foreground">Signing keys cannot be bound to agents or projected as connection credentials.</p>
          {apps.isError && <p role="alert" className="text-sm text-destructive">Could not load connected service usage. Refresh to try again.</p>}
        </div></TabsContent>
        <TabsContent value="versions">        <div className="text-sm">
          {versions.isPending && <p>Loading versions…</p>}{versions.error && <p role="alert">Version history could not be loaded.</p>}
          {versions.data && <table className="mt-2 w-full text-left text-xs"><thead><tr><th className="py-1">Version</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>{versions.data.map(version => <tr key={version.id}><td className="py-1">{version.version}</td><td>{version.status === "current" ? "Latest stored" : "Stored"}{app?.pinnedVersion === version.version ? " · Active in GitHub connection" : ""}</td><td>{new Date(version.createdAt).toLocaleString()}</td></tr>)}</tbody></table>}
        </div>
</TabsContent>
        <TabsContent value="access"><div className="flex flex-col gap-3">
          {events.isPending && <p role="status">Loading access events…</p>}
          {events.isError && <p role="alert">Access events could not be loaded. Refresh to try again.</p>}
          {events.data?.length === 0 && <p className="text-sm text-muted-foreground">No access events recorded.</p>}
          {events.data?.map(event => <div key={event.id} className="flex items-center justify-between gap-3 text-sm"><span>{event.outcome} · v{event.version ?? "—"}</span><time>{new Date(event.createdAt).toLocaleString()}</time></div>)}
        </div></TabsContent>
        </Tabs></div></SheetContent>
    </Sheet>
  </div>;
}
