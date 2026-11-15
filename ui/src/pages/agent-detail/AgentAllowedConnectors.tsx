import { useMemo } from "react";
import { ArrowUpRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toolsApi } from "@/api/tools";
import { AgentPanel } from "@/components/agent-detail/AgentPanels";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { useGitHubProjectApps } from "@/components/GitHubProjectAppControls";
import { AppLogo } from "../apps/AppLogo";

const SHOWN_LOGOS = 3;

export function AgentAllowedConnectors({ agentId, companyId }: { agentId: string; companyId: string }) {
  const effective = useQuery({
    queryKey: queryKeys.tools.effectiveProfilesForAgent(companyId, agentId),
    queryFn: () => toolsApi.getEffectiveProfilesForAgent(companyId, agentId),
  });
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });
  const applications = useQuery({
    queryKey: queryKeys.tools.applications(companyId),
    queryFn: () => toolsApi.listApplications(companyId),
  });

  const projectApps = useGitHubProjectApps(companyId);
  const nativeGitHub = effective.data?.installedConnections?.filter(connection => connection.authKind === "github_app") ?? [];
  const apps = useMemo(() => {
    const connectionApp = new Map((connections.data?.connections ?? []).map((connection) => [connection.id, connection.applicationId]));
    const appById = new Map((applications.data?.applications ?? []).map((application) => [application.id, application]));
    const seen = new Map<string, { id: string; name: string; key?: string }>();
    for (const tool of effective.data?.allowedTools ?? []) {
      const applicationId = connectionApp.get(tool.connectionId);
      const application = applicationId ? appById.get(applicationId) : undefined;
      if (!application || seen.has(application.id)) continue;
      seen.set(application.id, { id: application.id, name: application.name, key: application.applicationKey });
    }
    return [...seen.values()];
  }, [applications.data?.applications, connections.data?.connections, effective.data?.allowedTools]);

  const loading = effective.isLoading || connections.isLoading || applications.isLoading;
  const failed = effective.error || connections.error || applications.error;

  return (
    <AgentPanel
      title="Allowed connectors"
      aria-label="Allowed connectors"
      action={
        <Button variant="ghost" size="icon-xs" asChild>
          <Link to="/apps?source=installed" aria-label="Manage connectors" title="Manage connectors">
            <ArrowUpRight className="size-4" />
          </Link>
        </Button>
      }
    >
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-3 px-(--agent-detail-module-inset) pb-(--agent-detail-module-inset)">
        {loading ? (
          <p role="status" className="text-xs text-muted-foreground">Resolving access…</p>
        ) : failed ? (
          <p role="alert" className="text-xs text-destructive">Couldn’t load this agent’s connectors.</p>
        ) : apps.length === 0 && nativeGitHub.length === 0 ? (
          <p className="text-xs text-muted-foreground">No connector tools are allowed yet.</p>
        ) : (
          <ul aria-label="Connectors" className="flex max-h-(--agent-detail-logo-rows-h) flex-wrap gap-3 overflow-hidden">
            {apps.slice(0, SHOWN_LOGOS).map((app) => (
              <li key={app.id} className="flex shrink-0" title={app.name}>
                <AppLogo name={app.name} brandKey={app.key} size={24} compact />
              </li>
            ))}
          </ul>
        )}
        {projectApps.data?.blockedAgentIds.includes(agentId) && nativeGitHub.length === 0 && <p role="status" className="text-xs text-muted-foreground">Managed GitHub access paused. This former assignment remains blocked; personal GitHub credentials are not substituted.</p>}
        {projectApps.isError && <div className="flex flex-col gap-2"><p role="alert" className="text-xs text-destructive">Could not load GitHub identity status. Existing access is unchanged.</p><Button variant="outline" size="sm" onClick={() => void projectApps.refetch()}>Retry GitHub status</Button></div>}
        {nativeGitHub.map(connection => {
          const identity = projectApps.data?.roles.find(row => row.connectionId === connection.id && row.agentId === agentId);
          return <section key={connection.id} aria-label={connection.name} className="flex flex-col gap-2 text-sm">
            <Link className="font-medium underline-offset-4 hover:underline" to={`/apps/${connection.id}/permissions`}>{connection.name} ↗</Link>
            <p className="break-words">{identity?.login ?? "GitHub App · dedicated identity"}</p>
            <p className="text-xs text-muted-foreground">{connection.enabled && projectApps.data?.enabled !== false ? (identity?.status ?? "Checking identity…") : "Managed GitHub access paused"} · Current project scope</p>
            <p className="text-xs text-muted-foreground">{identity?.role === "coordinator" ? "Paperclip project provisioning" : "Git and gh · API actions follow connector permissions"}</p>
            {projectApps.isError && <p role="alert" className="text-xs text-destructive">Could not load verified identity details. Refresh to try again.</p>}
          </section>;
        })}
      </div>
    </AgentPanel>
  );
}
