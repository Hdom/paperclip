import express from "express";
import request from "supertest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companySecrets, companySecretVersions, createDb } from "@paperclipai/db";
import { secretService } from "../services/secrets.js";
import { signingKeyRoutes, signingKeyCreateSchema, signingKeyRotateSchema, signingKeyUpdateSchema } from "../routes/signing-keys.js";
import { errorHandler } from "../middleware/error-handler.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("signing key public API", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, companyId: string;
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("generic-signing-api-"); db = createDb(database.connectionString); }, 30000);
  afterAll(async () => { await database?.cleanup(); }, 60000);
  beforeEach(async () => { vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "c".repeat(64)); companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic signing API", issuePrefix: companyId.slice(0, 8) }); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  const base = () => `/api/companies/${companyId}/signing-keys`;
  function app(overrides: Record<string, unknown> = {}) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { actor: { type: "board", source: "session", userId: "synthetic-admin",
      isInstanceAdmin: true, companyIds: [companyId], ...overrides } }); next(); });
    app.use("/api", signingKeyRoutes(db, undefined, { publicOrigin: "https://paperclip.example" })); app.use(errorHandler); return app;
  }
  it("imports and lists metadata only, with no secret material or private-value hashes", async () => {
    const created = await request(app()).post(base()).set("Origin", "https://paperclip.example").send({ name: "Test signing key", privateKey: pem, confirmed: true });
    expect(created.status).toBe(201); expect(created.body).toMatchObject({ type: "generic", algorithm: "ed25519", revision: 1, latestVersion: 1 });
    expect(Object.keys(created.body).sort()).toEqual(["algorithm", "canOrganize", "createdAt", "description", "folderPath", "githubApp", "id", "latestVersion", "name", "organizationRevision", "publicFingerprint", "revision", "status", "type", "updatedAt"]);
    expect(JSON.stringify(created.body)).not.toMatch(/PRIVATE KEY|valueSha256|fingerprintSha256|material|providerMetadata/);
    const listed = await request(app()).get(base()); expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.body.keys).toHaveLength(1);
    const versions = await request(app()).get(`${base()}/${created.body.id}/versions`);
    expect(Object.keys(versions.body[0]).sort()).toEqual(["createdAt", "id", "status", "version"]);
  });
  it("denies agent reads and non-administrator writes", async () => {
    expect((await request(app({ type: "agent", agentId: randomUUID() })).get(base())).status).toBe(403);
    const member = app({ isInstanceAdmin: false });
    expect((await request(member).get(base())).body.canManage).toBe(false);
    expect((await request(member).post(base()).send({ name: "Test", privateKey: pem, confirmed: true })).status).toBe(403);
  });
  it("denies cross-company and cross-origin mutations", async () => {
    expect((await request(app({ companyIds: [] })).get(base())).status).toBe(403);
    expect((await request(app()).post(base()).set("Origin", "https://untrusted.example").send({ name: "Test", privateKey: pem, confirmed: true })).status).toBe(403);
    expect(await secretService(db).listSigningKeys(companyId)).toHaveLength(0);
  });
  it("requires a current lifecycle revision and never permits protected fields through metadata", async () => {
    const created = await request(app()).post(base()).send({ name: "Test", privateKey: pem, confirmed: true });
    const endpoint = `${base()}/${created.body.id}`, guard = { expectedLatestVersion: 1, expectedRevision: 1, confirmed: true };
    expect((await request(app()).patch(endpoint).send({ ...guard, status: "disabled" })).status).toBe(200);
    expect((await request(app()).patch(endpoint).send({ ...guard, status: "active" })).status).toBe(409);
    expect((await request(app()).post(endpoint + "/rotate").send({ ...guard, privateKey: pem })).status).toBe(409);
    expect((await request(app()).patch(endpoint).send({ ...guard, expectedRevision: 2, scope: "company" })).status).toBe(400);
  });
  it("rejects unconfirmed and unexpected fields in every lifecycle schema", () => {
    expect(signingKeyCreateSchema.safeParse({ name: "Test", privateKey: pem, confirmed: true, providerMetadata: {} }).success).toBe(false);
    expect(signingKeyRotateSchema.safeParse({ privateKey: pem, expectedLatestVersion: 1, expectedRevision: 1, confirmed: false }).success).toBe(false);
    expect(signingKeyUpdateSchema.safeParse({ expectedLatestVersion: 1, expectedRevision: 1, confirmed: true, consumer: "github_project_apps" }).success).toBe(false);
  });
  it("normalizes the exact legacy GitHub description without rewriting records or custom descriptions", async () => {
    const legacy = "Controller signing only. Never available to agents, environment bindings or connection credentials.";
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const service = secretService(db);
    for (const role of ["coordinator", "implementer", "reviewer"] as const) {
      const key = await service.createControllerSigningKey(companyId, role, 13, rsa, "synthetic-admin");
      await db.update(companySecrets).set({ description: legacy }).where(eq(companySecrets.id, key.id));
    }
    const before = await service.listSigningKeys(companyId);
    const catalog = await request(app()).get(base()); expect(catalog.status).toBe(200); expect(catalog.body.keys).toHaveLength(3);
    for (const key of catalog.body.keys) { expect(key.description).toBe("Used by Paperclip for signing. Unavailable to agent variables and connection credentials."); expect(key.type).toBe("github_app"); }
    expect(JSON.stringify(catalog.body)).not.toContain("Controller");
    expect(await service.listSigningKeys(companyId)).toEqual(before);
    await db.update(companySecrets).set({ description: "Custom operator description" }).where(eq(companySecrets.id, before[0]!.id));
    const custom = await request(app()).get(base());
    expect(custom.body.keys.find((key: { id: string }) => key.id === before[0]!.id).description).toBe("Custom operator description");
    const generic = await service.createSigningKey(companyId, { name: "Generic", privateKey: pem, description: legacy }, "synthetic-admin");
    const unrelated = await request(app()).get(base());
    expect(unrelated.body.keys.find((key: { id: string }) => key.id === generic.id).description).toBe(legacy);
  });

  it("shows bounded public signing access events only within the authorized company", async () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const service = secretService(db);
    const key = await service.createControllerSigningKey(companyId, "reviewer", 13, rsa, "synthetic-admin");
    await service.signControllerGitHubAppJwt(companyId, key.id, 1, "reviewer", 13);
    const endpoint = `${base()}/${key.id}/access-events`;
    const events = await request(app({ isInstanceAdmin: false })).get(endpoint);
    expect(events.status).toBe(200); expect(events.headers["cache-control"]).toBe("no-store");
    expect(events.body.length).toBeGreaterThan(0); expect(events.body.length).toBeLessThanOrEqual(100);
    for (const event of events.body) expect(Object.keys(event).sort()).toEqual(["createdAt", "id", "outcome", "version"]);
    expect(JSON.stringify(events.body)).not.toMatch(/PRIVATE KEY|jwt|material|providerMetadata|synthetic-admin/);
    expect((await request(app({ type: "agent", agentId: randomUUID() })).get(endpoint)).status).toBe(403);
    expect((await request(app({ companyIds: [] })).get(endpoint)).status).toBe(403);
    expect((await request(app()).get(`${base()}/${randomUUID()}/access-events`)).status).toBe(404);
  });

  it("organizes managed keys without changing identity, ciphertext, versions or signing authority", async () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const service = secretService(db), key = await service.createControllerSigningKey(companyId, "reviewer", 13, rsa, "synthetic-admin");
    const beforeVersions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, key.id));
    const endpoint = `${base()}/${key.id}/organization`;
    const guard = { expectedLatestVersion: 1, expectedUpdatedAt: key.updatedAt.toISOString(), expectedOrganizationRevision: 0, confirmed: true };
    const moved = await request(app()).patch(endpoint).set("Origin", "https://paperclip.example").send({ ...guard, folderPath: "services/github" });
    expect(moved.status).toBe(200); expect(moved.body).toMatchObject({ folderPath: "services/github", canOrganize: true, name: key.name, latestVersion: 1, type: "github_app" });
    const [after] = await db.select().from(companySecrets).where(eq(companySecrets.id, key.id));
    expect(after).toMatchObject({ key: key.key, name: key.name, scope: key.scope, status: key.status, latestVersion: key.latestVersion });
    expect(after!.providerMetadata).toEqual({ ...key.providerMetadata, signingFolderPath: "services/github", signingOrganizationRevision: 1 });
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, key.id))).toEqual(beforeVersions);
    expect((await service.signControllerGitHubAppJwt(companyId, key.id, 1, "reviewer", 13)).jwt).toBeTruthy();
    expect((await request(app()).patch(`${base()}/${key.id}`).send({ expectedLatestVersion: 1, expectedRevision: 1, confirmed: true, status: "disabled" })).status).toBe(403);
    expect((await request(app()).patch(endpoint).send({ ...guard, folderPath: "stale" })).status).toBe(409);
  });
  it("protects folder writes with strict fields, canonical paths, company access and administrator authority", async () => {
    const key = await secretService(db).createSigningKey(companyId, { name: "Generic", privateKey: pem }, "synthetic-admin");
    const endpoint = `${base()}/${key.id}/organization`, guard = { expectedLatestVersion: 1, expectedUpdatedAt: key.updatedAt.toISOString(), expectedOrganizationRevision: 0, confirmed: true };
    for (const extra of [{ status: "disabled" }, { name: "rename" }, { providerMetadata: {} }, { scope: "company" }, { privateKey: pem }, { confirmed: false }]) {
      expect((await request(app()).patch(endpoint).send({ ...guard, folderPath: "services", ...extra })).status).toBe(400);
    }
    for (const folderPath of ["/absolute", "trailing/", "a//b", "a/../b", "a/./b", "a/ bad", "a\\b", "a\ncontrol"]) {
      expect((await request(app()).patch(endpoint).send({ ...guard, folderPath })).status).toBe(400);
    }
    for (const actor of [{ type: "agent", agentId: randomUUID() }, { isInstanceAdmin: false }, { companyIds: [] }])
      expect((await request(app(actor)).patch(endpoint).send({ ...guard, folderPath: "services" })).status).toBe(403);
    expect((await request(app()).patch(endpoint).set("Origin", "https://untrusted.example").send({ ...guard, folderPath: "services" })).status).toBe(403);
    expect((await request(app()).patch(`${base()}/${randomUUID()}/organization`).send({ ...guard, folderPath: "services" })).status).toBe(404);
    const otherCompanyId = randomUUID(); await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: otherCompanyId.slice(0, 8) });
    const other = await secretService(db).createSigningKey(otherCompanyId, { name: "Other key", privateKey: pem }, "synthetic-admin");
    expect((await request(app()).patch(`${base()}/${other.id}/organization`).send({ ...guard, folderPath: "services" })).status).toBe(404);
    const moved = await request(app()).patch(endpoint).send({ ...guard, folderPath: "services" }); expect(moved.status).toBe(200);
    const root = await request(app()).patch(endpoint).send({ ...guard, expectedUpdatedAt: moved.body.updatedAt, expectedOrganizationRevision: moved.body.organizationRevision, folderPath: "" }); expect(root.status).toBe(200); expect(root.body.folderPath).toBe("");
  });
  it("rejects an organization review made before a key rotation", async () => {
    const service = secretService(db), key = await service.createSigningKey(companyId, { name: "Generic", privateKey: pem }, "synthetic-admin");
    await service.rotateSigningKey(companyId, key.id, pem, 1, "synthetic-admin", 1);
    const result = await request(app()).patch(`${base()}/${key.id}/organization`).send({ folderPath: "services", expectedLatestVersion: 1, expectedUpdatedAt: key.updatedAt.toISOString(), expectedOrganizationRevision: 0, confirmed: true });
    expect(result.status).toBe(409);
    expect((await service.listSigningKeys(companyId))[0]!.providerMetadata).not.toHaveProperty("signingFolderPath");
  });

});
