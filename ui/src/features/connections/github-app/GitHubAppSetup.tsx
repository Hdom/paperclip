import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { githubProjectAppsQueryKey, useGitHubProjectApps } from "@/components/GitHubProjectAppControls";
import { githubProjectAppsApi } from "@/api/github-project-apps";
import { queryKeys } from "@/lib/queryKeys";

/** Explicit migration of prepared identities; does not register Apps or change GitHub installation access. */
export function GitHubAppSetup({ companyId, requiredAgentId, onComplete, onCancel }: {
  companyId: string; requiredAgentId?: string; onComplete?: (result: { connectionId: string }) => void; onCancel?: () => void;
}) {
  const query = useGitHubProjectApps(companyId), client = useQueryClient(), navigate = useNavigate();
  const [confirmation, setConfirmation] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const data = query.data;
  const alreadyConnected = Boolean(data?.available && data.roles.length === 3 && data.roles.every(row => row.connectionId));
  const identity = JSON.stringify([companyId, data?.revision, data?.roles.map(row => [row.role, row.agentId, row.appId, row.installationId, row.pinnedVersion, row.latestVersion])]);
  async function importConnections() {
    if (!data || confirmation !== identity || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await githubProjectAppsApi.importConnections(companyId, data.revision);
      client.setQueryData(githubProjectAppsQueryKey(companyId), result);
      await client.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) });
      const connectionId = result.roles.find(row => requiredAgentId ? row.agentId === requiredAgentId : row.role === "reviewer")?.connectionId;
      if (connectionId) { if (onComplete) onComplete({ connectionId }); else navigate(`/apps/${connectionId}/permissions`); }
      else setError("The import returned no connection. Refresh before retrying.");
    } catch { setError("Could not import the identities. Check native key storage, verified permissions and idle agent runs, then retry."); }
    finally { setBusy(false); setConfirmation(null); }
  }
  return <div className="flex max-w-2xl flex-col gap-6"><div><h1 className="text-lg font-semibold">GitHub App installations</h1><p className="text-sm text-muted-foreground">Use the prepared App identities for this organization.</p></div>
    {query.isPending && <p role="status">Loading prepared identities…</p>}
    {query.isError && <p role="alert">Could not load GitHub App setup. Refresh to try again.</p>}
    {data && (!data.available ? <p role="status">No GitHub App identities are prepared for this organization. Registration and installation must be completed by an authorized GitHub account owner before connecting.</p> : <>
      <p className="text-sm">Paperclip signs locally and connects directly to GitHub. Paperclip Cloud enrollment is not required.</p>
      {requiredAgentId && !data.roles.some(row => row.agentId === requiredAgentId) && <p role="alert" className="text-sm">No prepared App is assigned to the required agent. Review assignment in the connection’s Permissions page.</p>}
      <p className="text-sm">{alreadyConnected ? "These identities are already connected. Open a connection to review its installation, repository scope and agent permissions." : "Connect the three prepared identities using their existing encrypted keys, assignments and selected-repository installations. No project repository is created and GitHub permissions stay unchanged."}</p>
      <ul className="flex flex-col gap-4">{data.roles.map(row => <li key={row.role} className="flex flex-col gap-1"><strong className="text-sm">GitHub · {row.role}</strong><span className="text-sm">{row.login ?? `App ${row.appId}`} · {row.status}</span><span className="text-xs text-muted-foreground">{row.keyStorage === "native_encrypted" ? `Native Secrets · active v${row.pinnedVersion}` : "Native key migration required"} · selected repositories · {row.connectionId ? "Connected" : "Ready to connect"}</span>
        {row.connectionId && <Button variant="link" className="h-auto justify-start p-0" onClick={() => {
          if (onComplete && (!requiredAgentId || row.agentId === requiredAgentId)) onComplete({ connectionId: row.connectionId! });
          else navigate(`/apps/${row.connectionId}/permissions`);
        }}>Open connection</Button>}</li>)}</ul>
      {!alreadyConnected && (data.canManage ? <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmation === identity} disabled={busy} onChange={event => setConfirmation(event.target.checked ? identity : null)} />I confirm importing these three dedicated connections with their existing assignments and access.</label> : <p className="text-sm text-muted-foreground">Connection import requires an instance administrator with connection management access.</p>)}
    </>)}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex items-center justify-between gap-3"><Button variant="ghost" disabled={busy} onClick={() => onCancel ? onCancel() : navigate("/apps")}>{alreadyConnected ? "Done" : "Cancel"}</Button>
      {data?.available && !alreadyConnected && data.canManage && <Button disabled={busy || confirmation !== identity || data.roles.some(row => row.keyStorage !== "native_encrypted") || Boolean(requiredAgentId && !data.roles.some(row => row.agentId === requiredAgentId))} onClick={() => void importConnections()}>{busy ? "Verifying and importing…" : "Verify and connect identities"}</Button>}</div>
  </div>;
}
