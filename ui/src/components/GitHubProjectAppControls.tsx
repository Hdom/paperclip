import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GitHubProjectAppRole, GitHubProjectAppSettings } from "@paperclipai/shared";
import { githubProjectAppsApi } from "@/api/github-project-apps";
import { agentsApi } from "@/api/agents";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

const roles = ["coordinator", "implementer", "reviewer"] as const;
const labels = { coordinator: "Coordinator", implementer: "Implementer", reviewer: "Reviewer" };
const permissions = {
  coordinator: "Creates project repositories and enrolls the two fixed worker installations. Its token stays on the controller.",
  implementer: "Writes project contents and opens pull requests.",
  reviewer: "Reads project contents and submits pull request reviews.",
};
export const githubProjectAppsQueryKey = (companyId: string) => ["github-project-apps", companyId];
export function useGitHubProjectApps(companyId: string) {
  return useQuery({ queryKey: githubProjectAppsQueryKey(companyId), queryFn: () => githubProjectAppsApi.settings(companyId), retry: false });
}

export function GitHubProjectAppManager({ companyId, agentId, label = "Manage GitHub App" }: { companyId: string; agentId?: string; label?: string }) {
  const query = useGitHubProjectApps(companyId), client = useQueryClient();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false), [bindings, setBindings] = useState<Record<GitHubProjectAppRole, string>>({ coordinator: "", implementer: "", reviewer: "" });
  const [review, setReview] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [migrationConfirmed, setMigrationConfirmed] = useState(false);
  const [files, setFiles] = useState<Partial<Record<GitHubProjectAppRole, File>>>({});
  const [keyConfirmed, setKeyConfirmed] = useState<Partial<Record<GitHubProjectAppRole, boolean>>>({});
  const [versions, setVersions] = useState<Partial<Record<GitHubProjectAppRole, number>>>({});
  const data = query.data;
  const agents = useQuery({ queryKey: ["github-app-agent-choices", companyId], queryFn: () => agentsApi.list(companyId), enabled: open && data?.canManage === true });
  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled); setBindings(Object.fromEntries(data.roles.map(row => [row.role, row.agentId])) as Record<GitHubProjectAppRole, string>);
    setReview(false); setConfirmed(false); setMigrationConfirmed(false); setFiles({}); setKeyConfirmed({}); setVersions({});
  }, [data?.revision, open]);
  if (!data?.available || !data.canManage) return null;
  const current = data.roles.find(row => row.agentId === agentId);
  const blocked = agentId && data.blockedAgentIds.includes(agentId);
  const names = new Map((agents.data ?? []).map(agent => [agent.id, agent.name]));
  const dirty = enabled !== data.enabled || data.roles.some(row => row.agentId !== bindings[row.role]);
  async function action(work: () => Promise<GitHubProjectAppSettings>) {
    setBusy(true); setError(null);
    try { client.setQueryData(githubProjectAppsQueryKey(companyId), await work()); }
    catch { setError("The change could not be completed. Refresh the settings and check the App permissions, key version and agent activity before trying again."); }
    finally { setBusy(false); }
  }
  async function rotate(role: GitHubProjectAppRole) {
    const file = files[role], row = data!.roles.find(value => value.role === role)!;
    if (!file || !keyConfirmed[role] || !row.latestVersion) return;
    if (file.size > 16384) { setError("Choose a PEM key file no larger than 16 KiB."); return; }
    // File bytes remain transient request input, never query/mutation cache data.
    await action(async () => {
      const privateKey = await file.text();
      return githubProjectAppsApi.rotate(companyId, role, { revision: data!.revision, confirmed: true, privateKey, expectedLatestVersion: row.latestVersion! });
    });
    setFiles(value => ({ ...value, [role]: undefined })); setKeyConfirmed(value => ({ ...value, [role]: false }));
  }
  return <>
    <Button variant="outline" size="sm" onClick={() => { setError(null); setOpen(true); }}>{label}</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>GitHub App identities</DialogTitle><DialogDescription>Assign the approved App roles and manage their signing keys through Paperclip Secrets.</DialogDescription></DialogHeader>
        <p className="text-sm">Owner: Hdom · Selected repositories only · No Administration permission</p>
        <p className="text-xs text-muted-foreground">Pausing stops new project operations and token issuance. Tokens already delivered can remain valid for up to one hour. Shared worker processes are not strongly isolated.</p>
        {(data.roles.some(row => row.keyStorage === "legacy_file") || !!data.migration?.cleanupPending.length) && <div className="rounded border p-3 space-y-2 text-sm">
          <p>{data.migration?.migrated ? "Native Secrets is active. Protected plaintext cleanup remains pending." : "The prepared signing keys have not yet been migrated into Paperclip Secrets."}</p>
          <p>Paperclip verifies encrypted native versions before removing the matching prepared plaintext files. A failed verification retains the original configuration and files.</p>
          <label className="flex gap-2"><input type="checkbox" checked={migrationConfirmed} disabled={busy} onChange={event => setMigrationConfirmed(event.target.checked)} />I confirm migration and verified plaintext cleanup for these three Apps.</label>
          <Button disabled={busy || !migrationConfirmed} onClick={() => void action(() => githubProjectAppsApi.migrate(companyId, data.revision))}>{data.migration?.migrated ? "Finish verified cleanup" : "Migrate signing keys to Paperclip Secrets"}</Button>
        </div>}
        <div className="flex flex-wrap gap-2 items-center">
          <Button variant="outline" disabled={busy} onClick={() => void action(() => githubProjectAppsApi.verify(companyId, data.revision))}>Verify App access</Button>
          <span className="text-xs text-muted-foreground">{data.checkedAt ? `Last verified ${new Date(data.checkedAt).toLocaleString()}` : "Access has not been verified for these settings."}</span>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={busy || review} onChange={event => setEnabled(event.target.checked)} />Allow App issuance</label>
        {data.roles.map(row => <section key={row.role} className="rounded-lg border p-3 space-y-3">
          <div><h3 className="font-semibold">{labels[row.role]} · {row.status}</h3><p className="text-sm text-muted-foreground">{permissions[row.role]}</p></div>
          <p className="text-xs">App {row.appId} · Installation {row.installationId}{row.login ? ` · ${row.login}` : ""}</p>
          <div className="flex gap-3 text-sm underline"><a href={row.appUrl ?? "https://github.com/settings/apps"} target="_blank" rel="noreferrer">GitHub App settings</a><a href={row.installationUrl} target="_blank" rel="noreferrer">Repository selection</a></div>
          <label className="block text-sm">{labels[row.role]} agent
            <select className="mt-1 w-full rounded border bg-background p-2 text-base md:text-sm" aria-label={`${labels[row.role]} agent`} value={bindings[row.role] ?? row.agentId} disabled={busy || review} onChange={event => setBindings(value => ({ ...value, [row.role]: event.target.value }))}>
              {!(agents.data ?? []).some(agent => agent.id === row.agentId) && <option value={row.agentId}>{row.agentId}</option>}
              {(agents.data ?? []).filter(agent => agent.status !== "terminated").map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          {row.message && <p role="status" className="text-sm">{row.message}</p>}
          <div className="text-sm"><p>Installation repositories: {row.repositories.length ? row.repositories.length : "Not verified"}</p><ul>{row.repositories.map(repo => <li key={repo.id}>{repo.fullName}{repo.starter ? " · empty starter, never an agent token target" : ""}</li>)}</ul></div>
          <details><summary className="cursor-pointer text-sm font-medium">Signing key · {row.keyStorage === "native_encrypted" ? "Paperclip Secrets" : "Migration required"}</summary>
            {row.keyStorage === "native_encrypted" ? <div className="space-y-2 mt-2 text-sm">
              <p>Secret {row.secretId} · Active version {row.pinnedVersion} · Latest stored version {row.latestVersion ?? "unavailable"}</p>
              <p>Controller signing only. The key value cannot be revealed or bound to an agent.</p>
              {row.publicFingerprint && <p className="break-all font-mono text-xs">Verified public fingerprint: {row.publicFingerprint}</p>}
              <p className="text-xs text-muted-foreground">Generate a replacement in this App’s GitHub settings. Paperclip validates it before activation and keeps encrypted versions for recovery. GitHub key revocation remains in GitHub.</p>
              <input key={`${row.role}-${data.revision}`} aria-label={`Replacement ${labels[row.role]} signing key`} type="file" accept=".pem" disabled={busy} onChange={event => { setFiles(value => ({ ...value, [row.role]: event.target.files?.[0] })); setKeyConfirmed(value => ({ ...value, [row.role]: false })); }} />
              <label className="flex gap-2"><input type="checkbox" checked={keyConfirmed[row.role] ?? false} disabled={busy} onChange={event => setKeyConfirmed(value => ({ ...value, [row.role]: event.target.checked }))} />I confirm this key/version change for the {labels[row.role]} App.</label>
              <Button variant="outline" size="sm" disabled={busy || !files[row.role] || !keyConfirmed[row.role]} onClick={() => void rotate(row.role)}>Validate and rotate key</Button>
              <div className="flex items-center gap-2"><input aria-label={`${labels[row.role]} key version`} className="w-20 rounded border bg-background p-1 text-base md:text-sm" type="number" min={1} max={row.latestVersion ?? undefined} value={versions[row.role] ?? row.pinnedVersion ?? 1} disabled={busy} onChange={event => setVersions(value => ({ ...value, [row.role]: Number(event.target.value) }))} />
                <Button variant="outline" size="sm" disabled={busy || !keyConfirmed[row.role] || (versions[row.role] ?? row.pinnedVersion) === row.pinnedVersion} onClick={() => void action(() => githubProjectAppsApi.activate(companyId, row.role, { revision: data.revision, confirmed: true, version: versions[row.role]! }))}>Verify and activate version</Button>
              </div>
            </div> : <p className="mt-2 text-sm">Controller migration must finish before key management is available here.</p>}
          </details>
        </section>)}
        {blocked && !current && <div className="rounded border p-3 text-sm space-y-2"><p>This agent’s former App assignment remains paused. Personal GitHub fallback is suppressed.</p><Button variant="outline" disabled={busy || !confirmed} onClick={() => void action(() => githubProjectAppsApi.configure(companyId, { revision: data.revision, confirmed: true, releaseAgentId: agentId }))}>Release managed identity and use existing GitHub connection rules</Button></div>}
        {dirty && !review && <Button disabled={busy} onClick={() => { setReview(true); setConfirmed(false); }}>Review changes</Button>}
        {(review || blocked) && <div className="rounded border p-3 space-y-2 text-sm">
          {review && <><p>App issuance: {enabled ? "Enabled" : "Paused"}</p>{roles.map(role => <p key={role}>{labels[role]}: {names.get(bindings[role]) ?? bindings[role]}</p>)}<p>Former App agents keep GitHub access blocked until explicitly released to existing GitHub connection rules. App permissions and installation IDs stay fixed.</p></>}
          <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I confirm these GitHub identity changes.</label>
        </div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center justify-between gap-3"><Button variant="outline" disabled={busy} onClick={() => { setReview(false); setOpen(false); }}>Close</Button>{review && <Button disabled={busy || !confirmed} onClick={() => void action(() => githubProjectAppsApi.configure(companyId, { revision: data.revision, confirmed: true, enabled, bindings }))}>{busy ? "Saving…" : "Apply confirmed changes"}</Button>}</div>
      </DialogContent>
    </Dialog>
  </>;
}

export function ControllerSigningKeysSection({ companyId }: { companyId: string }) {
  const query = useGitHubProjectApps(companyId);
  if (!query.data?.available || !query.data.canManage) return null;
  return <section id="controller-signing-keys" className="rounded-lg border p-4 space-y-3">
    <h2 className="font-semibold">Controller signing keys</h2>
    <p className="text-sm text-muted-foreground">GitHub App signing keys use Paperclip’s encrypted secret provider and version history. They are not available in agent secret pickers or bindings.</p>
    {query.data.roles.map(row => <p key={row.role} className="text-sm">{labels[row.role]}: {row.keyStorage === "native_encrypted" ? `encrypted native secret · version ${row.pinnedVersion} · ${row.keyStatus}` : "native migration pending"}</p>)}
    <GitHubProjectAppManager companyId={companyId} label="Manage App signing keys" />
  </section>;
}
