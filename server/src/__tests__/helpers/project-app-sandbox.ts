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
    await writeFile(config.apps[role].privateKeyPath, key.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const configPath = path.join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const requests: { method: string; url: string; body: any; role?: ProjectAppRole }[] = [];
  const repositories = new Map<number, any>();
  const enrolled = new Map<ProjectAppRole, Set<number>>([["implementer", new Set()], ["reviewer", new Set()]]);
  const tokens = new Map<string, { role: ProjectAppRole; repositoryId?: number }>();
  const revoked: string[] = [];
  const faults = { extraPermission: false, allRepositories: false, adminRefused: false, createDrop: false, driftScope: false, longExpiry: false, slow: false, redirect: "" };
  let repositorySequence = 900;
  const server = createServer(async (req, res) => {
    let bodyText = ""; for await (const chunk of req) bodyText += chunk;
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    let role: ProjectAppRole | undefined;
    const installed = (Object.keys(config.apps) as ProjectAppRole[]).find(r => req.url === `/app/installations/${config.apps[r].installationId}` || req.url === `/app/installations/${config.apps[r].installationId}/access_tokens`);
    if (installed) {
      const [header, payload, signature] = bearer.split(".");
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
      expect(claims.iss).toBe(String(config.apps[installed].appId));
      expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKeys.get(config.apps[installed].appId)!, Buffer.from(signature!, "base64url"))).toBe(true);
      role = installed;
    } else role = tokens.get(bearer)?.role;
    requests.push({ method: req.method!, url: req.url!, body, role });
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (faults.redirect) { res.writeHead(302, { location: faults.redirect }); res.end(); return; }
    if (faults.slow) { setTimeout(() => { if (!res.destroyed) json({}); }, 150); return; }
    if (!role) { json({ message: "forbidden" }, 403); return; }
    if (installed && req.method === "GET") {
      json({ id: config.apps[role].installationId, app_id: config.apps[role].appId, app_slug: `paperclip-${role}`, account: { login: "Hdom" }, target_type: "User", suspended_at: null,
        repository_selection: faults.allRepositories ? "all" : "selected", permissions: { ...PROJECT_APP_PERMISSIONS[role], ...(faults.extraPermission ? { administration: "write" } : {}) } });
    } else if (installed && req.method === "POST") {
      const inventory = JSON.stringify(body.permissions) === JSON.stringify({ metadata: "read" });
      if (!inventory) expect(body.permissions).toEqual(PROJECT_APP_PERMISSIONS[role]);
      const repositoryId = body.repository_ids?.[0];
      if (!inventory && role !== "coordinator" && (!repositoryId || !enrolled.get(role)?.has(repositoryId))) { json({}, 403); return; }
      const token = `synthetic-${role}-${randomUUID()}`;
      tokens.set(token, { role, repositoryId });
      json({ token, expires_at: new Date(Date.now() + (faults.longExpiry ? 7200000 : 3600000)).toISOString(), permissions: body.permissions,
        ...(repositoryId ? { repositories: [{ id: faults.driftScope ? repositoryId + 1 : repositoryId }] } : {}) }, 201);
    } else if (req.url === "/user/repos" && req.method === "POST" && role === "coordinator") {
      const repo = { id: ++repositorySequence, full_name: `Hdom/${body.name}`, owner: { login: "Hdom" }, private: body.private, permissions: { admin: false } };
      repositories.set(repo.id, repo);
      if (faults.createDrop) { req.socket.destroy(); return; }
      json(repo, 201);
    } else if (req.url === "/installation/repositories" && req.method === "GET") {
      const selected = [...(enrolled.get(role) ?? [])].map(id => ({ id }));
      json({ total_count: selected.length, repositories: selected });
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
      res.writeHead(204); res.end();
    } else if (req.url === "/installation/token" && req.method === "DELETE") {
      revoked.push(bearer); tokens.delete(bearer); res.writeHead(204); res.end();
    } else json({}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  const fetchImpl: typeof fetch = (url, init) => {
    expect(String(url).startsWith("https://api.github.com/")).toBe(true);
    return realFetch(origin + new URL(String(url)).pathname, init);
  };
  return { config, configPath, directory, requests, repositories, enrolled, tokens, revoked, faults, fetchImpl,
    broker: createProjectAppBroker(config, { fetch: fetchImpl }),
    async cleanup() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); },
  };
}
