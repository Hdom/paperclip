import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "./run-identity.js";
import { boundRunIssueId } from "./run-task-binding.js";
import { allowsGitHubCredentialExport } from "./github-credential-policy.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { logActivity } from "./activity-log.js";
import { createProjectAppBroker, loadProjectAppsConfig, projectAppRole, type ProjectAppsConfig } from "./github-project-apps.js";
import { secretService } from "./secrets.js";
import type { GitCredential } from "./git-credentials.js";

type RunInput = { companyId: string; agentId: string; runId: string };

function assertRunNotStopping(run: { status: string; resultJson: Record<string, unknown> | null } | undefined) {
  const result = run?.resultJson;
  const native = result?.nativeCancellation as Record<string, unknown> | undefined;
  // Same durable stop fences used by worker-supervision and native session
  // admission. A running status does not erase an already accepted Stop.
  if (!run || run.status !== "running" || result?.startupCancellation || result?.executionCancellation || result?.cancellation ||
      result?.reassignmentStopRequested === true || (native?.scope === "run" && ["pending", "acknowledged"].includes(String(native.dispatchState))))
    throw forbidden("GitHub App authority ended when Stop or reassignment was requested");
}

async function authorizedProject(db: Db, config: ProjectAppsConfig, input: RunInput) {
  const currentConfig = await loadProjectAppsConfig();
  if (currentConfig?.enabled === false || JSON.stringify(currentConfig) !== JSON.stringify(config)) throw forbidden("GitHub App configuration changed; retry with current authority");
  const { run, context } = await captureRunIdentity(db, input);
  assertRunNotStopping(run);
  const issueId = boundRunIssueId(run);
  const taskReferences = [run.nativeIssueId, run.issueId, run.contextSnapshot?.issueId, run.contextSnapshot?.taskId].filter(value => value !== null && value !== undefined);
  if (!issueId || taskReferences.some(value => value !== issueId) || !context ||
      !(await allowsGitHubCredentialExport(db, run, issueId)))
    throw forbidden("This run cannot acquire GitHub App authority");
  const [issue] = issueId ? await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId))) : [];
  if (!issue?.projectId || issue.hiddenAt || issue.assigneeAgentId !== input.agentId ||
      (issue.executionRunId ?? issue.checkoutRunId) !== input.runId ||
      (run.contextSnapshot?.projectId !== undefined && run.contextSnapshot.projectId !== issue.projectId) ||
      ["done", "cancelled", "blocked"].includes(issue.status))
    throw forbidden("GitHub App operations require the currently owned project task execution");
  const [project] = await db.select().from(projects).where(and(eq(projects.id, issue.projectId), eq(projects.companyId, input.companyId)));
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
  if (!project || project.archivedAt || project.pausedAt || !agent || ["paused", "terminated"].includes(agent.status) ||
      await issueTreeControlService(db).getActivePauseHoldGate(input.companyId, issue.id))
    throw forbidden("GitHub App operations are unavailable for paused, archived, or held work");
  const [latest] = await db.select({ status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)));
  assertRunNotStopping(latest);
  return { project, issue, run };
}

/** Optional controller-managed identity. A configured role never falls back to a personal token. */
export async function resolveProjectAppCredential(db: Db, companyId: string, context: {
  agentId?: string | null; heartbeatRunId?: string | null;
}): Promise<{ configured: boolean; identitySource?: "dedicated"; credential?: GitCredential; error?: string } | null> {
  const config = await loadProjectAppsConfig();
  if (!config || !context.agentId) return null;
  const role = projectAppRole(config, companyId, context.agentId);
  if (!role) return null;
  if (role === "blocked" || config.enabled === false) return { configured: true, identitySource: "dedicated", error: "Managed GitHub App access is paused; personal credentials are not substituted" };
  if (role === "coordinator") return { configured: true, identitySource: "dedicated", error: "Coordinator uses project provisioning; its App token is never exported" };
  if (!context.heartbeatRunId) return { configured: true, identitySource: "dedicated", error: "GitHub App credentials require an active project run" };
  const input = { companyId, agentId: context.agentId, runId: context.heartbeatRunId };
  try {
    const { project, issue } = await authorizedProject(db, config, input);
    const reauthorize = async () => {
      const current = await authorizedProject(db, config, input);
      if (current.project.id !== project.id || current.issue.id !== issue.id) throw forbidden("Project task binding changed");
    };
    await logActivity(db, { companyId, actorType: "agent", actorId: input.agentId, agentId: input.agentId, runId: input.runId,
      issueId: issue.id, entityType: "project", entityId: project.id, action: "github_project_app.token_requested", details: { role } });
    const issued = await createProjectAppBroker(config, { beforeMutation: reauthorize, signKey: (role, appId, ref) => secretService(db).signControllerGitHubAppJwt(config.companyId, ref.secretId, ref.version, role, appId) }).workerCredential(role, project.id, reauthorize);
    return { configured: true, identitySource: "dedicated", credential: {
      token: issued.token, source: "managed_connection", secretName: null, identitySource: "dedicated",
      githubIdentity: { userId: issued.userId, login: issued.login },
    } };
  } catch {
    return { configured: true, identitySource: "dedicated", error: "Project GitHub App access is unavailable; check the project binding, run authority, and exact installation permissions" };
  }
}

/** No caller-supplied project, repository, role, App, installation, permission, or secret is accepted. */
export async function provisionRunProjectRepository(db: Db, input: RunInput, assertActive?: () => void) {
  assertActive?.();
  const config = await loadProjectAppsConfig();
  if (!config || config.enabled === false || projectAppRole(config, input.companyId, input.agentId) !== "coordinator")
    throw forbidden("Only the configured Coordinator can provision project repositories");
  const { project, issue } = await authorizedProject(db, config, input);
  const reauthorize = async () => {
    assertActive?.();
    const current = await authorizedProject(db, config, input);
    if (current.project.id !== project.id || current.issue.id !== issue.id) throw forbidden("Project task binding changed");
    const workspaces = await db.select({ repoUrl: projectWorkspaces.repoUrl }).from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, project.id)));
    const intended = `https://github.com/${config.owner}/paperclip-${project.id}`;
    if (workspaces.some(workspace => workspace.repoUrl && workspace.repoUrl.replace(/\.git$/, "").replace(/\/$/, "") !== intended))
      throw forbidden("This project already references another repository; existing repository access was preserved");
    assertActive?.();
  };
  await reauthorize();
  const audit = (action: string, details?: Record<string, unknown>) => logActivity(db, {
    companyId: input.companyId, actorType: "agent", actorId: input.agentId, agentId: input.agentId,
    runId: input.runId, issueId: issue.id, entityType: "project", entityId: project.id, action, details,
  });
  await audit("github_project_app.provision_requested");
  try {
    const result = await createProjectAppBroker(config, { beforeMutation: reauthorize, assertActive, signKey: (role, appId, ref) => secretService(db).signControllerGitHubAppJwt(config.companyId, ref.secretId, ref.version, role, appId) }).provision(project.id, reauthorize);
    await audit("github_project_app.provision_ready", { repositoryId: result.repositoryId, repositoryUrl: result.repositoryUrl });
    return result;
  } catch (error) {
    await audit("github_project_app.provision_blocked");
    throw error;
  }
}
