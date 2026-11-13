import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issues, projects, projectWorkspaces, activityLog, issueTreeHolds } from "@paperclipai/db";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/index.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import { resolveManagedGitHubIdentitySelection, filterResolvedGitHubConnectionsForRun } from "../services/git-credentials.js";
import { resolveProjectAppCredential } from "../services/github-project-app-runtime.js";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { projectAppSandbox } from "./helpers/project-app-sandbox.js";
import type { ProjectAppRole } from "../services/github-project-apps.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("run-bound project GitHub App integration", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  let sandbox: Awaited<ReturnType<typeof projectAppSandbox>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-project-app-runtime-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); }, 60000);
  beforeEach(async () => {
    sandbox = await projectAppSandbox();
    vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", sandbox.configPath);
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "synthetic-github-app-run-signing-secret");
    vi.stubGlobal("fetch", sandbox.fetchImpl);
    const companyId = sandbox.config.companyId;
    await db.insert(companies).values({ id: companyId, name: "Isolated App test", issuePrefix: companyId.slice(0, 8) });
    for (const role of Object.keys(sandbox.config.apps) as ProjectAppRole[])
      await db.insert(agents).values({ id: sandbox.config.apps[role].agentId, companyId, name: role, role: "engineer", adapterType: "codex_local" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: companyId, status: "active", membershipRole: "owner" });
  });
  afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await sandbox.cleanup(); });
  async function run(role: ProjectAppRole, projectId?: string) {
    const companyId = sandbox.config.companyId, agentId = sandbox.config.apps[role].agentId;
    projectId ??= randomUUID();
    const [existing] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!existing) await db.insert(projects).values({ id: projectId, companyId, name: "Synthetic fresh project" });
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Synthetic project task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    await initializeRunIdentity(db, { companyId, runId, responsibleUserId: companyId, cause: "instruction" });
    return { companyId, agentId, runId, issueId, projectId };
  }
  function app() { const result = express(); result.use(express.json()); result.use(runtimeConnectionIntentRoutes(db)); result.use(errorHandler); return result; }
  function capability(input: Awaited<ReturnType<typeof run>>, scope: "github_credentials" | "connection_intents" = "github_credentials") {
    return createRuntimeToolsToken({ ...input, scope, responsibleUserId: input.companyId })!.token;
  }
  it("provisions through the real run-authenticated route and delivers role-scoped shell credentials", async () => {
    const coordinator = await run("coordinator");
    const result = await request(app()).post("/runtime-tools/github/project").set("Authorization", `Bearer ${capability(coordinator)}`).send({});
    expect(result.status).toBe(200); expect(result.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(result.body)).not.toMatch(/synthetic-|PRIVATE KEY/);
    const worker = await run("implementer", coordinator.projectId);
    const credential = await resolveGitHubOperationCredentials(db, worker);
    expect(credential.status).toBe("available");
    expect(credential.login).toBe("paperclip-implementer[bot]");
    expect(credential.env.GIT_AUTHOR_NAME).toBe("paperclip-implementer[bot]");
    expect(sandbox.tokens.get(credential.env.GH_TOKEN!)).toEqual({ role: "implementer", repositoryId: result.body.repositoryId });
    const reviewer = await run("reviewer", coordinator.projectId);
    const reviewed = await resolveGitHubOperationCredentials(db, reviewer);
    expect(reviewed.status).toBe("available");
    expect(reviewed.login).toBe("paperclip-reviewer[bot]");
    expect(sandbox.tokens.get(reviewed.env.GH_TOKEN!)?.role).toBe("reviewer");
    const control = await resolveGitHubOperationCredentials(db, coordinator);
    expect(control.status).toBe("unavailable"); expect(control.env).toEqual({});
    const audit = await db.select({ action: activityLog.action, details: activityLog.details }).from(activityLog).where(eq(activityLog.companyId, coordinator.companyId));
    expect(audit.some(row => row.action === "github_project_app.provision_ready")).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/synthetic-|PRIVATE KEY/);
  });
  it("rejects browser sessions, wrong scope, forged scope parameters, and worker provisioning", async () => {
    const input = await run("coordinator"); const application = app();
    for (const headers of [{ Origin: "https://project.orozco.mov" }, { Cookie: "session=synthetic" }, { "Sec-Fetch-Site": "same-origin" }]) {
      expect((await request(application).post("/runtime-tools/github/project").set("Authorization", `Bearer ${capability(input)}`).set(headers).send({})).status).toBe(403);
    }
    expect((await request(application).post("/runtime-tools/github/project").set("Authorization", `Bearer ${capability(input, "connection_intents")}`).send({})).status).toBe(401);
    expect((await request(application).post("/runtime-tools/github/project").set("Authorization", `Bearer ${capability(input)}`).send({ installationId: 999, projectId: randomUUID() })).status).toBe(403);
    const worker = await run("implementer");
    expect((await request(application).post("/runtime-tools/github/project").set("Authorization", `Bearer ${capability(worker)}`).send({})).status).toBe(403);
    expect(sandbox.requests).toHaveLength(0);
  });
  it.each(["stopped", "archived", "hidden", "reassigned", "low_trust", "existing_repository", "paused_project", "paused_agent", "ancestor_hold", "superseded_execution", "conflicting_task_context"] as const)("denies %s work before GitHub access", async condition => {
    const input = await run("coordinator");
    if (condition === "stopped") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, input.runId));
    if (condition === "archived") await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, input.projectId));
    if (condition === "hidden") await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, input.issueId));
    if (condition === "reassigned") await db.update(issues).set({ assigneeAgentId: sandbox.config.apps.reviewer.agentId }).where(eq(issues.id, input.issueId));
    if (condition === "low_trust") await db.update(agents).set({ permissions: { trustPreset: LOW_TRUST_REVIEW_PRESET } }).where(eq(agents.id, input.agentId));
    if (condition === "existing_repository") await db.insert(projectWorkspaces).values({ companyId: input.companyId, projectId: input.projectId, name: "Existing unrelated repository", repoUrl: "https://github.com/Hdom/existing" });
    if (condition === "paused_project") await db.update(projects).set({ pausedAt: new Date() }).where(eq(projects.id, input.projectId));
    if (condition === "paused_agent") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, input.agentId));
    if (condition === "superseded_execution") {
      const successor = randomUUID();
      await db.insert(heartbeatRuns).values({ id: successor, companyId: input.companyId, agentId: input.agentId, status: "running" });
      await db.update(issues).set({ executionRunId: successor }).where(eq(issues.id, input.issueId));
    }
    if (condition === "conflicting_task_context") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: input.issueId, taskId: randomUUID() } }).where(eq(heartbeatRuns.id, input.runId));
    if (condition === "ancestor_hold") {
      const parentId = randomUUID();
      await db.insert(issues).values({ id: parentId, companyId: input.companyId, title: "Paused synthetic parent" });
      await db.update(issues).set({ parentId }).where(eq(issues.id, input.issueId));
      await db.insert(issueTreeHolds).values({ companyId: input.companyId, rootIssueId: parentId, mode: "pause" });
    }
    expect((await request(app()).post("/runtime-tools/github/project").set("Authorization", `Bearer ${capability(input)}`).send({})).status).toBe(403);
    expect(sandbox.requests).toHaveLength(0);
  });
  it("does not fall back to another GitHub identity when a worker's project is not enrolled", async () => {
    const input = await run("reviewer");
    const result = await resolveGitHubOperationCredentials(db, input);
    expect(result.status).toBe("unavailable"); expect(result.env).toEqual({});
    expect(await resolveProjectAppCredential(db, input.companyId, { agentId: input.agentId })).toMatchObject({ configured: true });
  });
  it("revokes and withholds a worker token if its run stops during the network operation", async () => {
    const coordinator = await run("coordinator");
    expect((await request(app()).post("/runtime-tools/github/project").set("Authorization", `Bearer ${capability(coordinator)}`).send({})).status).toBe(200);
    const worker = await run("reviewer", coordinator.projectId);
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await sandbox.fetchImpl(...args);
      if (String(args[0]).endsWith("/103/access_tokens")) await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, worker.runId));
      return response;
    });
    const result = await resolveGitHubOperationCredentials(db, worker);
    expect(result.status).toBe("unavailable"); expect(result.env).toEqual({});
    expect([...sandbox.tokens.values()].some(value => value.role === "reviewer")).toBe(false);
  });
  it("blocks personal/host fallback and OAuth GitHub MCP identity selection for configured roles", async () => {
    const input = await run("reviewer");
    expect(await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId, responsibleUserId: input.companyId }))
      .toMatchObject({ configured: true, identitySource: "dedicated", error: expect.stringContaining("project GitHub App") });
    const connections = [{ id: "old-github", config: { sourceTemplateKey: "github" } }, { id: "other-tool", config: { sourceTemplateKey: "other" } }];
    expect(await filterResolvedGitHubConnectionsForRun({ db, companyId: input.companyId, agentId: input.agentId, responsibleUserId: input.companyId, connections }))
      .toEqual([connections[1]]);
  });
  it("leaves existing integrations selected when the feature is disabled or the agent is unrelated", async () => {
    const input = await run("implementer");
    expect(await resolveProjectAppCredential(db, randomUUID(), { agentId: input.agentId, heartbeatRunId: input.runId })).toBeNull();
    expect(await resolveProjectAppCredential(db, input.companyId, { agentId: randomUUID(), heartbeatRunId: input.runId })).toBeNull();
    vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", "");
    expect(await resolveProjectAppCredential(db, input.companyId, { agentId: input.agentId, heartbeatRunId: input.runId })).toBeNull();
  });
});
