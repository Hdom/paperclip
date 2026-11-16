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

  it("stores generic RSA, EC and Ed25519 keys without permitting generic value or agent access", async () => {
    const keys = [pair, generateKeyPairSync("ec", { namedCurve: "prime256v1" }), generateKeyPairSync("ed25519")];
    for (const key of keys) {
      const privateKey = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const secret = await secrets.createSigningKey(companyId, { name: "Synthetic signing key", privateKey }, "synthetic-admin");
      expect(secret.scope).toBe("controller");
      expect(secret.providerMetadata?.signingPublicKey).toMatchObject({ version: 1, algorithm: key.privateKey.asymmetricKeyType });
      const decrypt = vi.spyOn(localEncryptedProvider, "resolveVersion");
      await expect(secrets.resolveSecretValue(companyId, secret.id, 1)).rejects.toThrow();
      await expect(secrets.resolveSecretVersionIdentity(companyId, secret.id, 1)).rejects.toThrow();
      await expect(secrets.createBinding({ companyId, secretId: secret.id, targetType: "agent", targetId: randomUUID(), configPath: "env.KEY" })).rejects.toThrow();
      expect(decrypt).not.toHaveBeenCalled(); decrypt.mockRestore();
      const versions = await secrets.signingKeyVersions(companyId, secret.id);
      expect(Object.keys(versions[0]!).sort()).toEqual(["createdAt", "id", "status", "version"]);
      expect(JSON.stringify(versions)).not.toContain("PRIVATE KEY");
    }
    expect(await secrets.list(companyId)).toEqual([]);
  });
  it("rotates generic keys with an exact version and protects typed consumer keys", async () => {
    const secret = await secrets.createSigningKey(companyId, { name: "Generic key", privateKey: pem }, "synthetic-admin");
    const replacement = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const rotated = await secrets.rotateSigningKey(companyId, secret.id, replacement, 1, "synthetic-admin");
    expect(rotated.latestVersion).toBe(2);
    expect(rotated.providerMetadata?.signingPublicKey).toMatchObject({ version: 2, algorithm: "ed25519" });
    await expect(secrets.rotateSigningKey(companyId, secret.id, pem, 1, "synthetic-admin")).rejects.toThrow("stale");
    await expect(secrets.rotateSigningKey(randomUUID(), secret.id, pem, 2, "synthetic-admin")).rejects.toThrow("not found");
    const typed = await create();
    await expect(secrets.rotateSigningKey(companyId, typed.id, pem, 1, "synthetic-admin")).rejects.toThrow("verified lifecycle");
    await expect(secrets.updateSigningKey(companyId, typed.id, { status: "disabled", expectedRevision: 1, expectedLatestVersion: 1 })).rejects.toThrow("verified lifecycle");
    expect((await secrets.signControllerGitHubAppJwt(companyId, typed.id, 1, "reviewer", 13)).jwt).toBeTruthy();
  });
  it("keeps lifecycle updates company-bound and version-guarded without changing identity", async () => {
    const secret = await secrets.createSigningKey(companyId, { name: "Generic key", privateKey: pem }, "synthetic-admin");
    await expect(secrets.updateSigningKey(randomUUID(), secret.id, { status: "disabled", expectedRevision: 1, expectedLatestVersion: 1 })).rejects.toThrow("not found");
    await expect(secrets.updateSigningKey(companyId, secret.id, { status: "disabled", expectedRevision: 1, expectedLatestVersion: 2 })).rejects.toThrow("stale");
    const updated = await secrets.updateSigningKey(companyId, secret.id, { name: "Renamed key", status: "disabled", expectedRevision: 1, expectedLatestVersion: 1 });
    expect(updated.providerMetadata).toEqual({ ...secret.providerMetadata, lifecycleRevision: 2 });
    expect(updated.key).toBe(secret.key);
    await expect(secrets.rotateSigningKey(companyId, secret.id, pem, 1, "synthetic-admin")).rejects.toThrow("non-active");
    await expect(secrets.update(secret.id, { providerMetadata: {} })).rejects.toThrow("managed lifecycle");
  });

  it("rejects a concurrent disable during provider preparation without advancing the version", async () => {
    const secret = await secrets.createSigningKey(companyId, { name: "Race key", privateKey: pem }, "synthetic-admin");
    const prepare = localEncryptedProvider.createVersion!.bind(localEncryptedProvider);
    vi.spyOn(localEncryptedProvider, "createVersion").mockImplementationOnce(async input => {
      const prepared = await prepare(input);
      await secrets.updateSigningKey(companyId, secret.id, { status: "disabled", expectedLatestVersion: 1, expectedRevision: 1 });
      return prepared;
    });
    await expect(secrets.rotateSigningKey(companyId, secret.id, pem, 1, "synthetic-admin")).rejects.toThrow("stale");
    const current = await secrets.getById(secret.id);
    expect(current).toMatchObject({ latestVersion: 1, status: "disabled" });
    expect(current?.providerMetadata?.lifecycleRevision).toBe(2);
  });
  it("rejects a stale activation after another lifecycle change", async () => {
    const secret = await secrets.createSigningKey(companyId, { name: "Lifecycle key", privateKey: pem }, "synthetic-admin");
    await secrets.updateSigningKey(companyId, secret.id, { status: "disabled", expectedLatestVersion: 1, expectedRevision: 1 });
    await expect(secrets.updateSigningKey(companyId, secret.id, { status: "active", expectedLatestVersion: 1, expectedRevision: 1 })).rejects.toThrow("changed");
    expect((await secrets.getById(secret.id))?.status).toBe("disabled");
  });
  it("binds the original identity across the internal rotation reread", async () => {
    const secret = await secrets.createSigningKey(companyId, { name: "Identity race key", privateKey: pem }, "synthetic-admin");
    const select = db.select.bind(db); let reads = 0;
    vi.spyOn(db, "select").mockImplementation(((...args: Parameters<typeof db.select>) => {
      const query = select(...args); const from = query.from.bind(query);
      query.from = ((table: unknown) => {
        const built = from(table as never);
        if (table === companySecrets && ++reads === 2) {
          const where = built.where.bind(built);
          built.where = ((condition: unknown) => {
            const selected = where(condition as never); const then = selected.then.bind(selected);
            selected.then = ((resolve: unknown, reject: unknown) => db.update(companySecrets)
              .set({ providerMetadata: { consumer: "some_future_consumer" } }).where(eq(companySecrets.id, secret.id))
              .then(() => then(resolve as never, reject as never))) as typeof selected.then;
            return selected;
          }) as typeof built.where;
        }
        return built;
      }) as typeof query.from;
      return query;
    }) as typeof db.select);
    await expect(secrets.rotateSigningKey(companyId, secret.id, pem, 1, "synthetic-admin")).rejects.toThrow("identity changed");
    expect((await secrets.getById(secret.id))?.latestVersion).toBe(1);
  });

  it.each(["generic", "github"] as const)("preserves a %s key's folder during a concurrent rotation", async type => {
    const key = type === "generic" ? await secrets.createSigningKey(companyId, { name: "Folder race", privateKey: pem }, "synthetic-admin") : await create();
    const prepare = localEncryptedProvider.createVersion!.bind(localEncryptedProvider);
    vi.spyOn(localEncryptedProvider, "createVersion").mockImplementationOnce(async input => {
      const prepared = await prepare(input);
      await secrets.organizeSigningKey(companyId, key.id, { folderPath: "services/github", expectedLatestVersion: 1,
        expectedUpdatedAt: key.updatedAt.toISOString(), expectedOrganizationRevision: 0 });
      return prepared;
    });
    const rotation = type === "generic" ? secrets.rotateSigningKey(companyId, key.id, pem, 1, "synthetic-admin")
      : secrets.rotateControllerSigningKey(companyId, key.id, "reviewer", 13, pem, 1, "synthetic-admin");
    await expect(rotation).rejects.toThrow("stale");
    const current = await secrets.getById(key.id);
    expect(current).toMatchObject({ latestVersion: 1, key: key.key, name: key.name, scope: "controller", status: "active" });
    expect(current?.providerMetadata).toEqual({ ...key.providerMetadata, signingFolderPath: "services/github", signingOrganizationRevision: 1 });
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, key.id))).toHaveLength(1);
    if (type === "github") expect((await secrets.signControllerGitHubAppJwt(companyId, key.id, 1, "reviewer", 13)).jwt).toBeTruthy();
  });

});
