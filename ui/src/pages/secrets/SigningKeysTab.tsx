import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SigningKeySummary } from "@paperclipai/shared";
import { signingKeysApi } from "@/api/signing-keys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { GitHubProjectAppManager, useGitHubProjectApps } from "@/components/GitHubProjectAppControls";

const queryKey = (companyId: string) => ["signing-keys", companyId];
export function SigningKeysTab({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const catalog = useQuery({ queryKey: queryKey(companyId), queryFn: () => signingKeysApi.list(companyId) });
  const apps = useGitHubProjectApps(companyId);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | undefined>();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const selected = catalog.data?.keys.find(row => row.id === selectedId);
  const versions = useQuery({ queryKey: ["signing-key-versions", companyId, selected?.id, selected?.latestVersion],
    queryFn: () => signingKeysApi.versions(companyId, selected!.id), enabled: !!selected });
  const reviewIdentity = JSON.stringify([companyId, creating, selected?.id, selected?.revision, selected?.latestVersion, selected?.status, selected?.updatedAt, name, description, file?.name, file?.size, file?.lastModified]);
  const confirmed = confirmation === reviewIdentity;
  function setConfirmed(value: boolean) { setConfirmation(value ? reviewIdentity : null); }
  useEffect(() => {
    setSelectedId(null); setCreating(false); setName(""); setDescription(""); setFile(undefined); setConfirmation(null); setError(null);
  }, [companyId]);
  useEffect(() => {
    setFile(undefined); setConfirmation(null);
    if (selected) { setName(selected.name); setDescription(selected.description ?? ""); }
  }, [selected?.id, selected?.revision, selected?.latestVersion, selected?.status, selected?.updatedAt]);
  function open(row?: SigningKeySummary) {
    setSelectedId(row?.id ?? null); setCreating(!row); setName(row?.name ?? ""); setDescription(row?.description ?? "");
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
      const privateKey = await file.text();
      if (creating) {
        const key = await signingKeysApi.create(companyId, { name, description, privateKey, confirmed: true });
        setCreating(false); setSelectedId(key.id);
      } else if (selected?.revision) {
        await signingKeysApi.rotate(companyId, selected.id, { privateKey, expectedLatestVersion: selected.latestVersion,
          expectedRevision: selected.revision, confirmed: true });
      }
    });
  }
  const generic = selected?.type === "generic" && selected.revision !== null;
  const writable = !!catalog.data?.canManage && (creating || generic);
  const app = selected?.githubApp ? apps.data?.roles.find(row => row.secretId === selected.id) : undefined;
  return <div className="flex flex-col gap-3">
    <div role="toolbar" aria-label="Signing key controls" className="flex flex-wrap items-center gap-2">
      <input aria-label="Search signing keys" placeholder="Search signing keys" className="w-64 max-w-full rounded border bg-background px-3 py-2 text-sm" value={search} onChange={event => setSearch(event.target.value)} />
      {catalog.data?.canManage && <Button onClick={() => open()}>Import signing key</Button>}
    </div>
    <p className="text-sm text-muted-foreground">Encrypted keys used by Paperclip to sign requests. Key values cannot be revealed, exported, or bound to agents. Connected services control verification and activation.</p>
    {catalog.isPending && <p>Loading signing keys…</p>}
    {catalog.error && <p role="alert">Signing keys could not be loaded.</p>}
    {catalog.data && <div className="overflow-x-auto rounded-md border"><table className="w-full text-left text-sm">
      <thead className="border-b bg-muted/40"><tr>{["Name", "Type", "Status", "Version", "Updated"].map(label => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead>
      <tbody>{catalog.data.keys.filter(row => `${row.name} ${row.type} ${row.status}`.toLowerCase().includes(search.toLowerCase())).map(row => <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30">
        <td className="p-3"><button className="font-medium underline-offset-4 hover:underline" onClick={() => open(row)}>{row.name}</button>{row.description && <p className="mt-1 text-xs text-muted-foreground">{row.description}</p>}</td>
        <td className="p-3">{row.type === "github_app" ? "GitHub App" : row.type === "generic" ? "Signing key" : "Managed service"}</td>
        <td className="p-3">{row.status}</td><td className="p-3">{row.latestVersion}</td><td className="p-3 whitespace-nowrap">{new Date(row.updatedAt).toLocaleDateString()}</td>
      </tr>)}</tbody></table>{!catalog.data.keys.length && <p className="p-6 text-sm text-muted-foreground">No signing keys.</p>}</div>}
    <Dialog open={creating || !!selected} onOpenChange={open => { if (!busy && !open) { setCreating(false); setSelectedId(null); setFile(undefined); setConfirmed(false); } }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{creating ? "Import signing key" : selected?.name}</DialogTitle>
        <DialogDescription>Managed by Paperclip. Only public key metadata is available after import.</DialogDescription></DialogHeader>
        {error && <p role="alert" className="text-sm">{error}</p>}
        <label className="text-sm">Name<input aria-label="Signing key name" className="mt-1 w-full rounded border bg-background p-2" value={name} disabled={!writable || busy} onChange={event => setName(event.target.value)} maxLength={200} /></label>
        <label className="text-sm">Description<textarea aria-label="Signing key description" className="mt-1 w-full rounded border bg-background p-2" value={description} disabled={!writable || busy} onChange={event => setDescription(event.target.value)} maxLength={4000} /></label>
        {selected && <dl className="space-y-2 text-sm"><div><dt className="text-muted-foreground">Status</dt><dd>{selected.status}</dd></div><div><dt className="text-muted-foreground">Latest stored version</dt><dd>{selected.latestVersion}</dd></div>
          <div><dt className="text-muted-foreground">Algorithm</dt><dd>{selected.algorithm ?? (selected.githubApp ? "RSA · GitHub App" : "Not recorded")}</dd></div>
          <div><dt className="text-muted-foreground">Public fingerprint{selected.publicFingerprint ? ` · stored version ${selected.latestVersion}` : app?.publicFingerprint ? ` · active version ${app.pinnedVersion}` : ""}</dt><dd className="break-all font-mono text-xs">{selected.publicFingerprint ?? app?.publicFingerprint ?? "Not recorded; verify through the connected service."}</dd></div></dl>}
        {selected && <details className="text-sm"><summary className="cursor-pointer font-medium">Version history</summary>
          {versions.isPending && <p>Loading versions…</p>}{versions.error && <p role="alert">Version history could not be loaded.</p>}
          {versions.data && <table className="mt-2 w-full text-left text-xs"><thead><tr><th className="py-1">Version</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>{versions.data.map(version => <tr key={version.id}><td className="py-1">{version.version}</td><td>{version.status}</td><td>{new Date(version.createdAt).toLocaleString()}</td></tr>)}</tbody></table>}
        </details>}
        {selected?.githubApp && <div className="space-y-2 rounded border p-3 text-sm"><p>GitHub App {selected.githubApp.appId} · {selected.githubApp.role}</p>
          <p>Active version: {app?.pinnedVersion ?? "Not verified"} · {app?.status ?? "Status unavailable"}</p>
          <p>GitHub verifies replacement keys before activation. Repository selection and App permissions remain controlled by GitHub.</p>
          <GitHubProjectAppManager companyId={companyId} label="Manage GitHub App and key" />
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
      </DialogContent>
    </Dialog>
  </div>;
}
