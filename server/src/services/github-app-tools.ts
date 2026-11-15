import { isDeepStrictEqual } from "node:util";
import type { Db, toolConnections } from "@paperclipai/db";
import { forbidden, conflict } from "../errors.js";
import { appConfigSnapshot } from "./github-app-config.js";
import { nativeAppConnection } from "./github-app-connections.js";
import { authorizedProject } from "./github-project-app-runtime.js";
import { createProjectAppBroker, projectAppRole } from "./github-project-apps.js";
import { secretService } from "./secrets.js";
import { logActivity } from "./activity-log.js";
import { nativeRestSender, type NativeRestRequest } from "./native-rest-client.js";
import { GITHUB_APP_BINDING, gitHubAppRoleTools, gitHubAppToolRequest, isGitHubAppApiConnection, validateGitHubAppToolArguments } from "./github-app-tool-catalog.js";

type Connection = typeof toolConnections.$inferSelect;
type RunBinding = { companyId: string; agentId: string | null; runId?: string | null; issueId?: string | null; projectId?: string | null };
async function connectionAuthority(db: Db, connection: Connection) {
  if (!isGitHubAppApiConnection(connection)) throw forbidden("This connection is not the native GitHub App API method");
  const snapshot = await appConfigSnapshot(db, connection.companyId);
  if (!snapshot || snapshot.storage !== "native") throw forbidden("Import and verify this App identity before publishing its API actions");
  const role = (Object.keys(snapshot.config.apps) as (keyof typeof snapshot.config.apps)[])
    .find(role => `github/project-app-${role}` === connection.uid);
  if (!role) throw forbidden("The App connection has no prepared role");
  const native = await nativeAppConnection(db, snapshot.config, role, false);
  if (!native || native.connection.id !== connection.id) throw forbidden("The App connection identity changed");
  return { ...snapshot, role, native };
}

/** Static, reviewed catalog publication: no credentials, project selection or network. */
export async function discoverGitHubAppTools(db: Db, connection: Connection) {
  const { role } = await connectionAuthority(db, connection);
  return gitHubAppRoleTools(role);
}

/** Generic action policies may change; native identity/audience/issuance may not. */
export async function assertGitHubAppActionAudience(db: Db, connection: Connection, access: "all_agents" | { agentIds: string[] }, preserveExistingAccess?: boolean) {
  const authority = await connectionAuthority(db, connection);
  if (preserveExistingAccess || access === "all_agents" || access.agentIds.length !== 1
    || access.agentIds[0] !== authority.config.apps[authority.role].agentId)
    throw forbidden("Change this App's dedicated agent only through its verified identity settings");
}

export async function gitHubAppToolGrant(db: Db, session: RunBinding, connection: Connection) {
  const authority = await connectionAuthority(db, connection);
  if (!session.agentId || session.companyId !== connection.companyId
    || authority.config.enabled === false || !authority.native.connection.enabled
    || authority.config.apps[authority.role].agentId !== session.agentId)
    throw forbidden("This App connection is dedicated to another agent or is paused");
  return authority.native.grant;
}

async function projectAuthority(db: Db, session: RunBinding, connection: Connection, name: string) {
  if (!session.agentId || !session.runId || session.companyId !== connection.companyId)
    throw forbidden("GitHub App actions require a currently authorized project run");
  const authority = await connectionAuthority(db, connection);
  const role = projectAppRole(authority.config, session.companyId, session.agentId);
  if (role !== authority.role || (role !== "implementer" && role !== "reviewer")
    || !gitHubAppRoleTools(role).some(tool => tool.name === name))
    throw forbidden("This App role does not permit that GitHub action");
  const input = { companyId: session.companyId, agentId: session.agentId, runId: session.runId };
  const current = await authorizedProject(db, authority.config, input);
  if ((session.issueId && session.issueId !== current.issue.id) || (session.projectId && session.projectId !== current.project.id))
    throw forbidden("The action no longer belongs to its reviewed project task");
  const broker = createProjectAppBroker(authority.config, { signKey: (role, appId, ref) => secretService(db)
    .signControllerGitHubAppJwt(session.companyId, ref.secretId, ref.version, role, appId) });
  const repository = await broker.projectBinding(current.project.id);
  if (!repository || repository.phase !== "ready" || !repository.repositoryId)
    throw conflict("Coordinator must provision this project repository before GitHub actions are available");
  const binding = { revision: authority.revision, connectionId: connection.id, grantId: authority.native.grant.id, role,
    runId: session.runId, issueId: current.issue.id, projectId: current.project.id, repositoryId: repository.repositoryId };
  return { ...authority, ...current, role, broker, repository, binding };
}

/** Bind before policy, hashing and signed approval. A caller cannot select the target. */
export async function bindGitHubAppToolArguments(db: Db, session: RunBinding, connection: Connection, name: string, parameters: unknown) {
  const args = validateGitHubAppToolArguments(name, parameters);
  const authority = await projectAuthority(db, session, connection, name);
  // Validate path/ref/payload before minting or requesting action approval.
  gitHubAppToolRequest(name, args, authority.repository.fullName);
  return { ...args, [GITHUB_APP_BINDING]: authority.binding };
}

/** Controller-only token use. The public gateway retains policy, approval and audit. */
export async function executeGitHubAppTool(db: Db, session: RunBinding, connection: Connection, name: string, parameters: unknown,
  request: NativeRestRequest, signal: AbortSignal, deadlineAt: number) {
  const args = validateGitHubAppToolArguments(name, parameters);
  const authority = await projectAuthority(db, session, connection, name);
  if (!isDeepStrictEqual(args[GITHUB_APP_BINDING], authority.binding))
    throw conflict("GitHub App authority changed since this action was reviewed; review it again");
  const action = gitHubAppToolRequest(name, args, authority.repository.fullName);
  const reauthorize = async () => {
    if (signal.aborted || Date.now() >= deadlineAt) throw forbidden("The GitHub action deadline ended");
    const latest = await projectAuthority(db, session, connection, name);
    if (!isDeepStrictEqual(latest.binding, authority.binding) || latest.repository.fullName !== authority.repository.fullName)
      throw forbidden("The reviewed GitHub project authority changed");
  };
  await reauthorize();
  await logActivity(db, { companyId: session.companyId, actorType: "agent", actorId: session.agentId!, agentId: session.agentId!, runId: session.runId!,
    issueId: authority.issue.id, entityType: "project", entityId: authority.project.id, action: "github_project_app.tool_requested",
    details: { role: authority.role, connectionId: connection.id, grantId: authority.native.grant.id, tool: name, repositoryId: authority.repository.repositoryId } });
  const broker = createProjectAppBroker(authority.config, {
    fetch: (url, init) => {
      // Credential cleanup has a separate bounded budget and remains available
      // after Stop/deadline. Every other provider request shares this action's
      // signal, including mint and repository/identity verification.
      const cleanup = String(url) === "https://api.github.com/installation/token" && init?.method === "DELETE";
      if (cleanup) return fetch(url, init);
      if (signal.aborted || Date.now() >= deadlineAt) throw forbidden("The GitHub action deadline ended");
      return fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
    }, beforeMutation: reauthorize,
    assertActive: () => { if (signal.aborted || Date.now() >= deadlineAt) throw forbidden("The GitHub action deadline ended"); },
    signKey: (role, appId, ref) => secretService(db).signControllerGitHubAppJwt(session.companyId, ref.secretId, ref.version, role, appId) });
  const credential = await broker.workerCredential(authority.role, authority.project.id, reauthorize);
  let revoked = false, result: unknown;
  try {
    const sender = nativeRestSender({ provider: "GitHub", code: "github_app", authorization: `Bearer ${credential.token}`,
      request: async (url, init) => { await reauthorize(); return request(url, init); }, signal, deadlineAt,
      fixedHeaders: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
      deniedMessage: "GitHub refused this App action. Its identity, permissions and project repository scope must be verified; no alternate credential is used." });
    // A review explicitly names the head commit it reviewed. Do not approve a
    // different head if the PR advanced between review and provider dispatch.
    if (name === "github_project_submit_review") {
      const pr = await sender.send(action.url.replace(/\/reviews$/, ""), { method: "GET" }) as { head?: { sha?: string } };
      if (pr?.head?.sha !== args.commitSha) throw conflict("The pull request head changed; review its current commit before submitting");
    }
    result = await sender.send(action.url, action.init);
  } finally {
    revoked = await broker.revokeWorkerToken(credential.token);
    // Preserve the action's provider outcome; cleanup uncertainty must not
    // turn a successful write into an instruction to blindly repeat it.
    await logActivity(db, { companyId: session.companyId, actorType: "system", actorId: "github-app-tools", agentId: session.agentId!, runId: session.runId!,
      issueId: authority.issue.id, entityType: "project", entityId: authority.project.id, action: "github_project_app.tool_token_cleanup",
      details: { role: authority.role, connectionId: connection.id, tool: name, revoked, expiresAt: credential.expiresAt } }).catch(() => {});
  }
  return { result, credentialCleanup: revoked ? "revoked" : "expiry_pending", ...(revoked ? {} : { credentialExpiresAt: credential.expiresAt }) };
}
