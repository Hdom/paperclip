import { createHash, createPrivateKey, createPublicKey, createSign } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, lstat, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";
import { createProjectAppBroker, projectAppsConfigSnapshot, saveProjectAppsConfig, withProjectAppsConfigLock, type ProjectAppsConfig, type ProjectAppRole } from "./github-project-apps.js";

const roles = ["coordinator", "implementer", "reviewer"] as const;
type Verification = Awaited<ReturnType<ReturnType<typeof createProjectAppBroker>["inspect"]>>;

/** Control-plane operations share native encrypted secret versions. No value DTO exists. */
export function githubProjectAppAdmin(db: Db) {
  const secrets = secretService(db);
  function signer(config: ProjectAppsConfig) {
    return (role: ProjectAppRole, appId: number, ref: { secretId: string; version: number }) =>
      secrets.signControllerGitHubAppJwt(config.companyId, ref.secretId, ref.version, role, appId);
  }
  async function snapshot(companyId: string) {
    const result = await projectAppsConfigSnapshot();
    if (!result || result.config.companyId !== companyId) throw forbidden("GitHub App support is not prepared for this company");
    return result;
  }
  async function current(companyId: string, revision: string) {
    const result = await snapshot(companyId);
    if (result.revision !== revision) throw conflict("GitHub App settings changed. Reload and confirm again");
    return result;
  }
  const cachePath = () => path.join(path.dirname(process.env.PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG!), "ui-verification.json");
  async function readVerification(revision: string): Promise<Verification | null> {
    let handle;
    try {
      const file = cachePath(); if (await realpath(file) !== file) return null;
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > 131072 || (stat.mode & 0o077)) return null;
      const bytes = Buffer.alloc(131073); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 131072) return null;
      const parsed = JSON.parse(bytes.subarray(0, bytesRead).toString());
      return parsed.revision === revision ? parsed.verification : null;
    } catch { return null; } finally { await handle?.close(); }
  }
  async function storeVerification(revision: string, verification: Verification) {
    const file = cachePath(), temporary = `${file}.pending`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ revision, verification })); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  }
  async function inspect(config: ProjectAppsConfig, revision: string, override?: Parameters<typeof createProjectAppBroker>[1]) {
    const verified = await createProjectAppBroker(config, {
      signKey: signer(config), beforeMutation: async () => { await current(config.companyId, revision); }, ...override,
    }).inspect();
    await current(config.companyId, revision);
    return verified;
  }
  async function requireIdle(companyId: string, ids: string[]) {
    const running = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.agentId, ids), inArray(heartbeatRuns.status, ["running", "queued"]),
    )).limit(1);
    if (running.length) throw conflict("Wait for affected agent runs to settle before changing identity assignments");
  }
  async function save(config: ProjectAppsConfig, revision: string) {
    await saveProjectAppsConfig({ ...config, revision: (config.revision ?? 0) + 1 }, revision);
  }
  return {
    async settings(companyId: string, canManage: boolean) {
      const loaded = await projectAppsConfigSnapshot();
      if (!loaded || loaded.config.companyId !== companyId) return { available: false, canManage, roles: [], blockedAgentIds: [], revision: "", enabled: false, checkedAt: null };
      const { config, revision } = loaded;
      const verified = canManage ? await readVerification(revision) : null;
      const rows = [];
      for (const role of roles) {
        const app = config.apps[role], result = verified?.roles.find(row => row.role === role);
        const key = app.signingKeySecret ? await secrets.getById(app.signingKeySecret.secretId) : null;
        const validKey = key?.scope === "controller" && key.companyId === companyId && key.providerMetadata?.role === role && key.providerMetadata?.appId === app.appId;
        rows.push({ role, agentId: app.agentId, appId: app.appId, installationId: app.installationId,
          installationUrl: `https://github.com/settings/installations/${app.installationId}`,
          appUrl: result?.appUrl ?? null, login: result?.login ?? null,
          status: config.enabled === false ? "paused" : result?.status ?? "unverified",
          message: result && "message" in result ? result.message : null,
          repositories: canManage ? result?.repositories ?? [] : [],
          publicFingerprint: canManage ? result?.publicFingerprint ?? null : null,
          keyStorage: app.signingKeySecret ? "native_encrypted" : "legacy_file",
          secretId: canManage ? app.signingKeySecret?.secretId ?? null : null,
          pinnedVersion: canManage ? app.signingKeySecret?.version ?? null : null,
          latestVersion: canManage && validKey ? key.latestVersion : null,
          keyStatus: validKey ? key.status : app.signingKeySecret ? "unavailable" : "migration_required",
        });
      }
      const migrated = roles.every(role => !!config.apps[role].signingKeySecret), cleanupPending: ProjectAppRole[] = [];
      if (canManage && migrated) for (const role of roles) {
        try { await lstat(path.join(path.dirname(process.env.PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG!), "keys", `${role}.pem`)); cleanupPending.push(role); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      return { available: true, canManage, enabled: config.enabled !== false, revision, roles: rows,
        blockedAgentIds: config.blockedAgentIds ?? [], checkedAt: verified?.checkedAt ?? null, migration: { migrated, cleanupPending } };
    },
    async migrate(companyId: string, revision: string, userId: string) {
      return withProjectAppsConfigLock(async () => {
        const { config } = await current(companyId, revision);
        await requireIdle(companyId, roles.map(role => config.apps[role].agentId));
        const candidate = structuredClone(config);
        const originals = new Map<ProjectAppRole, { file: string; inode: number; fingerprint: string; size: number; mtimeMs: number; ctimeMs: number }>();
        const expectedRoot = path.join(path.dirname(process.env.PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG!), "keys");
        for (const role of roles) {
          const app = config.apps[role], file = path.join(expectedRoot, `${role}.pem`);
          if (app.privateKeyPath && app.privateKeyPath !== file) throw forbidden("Migration requires the prepared fixed controller key paths");
          let exists = true;
          try { await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
          if (!exists) {
            if (!app.signingKeySecret) throw forbidden("A prepared signing key is missing");
            continue;
          }
          if (await realpath(expectedRoot) !== expectedRoot || (await lstat(expectedRoot)).mode & 0o077) throw forbidden("Unprotected migration source");
          const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
          let privateKey: string, inode: number, size: number, mtimeMs: number, ctimeMs: number;
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || stat.size > 16384)
              throw forbidden("Unprotected migration source");
            inode = stat.ino;
            size = stat.size; mtimeMs = stat.mtimeMs; ctimeMs = stat.ctimeMs;
            const buffer = Buffer.alloc(16385); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > 16384) throw forbidden("Signing key exceeds the supported size");
            privateKey = buffer.subarray(0, bytesRead).toString(); buffer.fill(0);
            const after = await handle.stat();
            if (after.ino !== inode || after.size !== size || after.mtimeMs !== mtimeMs || after.ctimeMs !== ctimeMs) throw forbidden("Signing key changed during migration");
          } finally { await handle.close(); }
          let fingerprint: string;
          try { fingerprint = `SHA256:${createHash("sha256").update(createPublicKey(privateKey).export({ type: "spki", format: "der" })).digest("base64")}`; }
          catch { throw forbidden("Invalid prepared signing key"); }
          originals.set(role, { file, inode, fingerprint, size, mtimeMs, ctimeMs });
          if (!app.signingKeySecret) {
            const existing = (await secrets.listControllerSigningKeys(companyId)).find(row => row.key === `github-app-signing.${role}`);
            const stored = existing ?? await secrets.createControllerSigningKey(companyId, role, app.appId, privateKey, userId);
            const signed = await secrets.signControllerGitHubAppJwt(companyId, stored.id, 1, role, app.appId);
            if (signed.publicFingerprint !== fingerprint) throw forbidden("Native signing-key migration needs reconciliation");
            candidate.apps[role] = { appId: app.appId, installationId: app.installationId, agentId: app.agentId, signingKeySecret: { secretId: stored.id, version: 1 } };
          } else {
            const signed = await secrets.signControllerGitHubAppJwt(companyId, app.signingKeySecret.secretId, app.signingKeySecret.version, role, app.appId);
            if (signed.publicFingerprint !== fingerprint) throw forbidden("Plaintext cleanup does not match the active native key");
          }
        }
        const verified = await inspect(candidate, revision);
        if (verified.roles.some(row => row.status !== "verified")) throw unprocessable("Native signing keys did not verify; original configuration and files were retained");
        let activeRevision = revision;
        if (JSON.stringify(candidate) !== JSON.stringify(config)) {
          await save(candidate, revision);
          const committed = await snapshot(companyId); activeRevision = committed.revision;
          try {
            await createProjectAppBroker(committed.config, { signKey: signer(committed.config), beforeMutation: async () => { await current(companyId, activeRevision); } }).verifySetup();
          } catch {
            // This rollback runs before any plaintext deletion. Native encrypted
            // versions are retained for recovery; no new PEM backup is made.
            await save({ ...config, revision: committed.config.revision }, activeRevision);
            throw unprocessable("Native verification failed; original configuration and files were restored");
          }
        }
        const cleanupPending: ProjectAppRole[] = [];
        for (const [role, source] of originals) {
          try {
            const stat = await lstat(source.file);
            if (stat.ino !== source.inode || stat.nlink !== 1 || stat.isSymbolicLink() || stat.size !== source.size || stat.mtimeMs !== source.mtimeMs || stat.ctimeMs !== source.ctimeMs) throw new Error("changed source");
            await unlink(source.file);
          } catch { cleanupPending.push(role); }
        }
        await storeVerification(activeRevision, verified);
        return { migrated: true, cleanupPending };
      });
    },
    async verify(companyId: string, revision: string) {
      return withProjectAppsConfigLock(async () => {
        const { config } = await current(companyId, revision);
        const verified = await inspect(config, revision);
        await storeVerification(revision, verified);
        return verified;
      });
    },
    async configure(companyId: string, revision: string, input: { enabled?: boolean; bindings?: Record<ProjectAppRole, string>; releaseAgentId?: string }) {
      return withProjectAppsConfigLock(async () => {
        const { config } = await current(companyId, revision); const candidate = structuredClone(config);
        if (input.enabled !== undefined) candidate.enabled = input.enabled;
        if (input.bindings) {
          const ids = roles.map(role => input.bindings![role]);
          if (new Set(ids).size !== 3) throw unprocessable("Use a different agent for each App role");
          const found = await db.select({ id: agents.id, status: agents.status }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, ids)));
          if (found.length !== 3 || found.some(agent => agent.status === "terminated")) throw forbidden("Choose active agents from this company");
          const changed = roles.filter(role => input.bindings![role] !== config.apps[role].agentId);
          if (changed.length) await requireIdle(companyId, [...new Set(changed.flatMap(role => [config.apps[role].agentId, input.bindings![role]]))]);
          candidate.blockedAgentIds = [...new Set([...(config.blockedAgentIds ?? []), ...changed.map(role => config.apps[role].agentId)])];
          for (const role of roles) candidate.apps[role].agentId = input.bindings[role];
          candidate.blockedAgentIds = candidate.blockedAgentIds.filter(id => !ids.includes(id));
        }
        if (input.releaseAgentId) {
          if (roles.some(role => candidate.apps[role].agentId === input.releaseAgentId)) throw conflict("Reassign this App role before releasing its managed identity");
          await requireIdle(companyId, [input.releaseAgentId]);
          candidate.blockedAgentIds = (candidate.blockedAgentIds ?? []).filter(id => id !== input.releaseAgentId);
        }
        if (candidate.enabled !== false && (config.enabled === false || input.bindings)) {
          const verified = await inspect(candidate, revision);
          if (verified.roles.some(row => row.status !== "verified")) throw unprocessable("Verify all three App identities before enabling or assigning them");
        }
        await save(candidate, revision);
      });
    },
    async rotate(companyId: string, revision: string, role: ProjectAppRole, privateKey: string, expectedLatestVersion: number, userId: string) {
      return withProjectAppsConfigLock(async () => {
        const { config } = await current(companyId, revision), app = config.apps[role];
        if (!app.signingKeySecret) throw conflict("Migrate this identity into native Secrets before rotating its key");
        let key;
        try { key = createPrivateKey(privateKey); if (key.asymmetricKeyType !== "rsa") throw new Error(); }
        catch { throw unprocessable("A valid RSA signing key is required"); }
        const publicFingerprint = `SHA256:${createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("base64")}`;
        const signKey = async (r: ProjectAppRole, appId: number, ref: { secretId: string; version: number }) => {
          if (r !== role) return signer(config)(r, appId, ref);
          const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"), now = Math.floor(Date.now() / 1000);
          const body = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
          return { jwt: `${body}.${createSign("RSA-SHA256").update(body).sign(key, "base64url")}`, publicFingerprint };
        };
        const check = await inspect(config, revision, { signKey });
        if (check.roles.find(row => row.role === role)?.status !== "verified") throw unprocessable("The new key did not verify for this exact App and installation");
        const rotated = await secrets.rotateControllerSigningKey(companyId, app.signingKeySecret.secretId, role, app.appId, privateKey, expectedLatestVersion, userId);
        const candidate = structuredClone(config); candidate.apps[role].signingKeySecret!.version = rotated.latestVersion;
        // A crash before this atomic reference swap leaves the old pinned native
        // version authoritative. It never exposes an unverified latest value.
        await save(candidate, revision);
        return { version: rotated.latestVersion, publicFingerprint };
      });
    },
    async activateVersion(companyId: string, revision: string, role: ProjectAppRole, version: number) {
      return withProjectAppsConfigLock(async () => {
        const { config } = await current(companyId, revision);
        if (!config.apps[role].signingKeySecret) throw conflict("Native signing key required");
        const candidate = structuredClone(config); candidate.apps[role].signingKeySecret!.version = version;
        const verified = await inspect(candidate, revision);
        if (verified.roles.find(row => row.role === role)?.status !== "verified") throw unprocessable("This key version did not verify for the App and installation");
        await save(candidate, revision);
      });
    },
  };
}
