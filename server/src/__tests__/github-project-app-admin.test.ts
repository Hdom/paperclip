import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, companySecretBindings, companySecrets, connectionGrants, createDb, toolApplications, toolConnectionInstalls, toolConnections } from "@paperclipai/db";
import { githubProjectAppAdmin } from "../services/github-project-app-admin.js";
import { githubProjectAppRoutes } from "../routes/github-project-apps.js";
import { createProjectAppBroker, loadProjectAppsConfig, projectAppsConfigSnapshot } from "../services/github-project-apps.js";
import { resolveManagedGitHubIdentitySelection } from "../services/git-credentials.js";
import { secretService } from "../services/secrets.js";
import { syncConnectionCredentialBindings } from "../services/connection-credential-bindings.js";
import { errorHandler } from "../middleware/index.js";
import { projectAppSandbox } from "./helpers/project-app-sandbox.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native GitHub App administration and migration", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  let sandbox: Awaited<ReturnType<typeof projectAppSandbox>>, service: ReturnType<typeof githubProjectAppAdmin>, companyId: string;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("native-app-admin-"); db = createDb(database.connectionString); }, 30000);
  afterAll(async () => { await database?.cleanup(); }, 60000);
  beforeEach(async () => {
    sandbox = await projectAppSandbox(); companyId = sandbox.config.companyId;
    await db.insert(companies).values({ id: companyId, name: "Synthetic App UI", issuePrefix: companyId.slice(0, 8) });
    await mkdir(path.join(sandbox.directory, "keys"), { mode: 0o700 });
    for (const role of ["coordinator", "implementer", "reviewer"] as const) {
      const app = sandbox.config.apps[role], next = path.join(sandbox.directory, "keys", `${role}.pem`);
      await rename(app.privateKeyPath!, next); app.privateKeyPath = next;
      await db.insert(agents).values({ id: app.agentId, companyId, name: role, role: "engineer", adapterType: "codex_local" });
    }
    await writeFile(sandbox.configPath, JSON.stringify(sandbox.config), { mode: 0o600 });
    vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", sandbox.configPath);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "b".repeat(64));
    vi.stubGlobal("fetch", sandbox.fetchImpl); service = githubProjectAppAdmin(db);
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await sandbox.cleanup(); });
  const revision = async () => (await projectAppsConfigSnapshot())!.revision;
  function app(actor?: Record<string, unknown>) {
    const result = express(); result.use(express.json());
    result.use((req, _res, next) => { Object.assign(req, { actor: actor ?? { type: "board", source: "session", userId: "synthetic-admin", isInstanceAdmin: true, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] } }); next(); });
    result.use("/api", githubProjectAppRoutes(db)); result.use(errorHandler); return result;
  }
  const endpoint = () => `/api/companies/${companyId}/github-project-apps`;
  it("migrates into native encrypted secrets, verifies signing and removes only matched prepared files", async () => {
    const response = await request(app()).post(endpoint() + "/migrate").send({ revision: await revision(), confirmed: true });
    expect(response.status).toBe(200); expect(response.body.migration).toEqual({ migrated: true, cleanupPending: [] });
    const config = (await loadProjectAppsConfig())!;
    for (const role of ["coordinator", "implementer", "reviewer"] as const) {
      expect(config.apps[role].privateKeyPath).toBeUndefined(); expect(config.apps[role].signingKeySecret?.version).toBe(1);
      await expect(stat(path.join(sandbox.directory, "keys", `${role}.pem`))).rejects.toHaveProperty("code", "ENOENT");
    }
    expect(await secretService(db).listControllerSigningKeys(companyId)).toHaveLength(3);
    expect(await secretService(db).list(companyId)).toEqual([]);
    expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE KEY|"jwt"|"token"|privateKeyPath/);
    expect(response.headers["cache-control"]).toBe("no-store");
    const restarted = createProjectAppBroker(config, { fetch: sandbox.fetchImpl, signKey: (role, appId, ref) => secretService(db).signControllerGitHubAppJwt(companyId, ref.secretId, ref.version, role, appId) });
    await expect(restarted.verifySetup()).resolves.toHaveProperty("installationsVerified", 3);
    expect(sandbox.requests.some(row => row.url === "/user/repos" || row.method === "PUT")).toBe(false);
  });
  it("restores the original reference configuration before cleanup on post-cutover verification failure, then resumes without duplicating secrets", async () => {
    let fail = true;
    vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const disk = JSON.parse(await readFile(sandbox.configPath, "utf8"));
      if (fail && disk.apps.coordinator.signingKeySecret) throw new Error("Synthetic post-cutover provider failure");
      return sandbox.fetchImpl(url, init);
    });
    await expect(service.migrate(companyId, await revision(), "synthetic-admin")).rejects.toThrow("restored");
    expect((await loadProjectAppsConfig())!.apps.coordinator.privateKeyPath).toBeTruthy();
    for (const role of ["coordinator", "implementer", "reviewer"]) expect((await stat(path.join(sandbox.directory, "keys", `${role}.pem`))).mode & 0o777).toBe(0o600);
    expect(await secretService(db).listControllerSigningKeys(companyId)).toHaveLength(3);
    fail = false; await service.migrate(companyId, await revision(), "synthetic-admin");
    expect(await secretService(db).listControllerSigningKeys(companyId)).toHaveLength(3);
  });
  it("rejects agent/cross-company/adminless writes, cross-origin requests and missing confirmation before changing keys", async () => {
    const rev = await revision();
    expect((await request(app({ type: "agent", source: "agent_jwt", agentId: sandbox.config.apps.implementer.agentId, companyId })).get(endpoint())).status).toBe(403);
    expect((await request(app({ type: "board", source: "session", userId: "other", companyIds: [] })).get(endpoint())).status).toBe(403);
    const viewer = { type: "board", source: "session", userId: "viewer", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "viewer" }] };
    expect((await request(app(viewer)).put(endpoint()).send({ revision: rev, confirmed: true, enabled: false })).status).toBe(403);
    expect((await request(app()).put(endpoint()).set("Origin", "https://attacker.invalid").send({ revision: rev, confirmed: true, enabled: false })).status).toBe(403);
    expect((await request(app()).post(endpoint() + "/migrate").send({ revision: rev, confirmed: false })).status).toBe(400);
    expect((await request(app()).put(endpoint()).send({ revision: rev, confirmed: true, owner: "other" })).status).toBe(400);
    expect(await secretService(db).listControllerSigningKeys(companyId)).toHaveLength(0);
    expect(await revision()).toBe(rev);
  });
  it("keeps paused and formerly assigned agents managed, rejects stale saves, and requires explicit release", async () => {
    const oldAgent = sandbox.config.apps.implementer.agentId;
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Existing GitHub", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "Existing GitHub", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true, credentialPolicy: "per_agent", config: { sourceTemplateKey: "github" } }).returning();
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: connection.id, targetType: "agent", targetId: oldAgent });
    const existingSecret = await secretService(db).create(companyId, { name: "Existing OAuth", provider: "local_encrypted", value: "synthetic-existing-oauth" });
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId: connection.id, kind: "agent", subjectAgentId: oldAgent, status: "active", credentialSecretRefs: [{ secretId: existingSecret.id, configPath: "oauth.access_token", versionSelector: "latest" }], providerTenant: { github: { userId: "old", login: "old", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["1"], installationOwnerLogins: ["old"] } } }).returning();
    vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", "");
    expect((await resolveManagedGitHubIdentitySelection(db, companyId, { agentId: oldAgent })).grant?.id).toBe(grant.id);
    vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", sandbox.configPath);
    const initial = await revision(); await service.configure(companyId, initial, { enabled: false });
    await expect(service.configure(companyId, initial, { enabled: true })).rejects.toThrow("changed");
    const old = sandbox.config.apps.implementer.agentId, replacement = randomUUID();
    await db.insert(agents).values({ id: replacement, companyId, name: "replacement", role: "engineer", adapterType: "codex_local" });
    await service.configure(companyId, await revision(), { bindings: { coordinator: sandbox.config.apps.coordinator.agentId, implementer: replacement, reviewer: sandbox.config.apps.reviewer.agentId } });
    for (const id of [old, replacement]) expect(await resolveManagedGitHubIdentitySelection(db, companyId, { agentId: id })).toMatchObject({ configured: true, identitySource: "dedicated" });
    await service.configure(companyId, await revision(), { releaseAgentId: old });
    expect((await resolveManagedGitHubIdentitySelection(db, companyId, { agentId: old })).grant?.id).toBe(grant.id);
  });
  it("keeps controller refs out of connection bindings without deleting prior valid bindings", async () => {
    const secrets = secretService(db), pem = await readFile(sandbox.config.apps.reviewer.privateKeyPath!, "utf8");
    const controller = await secrets.createControllerSigningKey(companyId, "reviewer", 13, pem, "synthetic-admin");
    const normal = await secrets.create(companyId, { name: "normal", provider: "local_encrypted", value: "synthetic" });
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Synthetic App", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "Synthetic connection", uid: randomUUID(), transport: "mcp_remote", status: "active" }).returning();
    await db.insert(companySecretBindings).values({ companyId, secretId: normal.id, targetType: "tool_connection", targetId: connection.id, configPath: "credentials.normal" });
    await expect(syncConnectionCredentialBindings(db, { ...connection, credentialSecretRefs: [{ secretId: controller.id, configPath: "credentials.privateKey", versionSelector: 1 }] })).rejects.toThrow("cannot be connection credentials");
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, connection.id));
    expect(bindings.map(row => row.secretId)).toEqual([normal.id]);
  });
  it("retains a changed plaintext source as cleanup pending and resumes without replacing native versions", async () => {
    const reviewer = path.join(sandbox.directory, "keys", "reviewer.pem");
    const original = await readFile(reviewer, "utf8");
    let changed = false;
    vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const disk = JSON.parse(await readFile(sandbox.configPath, "utf8"));
      if (!changed && disk.apps.coordinator.signingKeySecret) {
        changed = true;
        // Same valid public identity, but source bytes changed after migration's opened-file proof.
        await writeFile(reviewer, original + "\n", { mode: 0o600 });
      }
      return sandbox.fetchImpl(url, init);
    });
    await expect(service.migrate(companyId, await revision(), "synthetic-admin"))
      .resolves.toEqual({ migrated: true, cleanupPending: ["reviewer"] });
    const stored = await secretService(db).listControllerSigningKeys(companyId);
    expect(stored).toHaveLength(3);
    expect(stored.map(row => row.latestVersion)).toEqual([1, 1, 1]);
    expect(await readFile(reviewer, "utf8")).toBe(original + "\n");
    for (const role of ["coordinator", "implementer"]) {
      await expect(stat(path.join(sandbox.directory, "keys", role + ".pem"))).rejects.toHaveProperty("code", "ENOENT");
    }
    const pendingSettings = await service.settings(companyId, true);
    if (!("migration" in pendingSettings)) throw new Error("Expected prepared App settings");
    expect(pendingSettings.migration).toMatchObject({ migrated: true, cleanupPending: ["reviewer"] });
    await expect(service.migrate(companyId, await revision(), "synthetic-admin"))
      .resolves.toEqual({ migrated: true, cleanupPending: [] });
    await expect(stat(reviewer)).rejects.toHaveProperty("code", "ENOENT");
    const resumed = await secretService(db).listControllerSigningKeys(companyId);
    expect(resumed.map(row => [row.id, row.latestVersion]).sort()).toEqual(stored.map(row => [row.id, row.latestVersion]).sort());
    expect(JSON.stringify(await service.settings(companyId, true))).not.toMatch(/PRIVATE KEY|"jwt"|"token"|privateKeyPath/);
  });

  it("refuses controller keys mirrored through active grants before replacing valid connection bindings", async () => {
    const secrets = secretService(db), pem = await readFile(sandbox.config.apps.reviewer.privateKeyPath!, "utf8");
    const controller = await secrets.createControllerSigningKey(companyId, "reviewer", 13, pem, "synthetic-admin");
    const normal = await secrets.create(companyId, { name: "Grant fixture normal", provider: "local_encrypted", value: "synthetic-normal" });
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Grant fixture App", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "Grant fixture connection",
      uid: randomUUID(), transport: "mcp_remote", status: "active" }).returning();
    await db.insert(companySecretBindings).values({ companyId, secretId: normal.id, targetType: "tool_connection",
      targetId: connection.id, configPath: "credentials.normal" });
    await db.insert(connectionGrants).values({ companyId, connectionId: connection.id, kind: "agent",
      subjectAgentId: sandbox.config.apps.reviewer.agentId, status: "active",
      credentialSecretRefs: [{ secretId: controller.id, configPath: "credentials.signing", versionSelector: 1 }] });
    await expect(syncConnectionCredentialBindings(db, connection)).rejects.toThrow("cannot be connection credentials");
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, connection.id));
    expect(bindings.map(row => [row.secretId, row.configPath])).toEqual([[normal.id, "credentials.normal"]]);
  });

});
