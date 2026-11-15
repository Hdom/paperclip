import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, connectionGrants, githubAppSettings, createDb, toolApplications, toolConnectionInstalls, toolConnections, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { importAppConnections, nativeAppConnection } from "../services/github-app-connections.js";
import { updateNativeAppConnectionSettings } from "../services/github-app-connection-settings.js";
import { resolveManagedGitHubIdentitySelection } from "../services/git-credentials.js";
import { appConfigSnapshot, saveAppConfig } from "../services/github-app-config.js";
import { projectAppsConfigSchema } from "../services/github-project-apps.js";
import type { ProjectAppsConfig } from "../services/github-project-apps.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
const roles = ["coordinator", "implementer", "reviewer"] as const;
describeDatabase("native GitHub App connection import", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-app-connection-import-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Synthetic App connection fixture", issuePrefix: `GA${randomUUID().slice(0, 6)}` }).returning();
    const config = projectAppsConfigSchema.parse({ version: 1, owner: "Hdom", stateDirectory: "/synthetic-unopened-ledger", revision: 0, companyId: company!.id, enabled: true, apps: Object.fromEntries(roles.map((role, index) => [role,
      { agentId: randomUUID(), appId: 100 + index, installationId: 200 + index, signingKeySecret: { secretId: randomUUID(), version: 1 } }])) });
    await db.insert(agents).values(roles.map(role => ({ id: config.apps[role].agentId, companyId: config.companyId, name: role, status: "paused", adapterType: "process" })));
    const verified = roles.map(role => ({ role, status: "verified", login: `synthetic-${role}[bot]` }));
    return { config, verified };
  }
  it("round-trips JSONB, preserves identities, and is idempotent without creating or accessing signing secrets", async () => {
    const { config, verified } = await fixture();
    const first = await importAppConnections(db, config, "operator", verified);
    expect(first).toHaveLength(3);
    const second = await importAppConnections(db, config, "operator", verified);
    expect(second).toEqual(first);
    for (const role of roles) {
      const native = await nativeAppConnection(db, config, role);
      expect(native?.grant.subjectAgentId).toBe(config.apps[role].agentId);
      expect(native?.grant.providerTenant?.github).toBeUndefined();
      expect(native?.grant.providerTenant?.githubApp?.tools).toBe("unverified");
      expect(native?.connection.credentialSecretRefs).toEqual([]);
      expect(native?.grant.credentialSecretRefs).toEqual([]);
      expect(JSON.stringify(native)).not.toContain(config.apps[role].signingKeySecret!.secretId);
    }
  });
  it("leaves existing user GitHub connections and installs unchanged", async () => {
    const { config, verified } = await fixture();
    const [app] = await db.insert(toolApplications).values({ companyId: config.companyId, applicationKey: "github", name: "GitHub", type: "mcp_http" }).returning();
    const [human] = await db.insert(toolConnections).values({ companyId: config.companyId, applicationId: app!.id, name: "Existing personal GitHub",
      uid: "github/personal", transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", config: { sourceTemplateKey: "github" } }).returning();
    await importAppConnections(db, config, "operator", verified);
    const [unchanged] = await db.select().from(toolConnections).where(eq(toolConnections.id, human!.id));
    expect(unchanged).toEqual(human);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, human!.id))).toEqual([]);
  });
  it("rejects unverified roles before writing and refuses to repair audience drift", async () => {
    const { config, verified } = await fixture();
    await expect(importAppConnections(db, config, "operator", verified.map(row => ({ ...row, status: "attention" })))).rejects.toThrow();
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, config.companyId))).toEqual([]);
    await importAppConnections(db, config, "operator", verified);
    const native = (await nativeAppConnection(db, config, "reviewer"))!;
    await db.insert(toolConnectionInstalls).values({ companyId: config.companyId, connectionId: native.connection.id, targetType: "company", targetId: config.companyId });
    await expect(nativeAppConnection(db, config, "reviewer")).rejects.toThrow(/assignment/);
    await expect(importAppConnections(db, config, "operator", verified)).rejects.toThrow(/assignment/);
    const [grant] = await db.select().from(connectionGrants).where(and(eq(connectionGrants.id, native.grant.id), eq(connectionGrants.companyId, config.companyId)));
    expect(grant!.subjectAgentId).toBe(config.apps.reviewer.agentId);
  });

  it("commits dedicated grants, installs and active policy together, and safely reassigns back", async () => {
    const { config, verified } = await fixture(); await importAppConnections(db, config, "operator", verified);
    const original = (await nativeAppConnection(db, config, "reviewer"))!;
    const active = (await appConfigSnapshot(db, config.companyId))!;
    const next = structuredClone(active.config); next.apps.reviewer.agentId = randomUUID();
    await db.insert(agents).values({ id: next.apps.reviewer.agentId, companyId: config.companyId, name: "Replacement", status: "paused", adapterType: "process" });
    await updateNativeAppConnectionSettings(db, active.config, next, "operator", tx => saveAppConfig(tx, next, active.revision));
    const changed = (await appConfigSnapshot(db, config.companyId))!;
    expect(changed.storage).toBe("native"); expect(changed.config.apps.reviewer.agentId).toBe(next.apps.reviewer.agentId);
    await expect(nativeAppConnection(db, config, "reviewer")).rejects.toThrow();
    const assigned = (await nativeAppConnection(db, changed.config, "reviewer"))!;
    expect(assigned.grant.id).not.toBe(original.grant.id);
    const back = structuredClone(changed.config); back.apps.reviewer.agentId = config.apps.reviewer.agentId;
    await updateNativeAppConnectionSettings(db, changed.config, back, "operator", tx => saveAppConfig(tx, back, changed.revision));
    expect((await nativeAppConnection(db, (await appConfigSnapshot(db, config.companyId))!.config, "reviewer"))!.grant.id).toBe(original.grant.id);
  });
  it("rolls back native rows when policy persistence fails", async () => {
    const { config, verified } = await fixture(); await importAppConnections(db, config, "operator", verified);
    const next = { ...config, enabled: false }, before = await appConfigSnapshot(db, config.companyId);
    await expect(updateNativeAppConnectionSettings(db, config, next, "operator", async () => { throw Error("Synthetic policy save failure"); })).rejects.toThrow("Synthetic policy");
    expect(await appConfigSnapshot(db, config.companyId)).toEqual(before);
    for (const role of roles) expect((await nativeAppConnection(db, config, role))!.connection.enabled).toBe(true);
  });
  it("rolls back both native policy and connection rows if the transaction fails after policy persistence", async () => {
    const { config, verified } = await fixture(); await importAppConnections(db, config, "operator", verified);
    const next = { ...config, enabled: false }, before = (await appConfigSnapshot(db, config.companyId))!;
    const failing = { transaction: (operation: Parameters<Db["transaction"]>[0]) => db.transaction(async tx => {
      await operation(tx); throw Error("Synthetic commit boundary failure");
    }) } as unknown as Db;
    await expect(updateNativeAppConnectionSettings(failing, config, next, "operator", tx => saveAppConfig(tx, next, before.revision))).rejects.toThrow("Synthetic commit");
    expect(await appConfigSnapshot(db, config.companyId)).toEqual(before);
    for (const role of roles) expect((await nativeAppConnection(db, config, role))!.connection.enabled).toBe(true);
  });
  it("refuses a handover if an agent stopped being paused during provider verification", async () => {
    const { config, verified } = await fixture(); await importAppConnections(db, config, "operator", verified);
    const before = (await appConfigSnapshot(db, config.companyId))!;
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, config.apps.reviewer.agentId));
    const next = structuredClone(config); next.apps.reviewer.agentId = randomUUID();
    await db.insert(agents).values({ id: next.apps.reviewer.agentId, companyId: config.companyId, name: "Replacement", status: "paused", adapterType: "process" });
    await expect(updateNativeAppConnectionSettings(db, config, next, "operator", tx => saveAppConfig(tx, next, before.revision))).rejects.toThrow("Pause and drain");
    expect(await appConfigSnapshot(db, config.companyId)).toEqual(before);
  });

  it("does not silently reuse legacy authority when a native connection is missing", async () => {
    const { config, verified } = await fixture(); await importAppConnections(db, config, "operator", verified);
    const current = (await nativeAppConnection(db, config, "reviewer"))!;
    await db.delete(toolConnections).where(eq(toolConnections.id, current.connection.id));
    await expect(nativeAppConnection(db, config, "reviewer")).rejects.toThrow("connection is missing");
    // A confirmed, verified operator import can recreate that exact intended
    // identity while all agents are paused; reads never perform this repair.
    await importAppConnections(db, config, "operator", verified);
    expect((await nativeAppConnection(db, config, "reviewer"))!.grant.subjectAgentId).toBe(config.apps.reviewer.agentId);
  });

  it("allows immediate issuance pause while agents are active, without releasing identity blocks", async () => {
    const { config, verified } = await fixture(); await importAppConnections(db, config, "operator", verified);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.companyId, config.companyId));
    const before = (await appConfigSnapshot(db, config.companyId))!;
    const next = { ...config, enabled: false };
    await updateNativeAppConnectionSettings(db, config, next, "operator", tx => saveAppConfig(tx, next, before.revision));
    const paused = (await appConfigSnapshot(db, config.companyId))!;
    expect(paused.config.enabled).toBe(false);
    for (const role of roles) {
      expect((await nativeAppConnection(db, paused.config, role, false))!.connection.enabled).toBe(false);
      await expect(nativeAppConnection(db, paused.config, role)).rejects.toThrow("paused");
    }
  });
  it("does not require unrelated role agents to pause for a dedicated handover", async () => {
    const { config, verified } = await fixture(); await importAppConnections(db, config, "operator", verified);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, config.apps.coordinator.agentId));
    const next = structuredClone(config); next.apps.reviewer.agentId = randomUUID();
    await db.insert(agents).values({ id: next.apps.reviewer.agentId, companyId: config.companyId, name: "Replacement", status: "paused", adapterType: "process" });
    const before = (await appConfigSnapshot(db, config.companyId))!;
    await updateNativeAppConnectionSettings(db, config, next, "operator", tx => saveAppConfig(tx, next, before.revision));
    expect((await nativeAppConnection(db, (await appConfigSnapshot(db, config.companyId))!.config, "reviewer"))!.grant.subjectAgentId).toBe(next.apps.reviewer.agentId);
  });
  it("fences restoration of a former agent's ordinary GitHub credential rules", async () => {
    const { config, verified } = await fixture();
    const former = randomUUID(); config.blockedAgentIds = [former];
    await db.insert(agents).values({ id: former, companyId: config.companyId, name: "Former", status: "idle", adapterType: "process" });
    await importAppConnections(db, config, "operator", verified);
    const before = (await appConfigSnapshot(db, config.companyId))!;
    const next = { ...config, blockedAgentIds: [] };
    await expect(updateNativeAppConnectionSettings(db, config, next, "operator", tx => saveAppConfig(tx, next, before.revision))).rejects.toThrow("Pause and drain");
    expect(await appConfigSnapshot(db, config.companyId)).toEqual(before);
  });

  it("restores eligible personal OAuth after explicit release but fences historical principals if native policy is lost", async () => {
    const { config, verified } = await fixture(); await importAppConnections(db, config, "operator", verified);
    const oldAgent = config.apps.reviewer.agentId;
    let active = (await appConfigSnapshot(db, config.companyId))!;
    const next = structuredClone(active.config); next.apps.reviewer.agentId = randomUUID(); next.blockedAgentIds = [oldAgent];
    await db.insert(agents).values({ id: next.apps.reviewer.agentId, companyId: config.companyId, name: "Replacement", status: "paused", adapterType: "process" });
    await updateNativeAppConnectionSettings(db, active.config, next, "operator", tx => saveAppConfig(tx, next, active.revision));
    const blocked = await resolveManagedGitHubIdentitySelection(db, config.companyId, { agentId: oldAgent, responsibleUserId: "owner" });
    expect(blocked.configured).toBe(true); expect(blocked.grant).toBeUndefined();
    active = (await appConfigSnapshot(db, config.companyId))!;
    const released = { ...active.config, blockedAgentIds: [] };
    await updateNativeAppConnectionSettings(db, active.config, released, "operator", tx => saveAppConfig(tx, released, active.revision));
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.companyId, config.companyId));
    const [human] = await db.insert(toolConnections).values({ companyId: config.companyId, applicationId: application!.id, name: "Existing personal OAuth", uid: "github/personal", enabled: true, status: "active",
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", config: { sourceTemplateKey: "github" } }).returning();
    await db.insert(toolConnectionInstalls).values({ companyId: config.companyId, connectionId: human!.id, targetType: "agent", targetId: oldAgent });
    const [grant] = await db.insert(connectionGrants).values({ companyId: config.companyId, connectionId: human!.id, kind: "user", subjectUserId: "owner", status: "active",
      providerTenant: { github: { userId: "123", login: "existing-owner", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["1"], installationOwnerLogins: ["Hdom"] } } }).returning();
    const selected = await resolveManagedGitHubIdentitySelection(db, config.companyId, { agentId: oldAgent, responsibleUserId: "owner" });
    expect(selected.error).toBeUndefined(); expect(selected.identitySource).toBe("personal"); expect(selected.grant?.id).toBe(grant!.id);
    await db.delete(githubAppSettings).where(eq(githubAppSettings.companyId, config.companyId));
    const orphaned = await resolveManagedGitHubIdentitySelection(db, config.companyId, { agentId: oldAgent, responsibleUserId: "owner" });
    expect(orphaned.grant).toBeUndefined(); expect(orphaned.error).toContain("reconciliation");
  });

});
