import express from "express";
import request from "supertest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb } from "@paperclipai/db";
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
    expect(Object.keys(created.body).sort()).toEqual(["algorithm", "createdAt", "description", "githubApp", "id", "latestVersion", "name", "publicFingerprint", "revision", "status", "type", "updatedAt"]);
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
});
