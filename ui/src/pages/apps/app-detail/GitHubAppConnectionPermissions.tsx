import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GitHubProjectAppRole, GitHubProjectAppSettings } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { githubProjectAppsApi } from "@/api/github-project-apps";
import { githubProjectAppsQueryKey, useGitHubProjectApps } from "@/components/GitHubProjectAppControls";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/lib/router";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";

const roles = ["coordinator", "implementer", "reviewer"] as const;
const permissions = {
  coordinator: "Metadata read · Repository creation write · Installation repository access write",
  implementer: "Metadata read · Contents write · Pull requests write",
  reviewer: "Metadata read · Contents read · Pull requests write",
};

export function GitHubAppConnectionPermissions({ companyId, connectionId }: { companyId: string; connectionId: string }) {
  const query = useGitHubProjectApps(companyId), client = useQueryClient();
  const data = query.data, app = data?.roles.find(row => row.connectionId === connectionId);
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId), enabled: data?.canManage === true });
  const [agentId, setAgentId] = useState("");
  const [review, setReview] = useState(false), [confirmation, setConfirmation] = useState<string | null>(null);
  const [control, setControl] = useState<"pause" | "resume" | string | null>(null);
  const [controlConfirmation, setControlConfirmation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const reviewIdentity = JSON.stringify([companyId, connectionId, data?.revision, app?.agentId, agentId]);
  const confirmed = confirmation === reviewIdentity;
  const controlIdentity = JSON.stringify([companyId, connectionId, data?.revision, control]);
  const controlConfirmed = controlConfirmation === controlIdentity;
  useEffect(() => { setAgentId(app?.agentId ?? ""); setReview(false); setConfirmation(null); setError(null); setControl(null); setControlConfirmation(null); }, [companyId, connectionId, data?.revision, app?.agentId]);
  async function change(operation: () => Promise<GitHubProjectAppSettings>) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      client.setQueryData(githubProjectAppsQueryKey(companyId), await operation());
      await client.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) });
      await client.invalidateQueries({ queryKey: queryKeys.tools.effectiveProfilesForAgent(companyId, app!.agentId) });
      await Promise.all([...new Set([...(data?.roles.map(row => row.agentId) ?? []), ...(data?.blockedAgentIds ?? []), agentId])].filter(Boolean)
        .map(id => client.invalidateQueries({ queryKey: queryKeys.tools.effectiveProfilesForAgent(companyId, id) })));
      setReview(false); setConfirmation(null); setControl(null); setControlConfirmation(null);
    } catch (cause) {
      setConfirmation(null); setControlConfirmation(null);
      setError(cause instanceof ApiError && cause.status === 409
        ? "The change could not be applied. Pause and drain affected agents for assignment, resuming issuance, or restoring ordinary GitHub access; then refresh and review again."
        : "The connection change failed. Refresh its verified identity and review the change again.");
    }
    finally { setBusy(false); }
  }
  if (query.isPending) return <p role="status">Loading GitHub App identity…</p>;
  if (query.isError) return <div className="flex flex-col gap-3"><p role="alert">Could not load this GitHub connection.</p><Button variant="outline" onClick={() => void query.refetch()}>Retry</Button></div>;
  if (!app || !data) return <p role="alert">This connection does not match the prepared GitHub App identities. An administrator must reconcile it before use.</p>;
  const agentName = agents.data?.find(row => row.id === app.agentId)?.name ?? app.role;
  return <div className="flex flex-col gap-8">
    <section className="flex flex-col gap-3"><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">GitHub identity</h2><Badge variant="outline">{app.status}</Badge></div>
      <p className="text-sm font-medium break-words">{app.login ?? `${app.role} GitHub App`}</p><p className="text-sm text-muted-foreground">GitHub App · Hdom · dedicated to {agentName}</p>
      {app.message && <p role="status" className="text-sm text-destructive">{app.message}</p>}
      <div className="flex flex-wrap gap-3 text-sm"><a className="underline underline-offset-4" href={app.appUrl ?? "https://github.com/settings/apps"} target="_blank" rel="noreferrer">GitHub App settings ↗</a>
        <a className="underline underline-offset-4" href={app.installationUrl} target="_blank" rel="noreferrer">Repository selection ↗</a></div>
      {app.secretId && <div className="flex flex-col gap-1 text-sm"><Link className="underline underline-offset-4" to={`/company/settings/secrets?signingKey=${encodeURIComponent(app.secretId)}`}>Signing key in Secrets</Link><span className="text-xs text-muted-foreground">Active version v{app.pinnedVersion} · latest stored v{app.latestVersion}</span></div>}
      {data.canManage && <Button className="self-start" variant="outline" disabled={busy} onClick={() => void change(() => githubProjectAppsApi.verify(companyId, data.revision))}>Refresh access</Button>}
      <details className="text-sm"><summary>Granted GitHub permissions</summary><p className="text-xs text-muted-foreground">{permissions[app.role]}</p></details>
    </section>
    <section className="flex flex-col gap-3"><h2 className="text-sm font-semibold">Repository access</h2><p className="text-sm">Current project repository only</p><p className="text-xs text-muted-foreground">GitHub installation access is the ceiling. Each run receives narrower project access.</p>
      {app.role === "coordinator" && <p className="text-xs text-muted-foreground">Creates the current project repository and enrolls the two fixed worker installations. Paperclip retains the provisioning token.</p>}
      {!data.canManage ? <p className="text-xs text-muted-foreground">Installation inventory is visible to administrators.</p> : app.status !== "verified" ? <p className="text-sm text-muted-foreground">Refresh access to verify installation repositories.</p> : <ul className="flex flex-col gap-2">{app.repositories.map(repo => <li key={repo.id} className="text-sm break-words">{repo.fullName}{repo.starter && <span className="text-xs text-muted-foreground"> · Bootstrap only; never an agent project token target</span>}</li>)}</ul>}
    </section>
    <section className="flex flex-col gap-3"><h2 className="text-sm font-semibold">Agent access</h2><p className="text-sm">{agentName} · dedicated identity</p>
      {data.canManage && <><label className="flex flex-col gap-1 text-sm">Assigned agent<select aria-label="Assigned GitHub App agent" className="rounded-md border border-input bg-background p-2 text-base md:text-sm" value={agentId} disabled={busy || review} onChange={event => { setAgentId(event.target.value); setConfirmation(null); }}>
        {!agents.data?.some(row => row.id === app.agentId) && <option value={app.agentId}>{agentName}</option>}
        {agents.data?.filter(row => row.status !== "terminated").map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></label>
      {agents.isError && <p role="alert" className="text-sm">Could not load eligible agents. Refresh before changing assignment.</p>}
      <p className="text-xs text-muted-foreground">Pause and drain both the current and replacement agents before reassignment.</p>
      {agentId !== app.agentId && !review && <Button variant="outline" className="self-start" disabled={busy || agents.isError} onClick={() => setReview(true)}>Review assignment</Button>}
      {review && <div className="flex flex-col gap-3"><p className="text-sm">Assign this App to {agents.data?.find(row => row.id === agentId)?.name ?? agentId}. The former agent remains blocked from personal GitHub fallback until explicitly released. Other App identities and GitHub permissions stay fixed.</p>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmation(event.target.checked ? reviewIdentity : null)} />I confirm this identity assignment.</label>
        <div className="flex items-center justify-between gap-3"><Button variant="ghost" onClick={() => { setReview(false); setConfirmation(null); }}>Cancel</Button><Button disabled={busy || !confirmed} onClick={() => {
          const bindings = Object.fromEntries(roles.map(role => [role, role === app.role ? agentId : data.roles.find(row => row.role === role)!.agentId])) as Record<GitHubProjectAppRole, string>;
          void change(() => githubProjectAppsApi.configure(companyId, { revision: data.revision, confirmed: true, bindings }));
        }}>Assign identity</Button></div></div>}</>}
    </section>
    <section className="flex flex-col gap-3"><h2 className="text-sm font-semibold">Capabilities</h2><p className="text-sm">{app.role === "coordinator" ? "Project repository provisioning" : "Git and gh"} · {data.enabled ? "Configured" : "Paused"}</p><p className="text-sm">{app.role === "coordinator" ? "GitHub API tools · Provisioning only" : "GitHub API tools · Review actions below"}</p><p className="text-xs text-muted-foreground">API actions use this App identity and the current project repository. New actions start off until reviewed below. Per-tool Ask-first rules do not constrain shell Git or gh.</p></section>
    {app.role === "coordinator" ? <section className="flex flex-col gap-3"><h2 className="text-sm font-semibold">App token issuance</h2>
      <p className="text-sm">{data.enabled ? "Enabled" : "Paused"} for all three GitHub App identities</p>
      <p className="text-xs text-muted-foreground">Pausing stops new App tokens immediately. Tokens already delivered remain valid until expiry or GitHub revocation. Assigned agents stay blocked from personal GitHub fallback.</p>
      {data.canManage && <><Button className="self-start" variant="outline" disabled={busy || control !== null} onClick={() => { setControl(data.enabled ? "pause" : "resume"); setControlConfirmation(null); }}>{data.enabled ? "Pause issuance…" : "Resume issuance…"}</Button>
      {data.blockedAgentIds.length > 0 && <div className="flex flex-col gap-2"><h3 className="text-sm font-medium">Former assigned agents</h3>{data.blockedAgentIds.map(id => <div className="flex flex-wrap items-center gap-3" key={id}><span className="text-sm">{agents.data?.find(row => row.id === id)?.name ?? id}</span><Button variant="ghost" disabled={busy || control !== null} onClick={() => { setControl(id); setControlConfirmation(null); }}>Restore ordinary GitHub access…</Button></div>)}</div>}
      {control !== null && <div className="flex flex-col gap-3 rounded-md border border-border p-3">
        <p className="text-sm">{control === "pause" ? "Stop new token issuance for Coordinator, Implementer and Reviewer. This does not change installation repository access or revoke existing tokens."
          : control === "resume" ? "Resume token issuance for all three verified identities. All three assigned agents must be paused and drained before resuming."
          : `Release ${agents.data?.find(row => row.id === control)?.name ?? control} from its former App identity restriction. This restores the ordinary GitHub credential rules already configured for that agent. Pause and drain it first; this grants no new repository access.`}</p>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={controlConfirmed} disabled={busy} onChange={event => setControlConfirmation(event.target.checked ? controlIdentity : null)} />I confirm this access change.</label>
        <div className="flex flex-wrap gap-3"><Button variant="ghost" disabled={busy} onClick={() => { setControl(null); setControlConfirmation(null); }}>Cancel</Button><Button disabled={busy || !controlConfirmed} onClick={() => void change(() => githubProjectAppsApi.configure(companyId, { revision: data.revision, confirmed: true, ...(control === "pause" || control === "resume" ? { enabled: control === "resume" } : { releaseAgentId: control }) }))}>Apply access change</Button></div>
      </div>}</>}
    </section> : <p className="text-sm text-muted-foreground">Company-wide issuance and former-agent restrictions are managed on the {data.roles.find(row => row.role === "coordinator")?.connectionId ? <Link className="underline underline-offset-4" to={`/apps/${data.roles.find(row => row.role === "coordinator")!.connectionId}/permissions`}>Coordinator connection</Link> : "Coordinator connection"}.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
