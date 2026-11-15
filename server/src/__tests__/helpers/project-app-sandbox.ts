import { createServer, type Server } from "node:http";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { createProjectAppBroker, loadProjectAppsConfig, PROJECT_APP_PERMISSIONS, projectAppsConfigSchema, type ProjectAppsConfig, type ProjectAppRole } from "../../services/github-project-apps.js";

/** Real local HTTP, RSA JWT validation, protected file IO, and durable state. No GitHub calls. */
export async function projectAppSandbox() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-project-apps-"));
  await chmod(directory, 0o700);
  const config: ProjectAppsConfig = {
    version: 1, companyId: randomUUID(), owner: "Hdom", stateDirectory: directory,
    apps: Object.fromEntries((["coordinator", "implementer", "reviewer"] as const).map((role, i) => [role, {
      appId: 11 + i, installationId: 101 + i, agentId: randomUUID(), privateKeyPath: path.join(directory, `${role}.pem`),
    }])) as ProjectAppsConfig["apps"],
  };
  const publicKeys = new Map<number, ReturnType<typeof generateKeyPairSync>["publicKey"]>();
  for (const role of Object.keys(config.apps) as ProjectAppRole[]) {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
    publicKeys.set(config.apps[role].appId, key.publicKey);
    const keyPath = config.apps[role].privateKeyPath;
    if (!keyPath) throw new Error("Fixture requires a file signing key");
    await writeFile(keyPath, key.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const configPath = path.join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const requests: { method: string; url: string; body: any; role?: ProjectAppRole }[] = [];
  const repositories = new Map<number, any>();
  const enrolled = new Map<ProjectAppRole, Set<number>>([["implementer", new Set()], ["reviewer", new Set()]]);
  const tokens = new Map<string, { role: ProjectAppRole; repositoryId?: number }>();
  const revoked: string[] = [];
  const apiEffects: { method: string; path: string; role: ProjectAppRole; body: any }[] = [];
  const apiFaults = { refuse: false, dropWrite: false, cleanupRefused: false, headSha: "a".repeat(40), mintDelayMs: 0 };
  const faults = { extraPermission: false, allRepositories: false, adminRefused: false, createDrop: false, driftScope: false, longExpiry: false, slow: false, redirect: "", foreignAppOwner: false, alreadyEnrolled: false, bootstrapGraphqlErrors: false, bootstrapCleanupRefused: false, bootstrapCleanupDrop: false };
  let repositorySequence = 900;
  const server = createServer(async (req, res) => {
    let bodyText = ""; for await (const chunk of req) bodyText += chunk;
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    let role: ProjectAppRole | undefined;
    const installed = (Object.keys(config.apps) as ProjectAppRole[]).find(r => req.url === `/app/installations/${config.apps[r].installationId}` || req.url === `/app/installations/${config.apps[r].installationId}/access_tokens`);
    if (installed || req.url === "/app") {
      const [header, payload, signature] = bearer.split(".");
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
      const jwtRole = installed ?? (Object.keys(config.apps) as ProjectAppRole[]).find(r => String(config.apps[r].appId) === claims.iss)!;
      expect(claims.iss).toBe(String(config.apps[jwtRole].appId));
      expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKeys.get(config.apps[jwtRole].appId)!, Buffer.from(signature!, "base64url"))).toBe(true);
      role = jwtRole;
    } else role = tokens.get(bearer)?.role;
    requests.push({ method: req.method!, url: req.url!, body, role });
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (faults.redirect) { res.writeHead(302, { location: faults.redirect }); res.end(); return; }
    if (faults.slow && req.url !== "/installation/token") { setTimeout(() => { if (!res.destroyed) json({}); }, 150); return; }
    if (!role) { json({ message: "forbidden" }, 403); return; }
    const apiPath = /^\/repos\/([^/]+\/[^/?]+)\/(contents(?:\/.*)?|commits|git\/refs|pulls(?:\/.*)?)(?:\?.*)?$/.exec(req.url ?? "");
    if (apiPath) {
      const repo = [...repositories.values()].find(repo => repo.full_name === apiPath[1]);
      const credential = tokens.get(bearer);
      if (!repo || credential?.repositoryId !== repo.id || (role !== "implementer" && role !== "reviewer")) { json({}, 403); return; }
      if (apiFaults.refuse || (role === "reviewer" && req.method !== "GET" && !/\/pulls\/\d+\/reviews$/.test(new URL(req.url!, "http://local").pathname))) { json({ message: "synthetic-provider-error-secret" }, 403); return; }
      apiEffects.push({ method: req.method!, path: req.url!, role, body });
      if (apiFaults.dropWrite && req.method !== "GET") { req.socket.destroy(); return; }
      if (/\/reviews$/.test(req.url!)) json({ id: 55, state: body.event, user: { login: `paperclip-${role}[bot]` } }, 200);
      else if (/\/pulls\/\d+$/.test(req.url!)) json({ number: 1, head: { sha: apiFaults.headSha } });
      else if (req.url!.includes("/contents/")) json({ type: "file", content: Buffer.from("synthetic file").toString("base64"), sha: "b".repeat(40) });
      else if (req.url!.includes("/commits")) json([{ sha: apiFaults.headSha }]);
      else if (req.url!.endsWith("/git/refs")) json({ ref: body.ref, object: { sha: body.sha } }, 201);
      else json(req.method === "GET" ? [] : { number: 1, title: body.title, user: { login: `paperclip-${role}[bot]` } }, req.method === "GET" ? 200 : 201);
      return;
    }
    if (req.url === "/app" && req.method === "GET") {
      json({ id: config.apps[role].appId, slug: `paperclip-${role}`, owner: { login: faults.foreignAppOwner ? "foreign-owner" : "Hdom", type: "User" }, permissions: PROJECT_APP_PERMISSIONS[role] });
    } else if (installed && req.method === "GET") {
      json({ id: config.apps[role].installationId, app_id: config.apps[role].appId, app_slug: `paperclip-${role}`, account: { login: "Hdom" }, target_type: "User", suspended_at: null,
        repository_selection: faults.allRepositories ? "all" : "selected", permissions: { ...PROJECT_APP_PERMISSIONS[role], ...(faults.extraPermission ? { administration: "write" } : {}) } });
    } else if (installed && req.method === "POST") {
      const inventory = JSON.stringify(body.permissions) === JSON.stringify({ metadata: "read" });
      if (!inventory) expect(body.permissions).toEqual(PROJECT_APP_PERMISSIONS[role]);
      const repositoryId = body.repository_ids?.[0];
      if (!inventory && role !== "coordinator" && (!repositoryId || !enrolled.get(role)?.has(repositoryId))) { json({}, 403); return; }
      if (repositoryId && apiFaults.mintDelayMs) await new Promise(resolve => setTimeout(resolve, apiFaults.mintDelayMs));
      const token = `synthetic-${role}-${randomUUID()}`;
      tokens.set(token, { role, repositoryId });
      json({ token, expires_at: new Date(Date.now() + (faults.longExpiry ? 7200000 : 3600000)).toISOString(), permissions: body.permissions,
        ...(repositoryId ? { repositories: [{ id: faults.driftScope ? repositoryId + 1 : repositoryId }] } : {}) }, 201);
    } else if (req.url === "/user/repos" && req.method === "POST" && role === "coordinator") {
      const repo = { id: ++repositorySequence, full_name: `Hdom/${body.name}`, owner: { login: "Hdom" }, private: body.private, permissions: { admin: false } };
      repositories.set(repo.id, repo);
      if (faults.createDrop) { req.socket.destroy(); return; }
      json(repo, 201);
    } else if (req.url?.split("?")[0] === "/installation/repositories" && req.method === "GET") {
      const selected = [...(enrolled.get(role) ?? [])].map(id => ({ ...(repositories.get(id) ?? {}), id }));
      json({ total_count: selected.length, repositories: selected });
    } else if (req.url === "/graphql" && req.method === "POST") {
      const repo = [...repositories.values()].find(repo => repo.full_name === "Hdom/paperclip-app-bootstrap-verification-20261113");
      json({ ...(faults.bootstrapGraphqlErrors ? { errors: [{ message: "synthetic denied" }] } : {}), data: { repository: repo ? {
        databaseId: repo.id, nameWithOwner: repo.full_name, owner: repo.owner, isPrivate: repo.private,
        isEmpty: repo.empty === true, isArchived: repo.archived === true, isDisabled: repo.disabled === true,
      } : null } });
    } else if (req.url?.startsWith("/users/") && req.method === "GET") {
      json({ login: `paperclip-${role}[bot]`, type: "Bot", id: 10000 + config.apps[role].appId });
    } else if (req.url?.startsWith("/repos/") && req.method === "GET") {
      const repo = [...repositories.values()].find(repo => req.url === `/repos/${repo.full_name}`);
      const credential = tokens.get(bearer)!;
      if (!repo || (credential.repositoryId && credential.repositoryId !== repo.id)) { json({}, 404); return; }
      json(repo);
    } else if (req.url?.startsWith("/user/installations/") && req.method === "PUT" && role === "coordinator") {
      if (faults.adminRefused) { json({ message: "provider-body-secret-must-not-escape" }, 403); return; }
      const match = /^\/user\/installations\/(\d+)\/repositories\/(\d+)$/.exec(req.url)!;
      const worker = (["implementer", "reviewer"] as const).find(r => config.apps[r].installationId === Number(match[1]));
      expect(worker).toBeTruthy(); enrolled.get(worker!)!.add(Number(match[2]));
      res.writeHead(faults.alreadyEnrolled ? 304 : 204); res.end();
    } else if (req.url?.startsWith("/user/installations/") && req.method === "DELETE" && role === "coordinator") {
      const match = /^\/user\/installations\/(\d+)\/repositories\/(\d+)$/.exec(req.url)!;
      const worker = (["implementer", "reviewer"] as const).find(r => config.apps[r].installationId === Number(match[1]));
      expect(worker).toBeTruthy(); expect(Number(match[2])).toBe(1457227143);
      if (faults.bootstrapCleanupRefused && worker === "reviewer") { json({}, 403); return; }
      expect(enrolled.get(worker!)!.size).toBeGreaterThan(1);
      enrolled.get(worker!)!.delete(Number(match[2]));
      if (faults.bootstrapCleanupDrop) { req.socket.destroy(); return; }
      res.writeHead(204); res.end();
    } else if (req.url === "/installation/token" && req.method === "DELETE") {
      if (apiFaults.cleanupRefused) { json({}, 503); return; }
      revoked.push(bearer); tokens.delete(bearer); res.writeHead(204); res.end();
    } else json({}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  const fetchImpl: typeof fetch = (url, init) => {
    expect(String(url).startsWith("https://api.github.com/")).toBe(true);
    const parsed = new URL(String(url)); return realFetch(origin + parsed.pathname + parsed.search, init);
  };
  return { config, configPath, directory, requests, repositories, enrolled, tokens, revoked, faults, apiEffects, apiFaults, fetchImpl, directFetch: realFetch,
    broker: createProjectAppBroker(config, { fetch: fetchImpl }),
    async cleanup() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); },
  };
}
