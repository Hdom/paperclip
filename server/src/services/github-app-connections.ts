import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, heartbeatRuns, githubAppSettings, connectionGrants, toolApplications, toolConnectionInstalls, toolConnections, type Db } from "@paperclipai/db";
import { conflict, forbidden } from "../errors.js";
import { projectAppsConfigSchema } from "./github-project-apps.js";
import type { ProjectAppsConfig, ProjectAppRole } from "./github-project-apps.js";

const roles = ["coordinator", "implementer", "reviewer"] as const;
const endpoint = "https://api.github.com";
type Connection = typeof toolConnections.$inferSelect;
type Grant = typeof connectionGrants.$inferSelect;

/** Public connection identity; never a credential projection or a signer reference. */
export function appConnectionConfig(config: ProjectAppsConfig, role: ProjectAppRole) {
  const app = config.apps[role];
  return { sourceTemplateKey: "github", connectionMethodKey: "app-installation", url: endpoint,
    githubApp: { role, appId: app.appId, installationId: app.installationId, scope: "current_project" } };
}

export function assertAppConnectionIdentity(connection: Connection, config: ProjectAppsConfig, role: ProjectAppRole) {
  const expected = appConnectionConfig(config, role);
  const stored = connection.config.githubApp as Record<string, unknown> | undefined;
  const expectedIdentity = expected.githubApp;
  if (connection.companyId !== config.companyId || connection.authKind !== "github_app"
      || connection.credentialPolicy !== "per_agent" || connection.transport !== "rest_api"
      || connection.connectionPurpose !== "tool"
      || Object.keys(connection.config).some(key => !["sourceTemplateKey", "connectionMethodKey", "url", "githubApp"].includes(key))
      || Object.keys(connection.transportConfig).length !== 1 || connection.transportConfig.url !== endpoint
      || connection.credentialSource !== "paperclip_vault" || connection.externalCredential
      || connection.credentialRefs.length || connection.credentialSecretRefs.length
      || connection.config.sourceTemplateKey !== expected.sourceTemplateKey
      || connection.config.connectionMethodKey !== expected.connectionMethodKey
      || connection.config.url !== endpoint
      || !stored || Object.keys(stored).length !== 4
      || stored.role !== expectedIdentity.role || stored.appId !== expectedIdentity.appId
      || stored.installationId !== expectedIdentity.installationId || stored.scope !== expectedIdentity.scope)
    throw forbidden("GitHub App connection no longer matches its verified identity");
}

export function assertAppConnectionGrant(grant: Grant, connection: Connection, config: ProjectAppsConfig, role: ProjectAppRole) {
  const app = config.apps[role], identity = grant.providerTenant?.githubApp;
  if (grant.companyId !== config.companyId || grant.connectionId !== connection.id || grant.kind !== "agent"
      || grant.subjectAgentId !== app.agentId || grant.subjectUserId !== null || grant.status !== "active"
      || grant.credentialSecretRefs.length || grant.externalCredential || grant.providerTenant?.github || grant.providerTenant?.oauth
      || Object.keys(grant.providerTenant ?? {}).length !== 1
      || identity?.role !== role || identity.appId !== app.appId || identity.installationId !== app.installationId
      || identity.scope !== "current_project" || !["verified", "unverified"].includes(identity.tools))
    throw forbidden("GitHub App grant no longer matches its dedicated agent");
}

/** A fixed role is deliberately not writable through generic connection/grant APIs. */
export function assertNotAppConnection(connection: { authKind: string; config?: Record<string, unknown> }, proposed?: { authKind?: string; config?: Record<string, unknown>; transportConfig?: Record<string, unknown> }) {
  if (connection.authKind === "github_app" || connection.config?.githubApp
      || proposed?.authKind === "github_app" || proposed?.config?.githubApp || proposed?.transportConfig?.githubApp
      || proposed?.config?.connectionMethodKey === "app-installation")
    throw forbidden("Manage this GitHub App identity from its verified connection settings");
}

export async function nativeAppConnection(db: Db, config: ProjectAppsConfig, role: ProjectAppRole, requireEnabled = true) {
  const rows = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, config.companyId),
    eq(toolConnections.uid, `github/project-app-${role}`))).limit(2);
  const [nativeSettings] = await db.select({ settings: githubAppSettings.settings }).from(githubAppSettings)
    .where(eq(githubAppSettings.companyId, config.companyId));
  if (!rows.length) {
    if (nativeSettings) throw forbidden("Native GitHub App connection is missing; legacy authority is not substituted");
    return null; // Explicit legacy compatibility only before native import.
  }
  if (!nativeSettings) throw forbidden("Native GitHub App settings are missing; legacy authority is not substituted");
  if (JSON.stringify(projectAppsConfigSchema.parse(nativeSettings.settings)) !== JSON.stringify(projectAppsConfigSchema.parse(config)))
    throw forbidden("GitHub App authority changed; reload the current native settings");
  if (rows.length !== 1) throw forbidden("GitHub App identity is ambiguous");
  const connection = rows[0]!;
  assertAppConnectionIdentity(connection, config, role);
  const [application] = await db.select({ type: toolApplications.type, key: toolApplications.applicationKey, status: toolApplications.status }).from(toolApplications)
    .where(and(eq(toolApplications.companyId, config.companyId), eq(toolApplications.id, connection.applicationId)));
  if (application?.type !== "mcp_http" || application.key !== "github" || application.status !== "active")
    throw forbidden("GitHub App application is unavailable");
  if (requireEnabled && (!connection.enabled || connection.status !== "active" || config.enabled === false))
    throw forbidden("GitHub App connection is paused");
  const grants = await db.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, config.companyId),
    eq(connectionGrants.connectionId, connection.id), eq(connectionGrants.status, "active")));
  if (grants.length !== 1) throw forbidden("GitHub App connection requires one dedicated grant");
  const grant = grants[0]!;
  assertAppConnectionGrant(grant, connection, config, role);
  const installs = await db.select().from(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.companyId, config.companyId),
    eq(toolConnectionInstalls.connectionId, connection.id)));
  if (installs.length !== 1 || installs[0]!.targetType !== "agent" || installs[0]!.targetId !== config.apps[role].agentId)
    throw forbidden("GitHub App connection assignment changed");
  return { connection, grant };
}

/** Paused agent-row locks fence activation while native authority is replaced. */
export async function requirePausedAppAgents(db: Db, companyId: string, ids: string[]) {
  const unique = [...new Set(ids)].sort();
  const found = await db.select({ id: agents.id, status: agents.status }).from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, unique))).orderBy(agents.id).for("no key update");
  if (found.length !== unique.length || found.some(agent => agent.status !== "paused"))
    throw conflict("Pause and drain the affected agents before changing GitHub App identities");
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.agentId, unique), inArray(heartbeatRuns.status, ["queued", "running"]))).limit(1);
  if (active) throw conflict("Wait for affected agent runs to settle before changing GitHub App identities");
}

/** Idempotent operator import. Existing unrelated GitHub connections and native keys are untouched. */
export async function importAppConnections(db: Db, config: ProjectAppsConfig, actorUserId: string,
  verified: { role: ProjectAppRole; status: string; login: string | null }[]) {
  if (roles.some(role => !config.apps[role].signingKeySecret || verified.find(row => row.role === role)?.status !== "verified"))
    throw forbidden("Verify all native GitHub App identities before importing connections");
  const validated = projectAppsConfigSchema.parse(config);
  return db.transaction(async tx => {
    await requirePausedAppAgents(tx as unknown as Db, config.companyId, roles.map(role => config.apps[role].agentId));
    // Serialize this company's explicit import without a background reconciler.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`github-app-connections:${config.companyId}`}, 0))`);
    const [existingApp] = await tx.select().from(toolApplications).where(and(eq(toolApplications.companyId, config.companyId), eq(toolApplications.applicationKey, "github")));
    const application = existingApp ?? (await tx.insert(toolApplications).values({ companyId: config.companyId,
      applicationKey: "github", name: "GitHub", type: "mcp_http", ownerUserId: actorUserId }).returning())[0]!;
    if (application.type !== "mcp_http" || application.status !== "active") throw conflict("The existing GitHub app must be active before importing identities");
    const result = [];
    for (const role of roles) {
      const [existing] = await tx.select().from(toolConnections).where(and(eq(toolConnections.companyId, config.companyId), eq(toolConnections.uid, `github/project-app-${role}`)));
      if (existing) {
        // Never repair drift by overwriting a stored identity or expanding its audience.
        const current = await nativeAppConnection(tx as unknown as Db, config, role, false);
        if (!current) throw conflict("GitHub App import changed");
        result.push({ role, connectionId: existing.id }); continue;
      }
      const [connection] = await tx.insert(toolConnections).values({ companyId: config.companyId, applicationId: application.id,
        name: `GitHub · ${role[0]!.toUpperCase()}${role.slice(1)}`, uid: `github/project-app-${role}`, connectionKind: "managed",
        connectionPurpose: "tool", ownership: "customer", transport: "rest_api", authKind: "github_app",
        credentialPolicy: "per_agent", credentialSource: "paperclip_vault", status: "active", enabled: config.enabled !== false,
        config: appConnectionConfig(config, role), transportConfig: { url: endpoint }, healthStatus: "healthy",
        healthMessage: "GitHub App verified. Review the current-project API actions before allowing them.",
        healthCheckedAt: new Date(), createdByUserId: actorUserId }).returning();
      const app = config.apps[role];
      await tx.insert(connectionGrants).values({ companyId: config.companyId, connectionId: connection!.id, kind: "agent",
        subjectAgentId: app.agentId, providerTenant: { githubApp: { role, appId: app.appId, installationId: app.installationId,
          login: verified.find(row => row.role === role)!.login, scope: "current_project", tools: "unverified" } },
        status: "active", isDefault: false, createdByUserId: actorUserId });
      await tx.insert(toolConnectionInstalls).values({ companyId: config.companyId, connectionId: connection!.id,
        targetType: "agent", targetId: app.agentId, createdByUserId: actorUserId });
      result.push({ role, connectionId: connection!.id });
    }
    const [stored] = await tx.select().from(githubAppSettings).where(eq(githubAppSettings.companyId, config.companyId));
    if (!stored) await tx.insert(githubAppSettings).values({ companyId: config.companyId, settings: validated, revision: config.revision ?? 0 });
    else if (JSON.stringify(projectAppsConfigSchema.parse(stored.settings)) !== JSON.stringify(validated))
      throw conflict("Native GitHub App settings changed during import");
    return result;
  });
}
