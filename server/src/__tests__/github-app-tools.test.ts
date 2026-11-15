import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issues, projects, toolActionRequests, toolProfiles, toolProfileBindings } from "@paperclipai/db";
import { projectAppSandbox } from "./helpers/project-app-sandbox.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { githubProjectAppAdmin } from "../services/github-project-app-admin.js";
import { appConfigSnapshot, saveAppConfig } from "../services/github-app-config.js";
import { nativeAppConnection } from "../services/github-app-connections.js";
import { projectAppsConfigSnapshot, type ProjectAppRole } from "../services/github-project-apps.js";
import { secretService } from "../services/secrets.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { provisionRunProjectRepository } from "../services/github-project-app-runtime.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { bindGitHubAppToolArguments, executeGitHubAppTool } from "../services/github-app-tools.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native GitHub App governed API actions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  let sandbox: Awaited<ReturnType<typeof projectAppSandbox>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("github-app-tools-"); db = createDb(database.connectionString); }, 90000);
  afterAll(async () => { await database?.cleanup(); }, 60000);
  beforeEach(async () => {
    sandbox = await projectAppSandbox(); vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", sandbox.configPath);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "d".repeat(64)); vi.stubGlobal("fetch", sandbox.fetchImpl);
    const companyId = sandbox.config.companyId;
    await db.insert(companies).values({ id: companyId, name: "Synthetic App tools", issuePrefix: companyId.slice(0, 8) });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: companyId, membershipRole: "owner", status: "active" });
    const candidate = structuredClone(sandbox.config);
    for (const role of ["coordinator", "implementer", "reviewer"] as const) {
      const app = candidate.apps[role];
      await db.insert(agents).values({ id: app.agentId, companyId, name: role, adapterType: "process", status: "paused" });
      const key = await secretService(db).createControllerSigningKey(companyId, role, app.appId, await readFile(app.privateKeyPath!, "utf8"), companyId);
      delete app.privateKeyPath; app.signingKeySecret = { secretId: key.id, version: 1 };
    }
    await writeFile(sandbox.configPath, JSON.stringify(candidate), { mode: 0o600 });
    await githubProjectAppAdmin(db).importConnections(companyId, (await projectAppsConfigSnapshot())!.revision, companyId);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.companyId, companyId));
  });
  afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await sandbox.cleanup(); });
  async function run(role: ProjectAppRole, projectId?: string, assignedAgentId?: string) {
    const companyId = sandbox.config.companyId, agentId = assignedAgentId ?? sandbox.config.apps[role].agentId;
    if (!projectId) { const [project] = await db.insert(projects).values({ companyId, name: "Synthetic enrolled project" }).returning(); projectId = project!.id; }
    const [issue] = await db.insert(issues).values({ companyId, projectId, title: "Synthetic native action", status: "in_progress", assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue!.id, scopeKind: "issue", status: "running", responsibleUserId: companyId, invocationSource: "on_demand", contextSnapshot: { issueId: issue!.id, projectId } }).returning();
    await db.update(issues).set({ executionRunId: run!.id, checkoutRunId: run!.id }).where(eq(issues.id, issue!.id));
    await initializeRunIdentity(db, { companyId, runId: run!.id, responsibleUserId: companyId, cause: "instruction" });
    return { companyId, agentId, runId: run!.id, issueId: issue!.id, projectId };
  }
  async function fixture(role: "implementer" | "reviewer" = "implementer", askName?: string) {
    const coordinator = await run("coordinator"), provisioned = await provisionRunProjectRepository(db, coordinator);
    const input = await run(role, coordinator.projectId), snapshot = (await appConfigSnapshot(db, input.companyId))!;
    const native = (await nativeAppConnection(db, snapshot.config, role))!;
    const service = toolAccessService(db, { remoteHttpRequest: sandbox.fetchImpl, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const publicMetadata = await githubProjectAppAdmin(db).settings(input.companyId, false);
    expect(publicMetadata.roles.find(app => app.role === role)?.pinnedVersion).toBe(1);
    expect(publicMetadata.roles.find(app => app.role === role)?.latestVersion).toBe(1);
    expect(publicMetadata.roles.find(app => app.role === role)?.secretId).toBeNull();
    const before = sandbox.requests.length;
    const catalog = (await service.refreshCatalog(native.connection.id, { actorType: "user", actorId: input.companyId })).catalog;
    expect(sandbox.requests.length).toBe(before); // Background publication never mints or probes.
    expect(catalog.every(tool => tool.status === "quarantined")).toBe(true);
    await service.finishGalleryAppConnection(input.companyId, native.connection.id, { enabledCatalogEntryIds: catalog.map(tool => tool.id), reviewedCatalogEntryIds: catalog.map(tool => tool.id),
      askFirstCatalogEntryIds: catalog.filter(tool => tool.toolName === askName).map(tool => tool.id), access: { agentIds: [input.agentId] } }, { actorType: "user", actorId: input.companyId });
    const gateway = createToolGatewayService(db, { remoteHttpRequest: sandbox.fetchImpl, toolActionSigningSecret: "synthetic-app-action-signing-secret" });
    const session = await gateway.createSession(input);
    const tools = await gateway.listToolsForSession(session.token);
    async function call(name: string, parameters: unknown) {
      const tool = tools.find(tool => tool.connectionId === native.connection.id && tool.upstreamToolName === name);
      expect(tool, name).toBeTruthy(); return gateway.executeTool({ sessionToken: session.token, tool: tool!.name, parameters, idempotencyKey: randomUUID() });
    }
    return { ...input, native, service, catalog, gateway, session, tools, call, provisioned };
  }
  it("publishes static role-scoped actions with quarantine and uses the same App bot through the public gateway", async () => {
    const f = await fixture();
    expect(f.tools.some(tool => tool.upstreamToolName === "github_project_submit_review")).toBe(false);
    const branch = await f.call("github_project_create_branch", { branch: "feature/test", commitSha: "a".repeat(40) });
    expect(JSON.stringify(branch)).toContain("refs/heads/feature/test");
    await f.call("github_project_write_file", { path: "src/test.txt", branch: "feature/test", message: "Synthetic change", contentBase64: Buffer.from("synthetic").toString("base64") });
    const result = await f.call("github_project_open_pull_request", { title: "Synthetic PR", head: "feature/test", base: "main" });
    expect(JSON.stringify(result)).toContain("paperclip-implementer[bot]");
    expect(JSON.stringify(result)).not.toContain("synthetic-implementer-");
    expect(sandbox.apiEffects.every(effect => effect.role === "implementer" && effect.path.startsWith(`/repos/Hdom/paperclip-${f.projectId}/`))).toBe(true);
    expect([...sandbox.tokens.values()].some(token => token.repositoryId === f.provisioned.repositoryId)).toBe(false);
    const wrong = randomUUID(); await db.insert(agents).values({ id: wrong, companyId: f.companyId, name: "Other agent", adapterType: "process" });
    await expect(f.service.finishGalleryAppConnection(f.companyId, f.native.connection.id, { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [wrong] } }, { actorType: "user", actorId: f.companyId })).rejects.toThrow("dedicated agent");
  }, 60000);
  it("uses the distinct Reviewer bot and rejects review of a changed head before any review write", async () => {
    const f = await fixture("reviewer");
    expect(f.tools.some(tool => tool.upstreamToolName === "github_project_write_file")).toBe(false);
    await f.call("github_project_read_pull_request", { number: 1 });
    const reviewed = await f.call("github_project_submit_review", { number: 1, commitSha: "a".repeat(40), event: "APPROVE", body: "Synthetic review" });
    expect(JSON.stringify(reviewed)).toContain("paperclip-reviewer[bot]");
    sandbox.apiFaults.headSha = "b".repeat(40);
    await expect(f.call("github_project_submit_review", { number: 1, commitSha: "a".repeat(40), event: "APPROVE" })).rejects.toThrow();
    expect(sandbox.apiEffects.filter(effect => effect.method === "POST" && effect.path.endsWith("/reviews"))).toHaveLength(1);
    expect([...sandbox.tokens.values()].some(token => token.repositoryId === f.provisioned.repositoryId)).toBe(false);
  }, 60000);
  it("keeps Ask-first signed and refuses stale App authority without provider effects", async () => {
    const f = await fixture("implementer", "github_project_open_pull_request");
    await expect(f.call("github_project_open_pull_request", { title: "Needs review", head: "feature/test", base: "main" })).rejects.toMatchObject({ reasonCode: "approval_required" });
    expect(sandbox.apiEffects).toHaveLength(0);
    const [pending] = await db.select().from(toolActionRequests).where(and(eq(toolActionRequests.companyId, f.companyId), eq(toolActionRequests.status, "pending")));
    expect(pending).toBeDefined();
    const snapshot = (await appConfigSnapshot(db, f.companyId))!;
    await saveAppConfig(db, snapshot.config, snapshot.revision);
    const outcome = await f.gateway.approveActionRequest({ companyId: f.companyId, actionRequestId: pending!.id, actor: { userId: f.companyId } });
    expect(outcome.status).toBe("expired");
    expect(sandbox.apiEffects).toHaveLength(0);
  }, 60000);
  it("denies browser/test sessions, wrong roles and target overrides without acquiring credentials", async () => {
    const f = await fixture(); const before = sandbox.requests.length;
    await expect(bindGitHubAppToolArguments(db, { companyId: f.companyId, agentId: f.agentId }, f.native.connection, "github_project_read_file", {})).rejects.toThrow("authorized project run");
    await expect(bindGitHubAppToolArguments(db, f, f.native.connection, "github_project_submit_review", { number: 1, commitSha: "a".repeat(40), event: "APPROVE" })).rejects.toThrow("role");
    await expect(f.call("github_project_read_file", { owner: "other", repo: "public" })).rejects.toThrow();
    expect(sandbox.requests.length).toBe(before);
  }, 60000);
  it("revokes an issued token and dispatches no action if Stop arrives during minting", async () => {
    const f = await fixture();
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await sandbox.fetchImpl(...args);
      const body = typeof args[1]?.body === "string" ? JSON.parse(args[1].body) : null;
      if (String(args[0]).endsWith("/102/access_tokens") && body?.repository_ids)
        await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.runId));
      return response;
    });
    await expect(f.call("github_project_read_file", { path: "README.md" })).rejects.toThrow();
    expect(sandbox.apiEffects).toHaveLength(0);
    expect([...sandbox.tokens.values()].some(token => token.repositoryId === f.provisioned.repositoryId)).toBe(false);
  }, 60000);
  it("does not replay a write with uncertain provider outcome and sanitizes provider errors", async () => {
    const f = await fixture(); sandbox.apiFaults.dropWrite = true;
    await expect(f.call("github_project_open_pull_request", { title: "Uncertain write", head: "feature/test", base: "main" })).rejects.toThrow();
    expect(sandbox.apiEffects.filter(effect => effect.method === "POST")).toHaveLength(1);
    expect([...sandbox.tokens.values()].some(token => token.repositoryId === f.provisioned.repositoryId)).toBe(false);
  }, 60000);
  it("keeps a paused connection paused when reviewing action policies", async () => {
    const f = await fixture(); const snapshot = (await appConfigSnapshot(db, f.companyId))!;
    await githubProjectAppAdmin(db).configure(f.companyId, snapshot.revision, { enabled: false }, f.companyId);
    await f.service.finishGalleryAppConnection(f.companyId, f.native.connection.id, { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [f.agentId] } }, { actorType: "user", actorId: f.companyId });
    expect((await nativeAppConnection(db, (await appConfigSnapshot(db, f.companyId))!.config, "implementer", false))!.connection.enabled).toBe(false);
  }, 60000);
  it("executes a signed Ask-first action exactly once with its reviewed App identity", async () => {
    const f = await fixture("implementer", "github_project_open_pull_request");
    await expect(f.call("github_project_open_pull_request", { title: "Reviewed write", head: "feature/test", base: "main" })).rejects.toMatchObject({ reasonCode: "approval_required" });
    expect(sandbox.apiEffects).toHaveLength(0);
    const [pending] = await db.select().from(toolActionRequests).where(and(eq(toolActionRequests.companyId, f.companyId), eq(toolActionRequests.status, "pending")));
    const approved = await f.gateway.approveActionRequest({ companyId: f.companyId, actionRequestId: pending!.id, actor: { userId: f.companyId } });
    expect(approved.status).toBe("executed");
    expect(sandbox.apiEffects.filter(effect => effect.method === "POST")).toHaveLength(1);
    expect(sandbox.apiEffects[0]!.role).toBe("implementer");
    await f.gateway.approveActionRequest({ companyId: f.companyId, actionRequestId: pending!.id, actor: { userId: f.companyId } });
    expect(sandbox.apiEffects.filter(effect => effect.method === "POST")).toHaveLength(1);
  }, 60000);
  it.each(["stop", "repository"] as const)("refuses a queued approved action after %s drift", async drift => {
    const f = await fixture("implementer", "github_project_open_pull_request");
    await expect(f.call("github_project_open_pull_request", { title: "Reviewed write", head: "feature/test", base: "main" })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [pending] = await db.select().from(toolActionRequests).where(and(eq(toolActionRequests.companyId, f.companyId), eq(toolActionRequests.status, "pending")));
    if (drift === "stop") await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.runId));
    else {
      const file = `${sandbox.directory}/${f.projectId}.json`, ledger = JSON.parse(await readFile(file, "utf8")); ledger.repositoryId++;
      await writeFile(file, JSON.stringify(ledger), { mode: 0o600 });
    }
    const outcome = await f.gateway.approveActionRequest({ companyId: f.companyId, actionRequestId: pending!.id, actor: { userId: f.companyId } }).catch(() => null);
    expect(outcome?.status).not.toBe("executed"); expect(sandbox.apiEffects).toHaveLength(0);
  }, 60000);
  it.each(["mint", "repository"] as const)("bounds the action deadline during %s verification and still settles known-token cleanup", async phase => {
    const f = await fixture();
    const args = await bindGitHubAppToolArguments(db, f, f.native.connection, "github_project_read_file", { path: "README.md" });
    const controller = new AbortController(); let entered = false;
    vi.stubGlobal("fetch", async (...call: Parameters<typeof fetch>) => {
      const body = typeof call[1]?.body === "string" ? JSON.parse(call[1].body) : null;
      const projectMint = String(call[0]).endsWith("/102/access_tokens") && body?.repository_ids;
      if (projectMint && phase === "mint") {
        entered = true; sandbox.apiFaults.mintDelayMs = 150; setTimeout(() => controller.abort(), 20);
      }
      const result = await sandbox.fetchImpl(...call);
      if (projectMint && phase === "repository") {
        entered = true; sandbox.faults.slow = true; setTimeout(() => controller.abort(), 20);
      }
      return result;
    });
    const started = Date.now();
    await expect(executeGitHubAppTool(db, f, f.native.connection, "github_project_read_file", args, sandbox.fetchImpl, controller.signal, Date.now() + 3000)).rejects.toThrow();
    expect(entered).toBe(true); expect(Date.now() - started).toBeLessThan(2500); expect(sandbox.apiEffects).toHaveLength(0);
    if (phase === "repository") expect([...sandbox.tokens.values()].some(token => token.repositoryId === f.provisioned.repositoryId)).toBe(false);
    // A provider can finish minting after the client aborts. Such an unobserved
    // token cannot be revoked by value; it is never delivered or used by an agent.
    else await new Promise(resolve => setTimeout(resolve, 170));

  }, 60000);
  it("reports cleanup uncertainty separately from a successful write and never replays it", async () => {
    const f = await fixture(); sandbox.apiFaults.cleanupRefused = true;
    const result = await f.call("github_project_open_pull_request", { title: "One successful write", head: "feature/test", base: "main" });
    expect(JSON.stringify(result)).toContain("expiry_pending");
    expect(sandbox.apiEffects.filter(effect => effect.method === "POST")).toHaveLength(1);
  }, 60000);

  it("moves dedicated action permissions atomically on a verified handover and never revives the former agent's queued approval", async () => {
    const f = await fixture("implementer", "github_project_open_pull_request");
    await expect(f.call("github_project_open_pull_request", { title: "Old assignment", head: "feature/test", base: "main" })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [pending] = await db.select().from(toolActionRequests).where(and(eq(toolActionRequests.companyId, f.companyId), eq(toolActionRequests.status, "pending")));
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const newAgent = randomUUID(); await db.insert(agents).values({ id: newAgent, companyId: f.companyId, name: "Replacement implementer", adapterType: "process", status: "paused" });
    const before = (await appConfigSnapshot(db, f.companyId))!;
    const bindings = { coordinator: before.config.apps.coordinator.agentId, implementer: newAgent, reviewer: before.config.apps.reviewer.agentId };
    await githubProjectAppAdmin(db).configure(f.companyId, before.revision, { bindings }, f.companyId);
    const [profile] = await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${f.native.connection.id}`));
    const targets = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, profile!.id));
    expect(targets.map(target => [target.targetType, target.targetId])).toEqual([["agent", newAgent]]);
    const outcome = await f.gateway.approveActionRequest({ companyId: f.companyId, actionRequestId: pending!.id, actor: { userId: f.companyId } }).catch(() => null);
    expect(outcome?.status).not.toBe("executed"); expect(sandbox.apiEffects).toHaveLength(0);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, newAgent));
    const replacement = await run("implementer", f.projectId, newAgent), session = await f.gateway.createSession(replacement);
    const tool = (await f.gateway.listToolsForSession(session.token)).find(tool => tool.connectionId === f.native.connection.id && tool.upstreamToolName === "github_project_read_file");
    expect(tool).toBeDefined();
    const result = await f.gateway.executeTool({ sessionToken: session.token, tool: tool!.name, parameters: { path: "README.md" }, idempotencyKey: randomUUID() });
    expect(JSON.stringify(result)).toContain("revoked");
    expect(sandbox.apiEffects).toHaveLength(1); expect(sandbox.apiEffects[0]!.role).toBe("implementer");
  }, 60000);

});
