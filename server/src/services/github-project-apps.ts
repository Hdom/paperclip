import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { createSign, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { conflict, forbidden, unprocessable } from "../errors.js";

export const PROJECT_APP_PERMISSIONS = {
  coordinator: { metadata: "read", repository_creation: "write", installation_repositories: "write" },
  implementer: { metadata: "read", contents: "write", pull_requests: "write" },
  reviewer: { metadata: "read", contents: "read", pull_requests: "write" },
} as const;
export type ProjectAppRole = keyof typeof PROJECT_APP_PERMISSIONS;
const positiveId = z.number().int().positive().safe();
export const PROJECT_APP_BOOTSTRAP = {
  repositoryId: 1457227143,
  fullName: "Hdom/paperclip-app-bootstrap-verification-20261113",
} as const;
const appSchema = z.object({ appId: positiveId, installationId: positiveId, agentId: z.string().uuid(), privateKeyPath: z.string().min(1) }).strict();
export const projectAppsConfigSchema = z.object({
  version: z.literal(1), companyId: z.string().uuid(), owner: z.literal("Hdom"),
  stateDirectory: z.string().min(1),
  bootstrapRepository: z.object({
    repositoryId: z.literal(PROJECT_APP_BOOTSTRAP.repositoryId),
    fullName: z.literal(PROJECT_APP_BOOTSTRAP.fullName),
  }).strict().optional(),
  apps: z.object({ coordinator: appSchema, implementer: appSchema, reviewer: appSchema }).strict(),
}).strict().superRefine((config, ctx) => {
  for (const field of ["appId", "installationId", "agentId", "privateKeyPath"] as const) {
    if (new Set(Object.values(config.apps).map(app => app[field])).size !== 3)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Use three distinct ${field} values` });
  }
});
export type ProjectAppsConfig = z.infer<typeof projectAppsConfigSchema>;
const stateSchema = z.object({
  companyId: z.string().uuid(), projectId: z.string().uuid(),
  phase: z.enum(["creating", "created", "bootstrap_cleanup_pending", "ready"]),
  repositoryId: positiveId.optional(), fullName: z.string(),
}).strict();
type ProjectState = z.infer<typeof stateSchema>;

/** This file store is controller-only. No key, JWT, or access token is persisted in the ledger. */
async function protectedDirectory(directory: string) {
  if (!path.isAbsolute(directory) || await realpath(directory) !== directory)
    throw forbidden("GitHub App storage must use an absolute, non-symlinked controller directory");
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || ![0, process.getuid?.()].includes(info.uid))
    throw forbidden("GitHub App storage must be owned by root or the controller user and have mode 0700");
}
async function readProtected(file: string, maximum: number) {
  await protectedDirectory(path.dirname(file));
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum || (info.mode & 0o077) !== 0 || ![0, process.getuid?.()].includes(info.uid))
      throw forbidden("GitHub App files must be bounded regular controller files with mode 0600");
    // Read at most maximum+1 even if another controller process grows the file.
    const bytes = Buffer.alloc(maximum + 1);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > maximum) throw forbidden("GitHub App file is too large");
    return bytes.subarray(0, result.bytesRead).toString("utf8");
  } finally { await handle.close(); }
}
export async function loadProjectAppsConfig(): Promise<ProjectAppsConfig | null> {
  const file = process.env.PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG;
  if (!file) return null;
  // UNIX permission checks are intentional: this feature is for a protected Linux controller.
  if (process.platform === "win32") throw forbidden("GitHub App broker requires a protected Linux controller");
  let config: ProjectAppsConfig;
  try { config = projectAppsConfigSchema.parse(JSON.parse(await readProtected(file, 65536))); }
  catch { throw forbidden("GitHub project App configuration is invalid or unprotected"); }
  await protectedDirectory(config.stateDirectory);
  return config;
}
export function projectAppRole(config: ProjectAppsConfig, companyId: string, agentId: string) {
  if (config.companyId !== companyId) return null;
  return (Object.keys(config.apps) as ProjectAppRole[]).find(role => config.apps[role].agentId === agentId) ?? null;
}
function samePermissions(actual: unknown, expected: Record<string, string>) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const entries = Object.entries(actual).filter(([, value]) => value !== "none");
  return entries.length === Object.keys(expected).length && entries.every(([key, value]) => expected[key] === value);
}
function appJwt(appId: number, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${payload}.${createSign("RSA-SHA256").update(payload).sign(privateKey, "base64url")}`;
}

export function createProjectAppBroker(config: ProjectAppsConfig, options: {
  fetch?: typeof fetch; timeoutMs?: number; beforeMutation?: () => Promise<void>; assertActive?: () => void;
} = {}) {
  const fetchImpl = options.fetch ?? fetch;
  // No configurable API origin: production credentials can only be sent to GitHub.
  async function request(token: string, endpoint: string, method = "GET", body?: unknown, acceptedStatuses: number[] = []) {
    if (method === "POST" || method === "PUT" || (method === "DELETE" && endpoint !== "/installation/token")) {
      await options.beforeMutation?.();
      // Synchronous native-transport fence immediately before dispatch. Cleanup
      // DELETE remains available after Stop so controller tokens can be revoked.
      options.assertActive?.();
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
    let refusedStatus: number | undefined;
    try {
      const response = await fetchImpl(`https://api.github.com${endpoint}`, {
        method, redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok && !acceptedStatuses.includes(response.status)) { refusedStatus = response.status; throw new Error("provider refused"); }
      if (response.status === 204 || acceptedStatuses.includes(response.status)) return null;
      if (Number(response.headers.get("content-length")) > 131072) throw new Error("oversized");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("empty response");
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 131072) { await reader.cancel(); throw new Error("oversized"); }
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
    } catch (error) {
      // Never propagate fetch/signing/provider response text: it can contain credentials.
      if (refusedStatus) throw unprocessable(`GitHub App operation ${method} ${endpoint.split("?")[0]} returned HTTP ${refusedStatus}; permissions were not expanded`);
      throw unprocessable("GitHub App request failed or timed out; reconcile uncertain repository creation before retrying");
    } finally { clearTimeout(timeout); }
  }
  async function jwt(role: ProjectAppRole) {
    try { return appJwt(config.apps[role].appId, await readProtected(config.apps[role].privateKeyPath, 32768)); }
    catch { throw forbidden("GitHub App private key is invalid or not protected on the controller"); }
  }
  async function installation(role: ProjectAppRole, allowBootstrap = false) {
    const app = config.apps[role];
    const signed = await jwt(role);
    const registration = await request(signed, "/app");
    if (!registration || registration.id !== app.appId || registration.owner?.login !== config.owner || registration.owner?.type !== "User" ||
        !samePermissions(registration.permissions, PROJECT_APP_PERMISSIONS[role]))
      throw forbidden(`GitHub ${role} App registration is not owned by the approved personal account or has unapproved permissions`);
    const value = await request(signed, `/app/installations/${app.installationId}`);
    if (value?.id !== app.installationId || value.app_id !== app.appId ||
        value.account?.login !== config.owner || value.target_type !== "User" || value.suspended_at ||
        value.repository_selection !== "selected" || typeof value.app_slug !== "string" || value.app_slug !== registration.slug ||
        !samePermissions(value.permissions, PROJECT_APP_PERMISSIONS[role]))
      throw forbidden(`GitHub ${role} installation does not match the approved owner, selected repositories, or exact permissions`);
    if (role !== "coordinator") await verifyWorkerSelection(role, allowBootstrap);
    return value;
  }
  async function revoke(token: string) {
    try { await request(token, "/installation/token", "DELETE"); }
    catch { /* Never disclose tokens in cleanup errors; expiry remains at most one hour. */ }
  }
  async function issue(role: ProjectAppRole, repositoryId?: number, allowBootstrap = false) {
    if (repositoryId === PROJECT_APP_BOOTSTRAP.repositoryId)
      throw forbidden("The starter repository cannot receive project credentials");
    const installed = await installation(role, allowBootstrap);
    if (role !== "coordinator" && !repositoryId) throw forbidden("Worker tokens require one project repository");
    const value = await request(await jwt(role), `/app/installations/${config.apps[role].installationId}/access_tokens`, "POST", {
      permissions: PROJECT_APP_PERMISSIONS[role],
      ...(repositoryId ? { repository_ids: [repositoryId] } : {}),
    });
    const expiry = Date.parse(value?.expires_at);
    const valid = typeof value?.token === "string" && value.token.length > 0 &&
      Number.isFinite(expiry) && expiry > Date.now() && expiry <= Date.now() + 3610000 &&
      samePermissions(value.permissions, PROJECT_APP_PERMISSIONS[role]) &&
      (!repositoryId || (Array.isArray(value.repositories) && value.repositories.length === 1 && value.repositories[0].id === repositoryId));
    if (!valid) {
      if (typeof value?.token === "string") await revoke(value.token);
      throw forbidden("GitHub issued an unexpected token scope or expiry; token was not delivered");
    }
    return { token: value!.token as string, expiresAt: value!.expires_at as string, login: `${installed!.app_slug}[bot]` };
  }
  const statePath = (projectId: string) => path.join(config.stateDirectory, `${z.string().uuid().parse(projectId)}.json`);
  async function state(projectId: string) {
    try {
      const value = stateSchema.parse(JSON.parse(await readProtected(statePath(projectId), 8192)));
      if (value.companyId !== config.companyId || value.projectId !== projectId || value.fullName !== `${config.owner}/paperclip-${projectId}`)
        throw forbidden("GitHub project binding mismatch");
      if (value.repositoryId === PROJECT_APP_BOOTSTRAP.repositoryId)
        throw forbidden("The starter repository cannot be a project binding");
      return value;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw forbidden("GitHub project ledger is invalid or unprotected");
    }
  }
  async function verifyWorkerSelection(role: "implementer" | "reviewer", allowBootstrap = false): Promise<number[]> {
    // Verify installation scope as well as each exported token's scope. This
    // The one explicitly configured starter is tolerated only during provisioning,
    // never when delivering agent credentials. It must remain genuinely empty.
    await protectedDirectory(config.stateDirectory);
    const files = (await readdir(config.stateDirectory)).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name));
    if (files.length > 100) throw forbidden("This experimental broker supports at most 100 project repository bindings");
    const intended = new Set<number>();
    for (const file of files) {
      const value = await state(file.slice(0, -5));
      if (value?.repositoryId && value.phase !== "creating") intended.add(value.repositoryId);
    }
    const issued = await request(await jwt(role), `/app/installations/${config.apps[role].installationId}/access_tokens`, "POST", { permissions: { metadata: "read" } });
    if (typeof issued?.token !== "string" || !issued.token || !samePermissions(issued.permissions, { metadata: "read" }) ||
        !Number.isFinite(Date.parse(issued.expires_at)) || Date.parse(issued.expires_at) <= Date.now() || Date.parse(issued.expires_at) > Date.now() + 3610000) {
      if (typeof issued?.token === "string") await revoke(issued.token);
      throw forbidden("GitHub issued an unexpected token scope or expiry for installation inventory; token was not delivered");
    }
    try {
      const listing = await request(issued.token, "/installation/repositories?per_page=100");
      const bootstrap = allowBootstrap ? config.bootstrapRepository : undefined;
      if (!listing || !Array.isArray(listing.repositories) || listing.total_count !== listing.repositories.length || listing.repositories.length > 100 ||
          listing.repositories.some((repo: { id?: unknown }) => typeof repo.id !== "number" || (!intended.has(repo.id) && repo.id !== bootstrap?.repositoryId)))
        throw forbidden("GitHub worker installation includes an unrelated repository or exceeds the bounded inventory; selection was not expanded");
      const ids = listing.repositories.map((repo: { id: number }) => repo.id);
      if (bootstrap && ids.includes(bootstrap.repositoryId)) {
        const proof = await request(issued.token, "/graphql", "POST", {
          query: 'query { repository(owner: "Hdom", name: "paperclip-app-bootstrap-verification-20261113") { databaseId nameWithOwner isPrivate isEmpty isArchived isDisabled owner { login } } }',
        });
        const repo = proof?.data?.repository;
        if (proof?.errors || !repo || repo.databaseId !== bootstrap.repositoryId || repo.nameWithOwner !== bootstrap.fullName ||
            repo.owner?.login !== config.owner || repo.isPrivate !== true || repo.isEmpty !== true || repo.isArchived !== false || repo.isDisabled !== false)
          throw forbidden("GitHub starter repository identity, privacy, or emptiness could not be verified");
      }
      return ids;
    } finally { await revoke(issued.token); }
  }
  async function removeBootstrap(token: string, value: ProjectState, reauthorize: () => Promise<void>) {
    const bootstrap = config.bootstrapRepository;
    if (!bootstrap) return;
    // Prove both fixed workers retain the replacement before removing either
    // starter grant. Reconciliation skips removals already completed.
    const selections = new Map<"implementer" | "reviewer", number[]>();
    for (const role of ["implementer", "reviewer"] as const) {
      const credential = await issue(role, value.repositoryId, true);
      await revoke(credential.token);
      const ids = await verifyWorkerSelection(role, true);
      if (!ids.includes(value.repositoryId!)) throw conflict("Project access must be verified before starter removal");
      selections.set(role, ids);
    }
    for (const role of ["implementer", "reviewer"] as const) {
      if (!selections.get(role)!.includes(bootstrap.repositoryId)) continue;
      await reauthorize();
      await request(token, `/user/installations/${config.apps[role].installationId}/repositories/${bootstrap.repositoryId}`, "DELETE", undefined, [304]);
      const ids = await verifyWorkerSelection(role);
      if (ids.includes(bootstrap.repositoryId) || !ids.includes(value.repositoryId!))
        throw conflict("Starter removal is unverified; project credentials remain withheld");
    }
  }
  async function save(value: ProjectState) {
    await protectedDirectory(config.stateDirectory);
    const temporary = `${statePath(value.projectId)}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, statePath(value.projectId));
    const directory = await open(config.stateDirectory, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async function repository(token: string, value: ProjectState) {
    const repo = await request(token, `/repos/${value.fullName}`);
    if (!repo || repo.id !== value.repositoryId || repo.full_name !== value.fullName || repo.owner?.login !== config.owner || repo.private !== true || repo.archived || repo.disabled)
      throw forbidden("GitHub repository no longer matches this private project binding");
    return repo;
  }
  return {
    // Operator readiness check only: validates installations and inventory,
    // without creating/enrolling repositories or exporting any credential.
    async verifySetup() {
      for (const role of ["coordinator", "implementer", "reviewer"] as const)
        await installation(role, true);
      return { owner: config.owner, installationsVerified: 3, bootstrapConfigured: !!config.bootstrapRepository };
    },
    async provision(projectId: string, reauthorize: () => Promise<void>) {
      await protectedDirectory(config.stateDirectory);
      let lock;
      try { lock = await open(`${statePath(projectId)}.lock`, "wx", 0o600); }
      catch { throw conflict("Project provisioning is already running or needs controller reconciliation"); }
      let coordinatorToken: string | undefined;
      try {
        await reauthorize();
        let value = await state(projectId);
        if (value?.phase === "creating") throw conflict("Repository creation outcome is uncertain; controller reconciliation is required");
        // All three installations must match before repository creation changes GitHub.
        await installation("implementer", true); await installation("reviewer", true);
        coordinatorToken = (await issue("coordinator")).token;
        if (!value) {
          value = { companyId: config.companyId, projectId, phase: "creating", fullName: `${config.owner}/paperclip-${projectId}` };
          await reauthorize();
          await save(value);
          const created = await request(coordinatorToken, "/user/repos", "POST", {
            name: `paperclip-${projectId}`, private: true, auto_init: true,
            has_issues: false, has_projects: false, has_wiki: false,
          });
          if (!Number.isSafeInteger(created?.id) || created!.id <= 0 || created?.id === PROJECT_APP_BOOTSTRAP.repositoryId || created?.full_name !== value.fullName || created.owner?.login !== config.owner || created.private !== true)
            throw forbidden("Created repository did not match the project; controller reconciliation is required");
          value = { ...value, repositoryId: created.id, phase: "created" };
          // Save provider success even if the run stopped while GitHub processed the request.
          await save(value);
        }
        await repository(coordinatorToken, value);
        if (value.phase === "created") {
          // GitHub documents an admin prerequisite. Try only the approved narrow token;
          // a 403/404 is a blocker, never a reason to add Administration or a user token.
          for (const role of ["implementer", "reviewer"] as const) {
            await reauthorize();
            await request(coordinatorToken, `/user/installations/${config.apps[role].installationId}/repositories/${value.repositoryId}`, "PUT", undefined, [304]);
            // Prove the fixed worker installation can issue the exact one-repository token.
            const verified = await issue(role, value.repositoryId, true);
            await revoke(verified.token);
          }
          value = { ...value, phase: "bootstrap_cleanup_pending" };
          await save(value);
        }
        if (value.phase === "ready" && config.bootstrapRepository) {
          value = { ...value, phase: "bootstrap_cleanup_pending" };
          await save(value);
        }
        if (value.phase === "bootstrap_cleanup_pending") {
          await removeBootstrap(coordinatorToken, value, reauthorize);
          value = { ...value, phase: "ready" };
          await save(value);
        }
        await reauthorize();
        return { repositoryId: value.repositoryId!, repositoryUrl: `https://github.com/${value.fullName}`, fullName: value.fullName, status: "ready" as const };
      } finally {
        if (coordinatorToken) await revoke(coordinatorToken);
        await lock.close();
        await unlink(`${statePath(projectId)}.lock`);
      }
    },
    async workerCredential(role: "implementer" | "reviewer", projectId: string, reauthorize: () => Promise<void>) {
      await reauthorize();
      const value = await state(projectId);
      if (!value || value.phase !== "ready" || !value.repositoryId) throw conflict("Coordinator must provision this project repository first");
      const issued = await issue(role, value.repositoryId);
      let bot;
      try {
        await repository(issued.token, value);
        bot = await request(issued.token, `/users/${encodeURIComponent(issued.login)}`);
        if (bot?.login !== issued.login || bot.type !== "Bot" || !Number.isSafeInteger(bot.id) || bot.id <= 0)
          throw forbidden("GitHub App bot identity could not be verified");
        await reauthorize();
      }
      catch (error) { await revoke(issued.token); throw error; }
      return { ...issued, userId: String(bot!.id) };
    },
  };
}
