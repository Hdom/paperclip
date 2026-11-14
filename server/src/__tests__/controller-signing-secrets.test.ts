import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, companySecrets, companySecretVersions, createDb } from "@paperclipai/db";
import { secretService } from "../services/secrets.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native controller signing secrets", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  let companyId: string, secrets: ReturnType<typeof secretService>;
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("controller-signing-keys-"); db = createDb(database.connectionString); }, 30000);
  afterAll(async () => { await database?.cleanup(); }, 60000);
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    companyId = randomUUID(); await db.insert(companies).values({ id: companyId, name: "Synthetic controller secret", issuePrefix: companyId.slice(0, 8) });
    secrets = secretService(db);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  async function create() { return secrets.createControllerSigningKey(companyId, "reviewer", 13, pem, "synthetic-admin"); }
  it("stores native encrypted versions and returns a verifiable JWT without returning key material", async () => {
    const secret = await create(); expect(secret.scope).toBe("controller");
    const [version] = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id));
    expect(version.material).toHaveProperty("scheme", "local_encrypted_v1");
    expect(JSON.stringify(version)).not.toContain("PRIVATE KEY");
    const signed = await secrets.signControllerGitHubAppJwt(companyId, secret.id, 1, "reviewer", 13);
    const [header, payload, signature] = signed.jwt.split(".");
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims.iss).toBe("13"); expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(Object.keys(signed).sort()).toEqual(["jwt", "publicFingerprint"]);
    expect(await secrets.list(companyId)).toEqual([]);
  });
  it("denies generic reads and references before provider decryption even with system-looking context", async () => {
    const secret = await create(); const decrypt = vi.spyOn(localEncryptedProvider, "resolveVersion");
    await expect(secrets.resolveSecretValue(companyId, secret.id, 1)).rejects.toThrow();
    await expect(secrets.resolveSecretValue(companyId, secret.id, 1, { accessContext: { consumerType: "tool_connection", consumerId: "github_project_apps", actorType: "system" } })).rejects.toThrow();
    await expect(secrets.resolveSecretVersion(companyId, secret.id, 1)).rejects.toThrow("runtime references");
    await expect(secrets.createBinding({ companyId, secretId: secret.id, targetType: "agent", targetId: randomUUID(), configPath: "env.SIGNING_KEY" })).rejects.toThrow("company-scoped");
    await expect(secrets.normalizeEnvBindingsForPersistence(companyId, { SIGNING_KEY: { type: "secret_ref", secretId: secret.id, version: 1 } })).rejects.toThrow();
    expect(decrypt).not.toHaveBeenCalled();
  });
  it("refuses all generic lifecycle mutations while preserving ordinary company secrets", async () => {
    const secret = await create();
    await expect(secrets.rotate(secret.id, { value: pem })).rejects.toThrow("managed lifecycle");
    await expect(secrets.update(secret.id, { key: "ordinary", providerMetadata: {} })).rejects.toThrow("managed lifecycle");
    await expect(secrets.remove(secret.id)).rejects.toThrow("managed lifecycle");
    const normal = await secrets.create(companyId, { name: "ordinary", provider: "local_encrypted", value: "synthetic-normal-value" });
    expect(await secrets.resolveSecretValue(companyId, normal.id, 1)).toBe("synthetic-normal-value");
    await secrets.rotate(normal.id, { value: "synthetic-rotated" });
    expect(await secrets.resolveSecretValue(companyId, normal.id, "latest")).toBe("synthetic-rotated");
  });
  it("requires exact company, role, App and pinned active version", async () => {
    const secret = await create();
    for (const args of [[randomUUID(), 1, "reviewer", 13], [companyId, 1, "implementer", 13], [companyId, 1, "reviewer", 99], [companyId, 0, "reviewer", 13], [companyId, 99, "reviewer", 13]] as const) {
      await expect(secrets.signControllerGitHubAppJwt(args[0], secret.id, args[1], args[2], args[3])).rejects.toThrow();
    }
    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, secret.id));
    await expect(secrets.signControllerGitHubAppJwt(companyId, secret.id, 1, "reviewer", 13)).rejects.toThrow();
  });
  it("keeps the pinned old version usable through a failed/stale rotation and supports explicit cutover", async () => {
    const secret = await create(); const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const otherPem = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const rotated = await secrets.rotateControllerSigningKey(companyId, secret.id, "reviewer", 13, otherPem, 1, "synthetic-admin");
    expect(rotated.latestVersion).toBe(2);
    await expect(secrets.rotateControllerSigningKey(companyId, secret.id, "reviewer", 13, pem, 1, "synthetic-admin")).rejects.toThrow("stale");
    const old = await secrets.signControllerGitHubAppJwt(companyId, secret.id, 1, "reviewer", 13);
    const current = await secrets.signControllerGitHubAppJwt(companyId, secret.id, 2, "reviewer", 13);
    expect(old.publicFingerprint).not.toBe(current.publicFingerprint);
  });
  it("rejects forged signing capability, ordinary lookalikes and inactive versions before decryption", async () => {
    const secret = await create();
    const normal = await secrets.create(companyId, { name: "Ordinary signing lookalike",
      key: "github-app-signing.reviewer", provider: "local_encrypted", value: pem,
      providerMetadata: { consumer: "github_project_apps", role: "reviewer", appId: 13 } });
    const decrypt = vi.spyOn(localEncryptedProvider, "resolveVersion");
    await expect(secrets.resolveSecretValue(companyId, secret.id, 1, {
      controllerSigningCapability: Symbol("controller-signing-only"),
      allowUserSecretScope: true, instanceOwner: { pluginId: randomUUID(), agentId: randomUUID() },
      accessContext: { actorType: "system", consumerType: "tool_connection", consumerId: "github_project_apps" },
    } as never)).rejects.toThrow();
    await expect(secrets.signControllerGitHubAppJwt(companyId, normal.id, 1, "reviewer", 13)).rejects.toThrow("identity mismatch");
    for (const status of ["disabled", "destroyed"] as const) {
      await db.update(companySecretVersions).set({ status, revokedAt: null }).where(eq(companySecretVersions.secretId, secret.id));
      await expect(secrets.signControllerGitHubAppJwt(companyId, secret.id, 1, "reviewer", 13)).rejects.toThrow();
    }
    await db.update(companySecretVersions).set({ status: "current", revokedAt: new Date() }).where(eq(companySecretVersions.secretId, secret.id));
    await expect(secrets.signControllerGitHubAppJwt(companyId, secret.id, 1, "reviewer", 13)).rejects.toThrow();
    expect(decrypt).not.toHaveBeenCalled();
    expect(await secrets.resolveSecretValue(companyId, normal.id, 1)).toBe(pem);
  });

});
