import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectAppBroker, loadProjectAppsConfig, projectAppsConfigSchema } from "../services/github-project-apps.js";
import { projectAppSandbox } from "./helpers/project-app-sandbox.js";

describe("controller GitHub project App broker", () => {
  let sandbox: Awaited<ReturnType<typeof projectAppSandbox>>;
  beforeEach(async () => { sandbox = await projectAppSandbox(); });
  afterEach(async () => { vi.unstubAllEnvs(); await sandbox.cleanup(); });
  it("creates once, enrolls only fixed installations, survives restart, and delivers distinct scoped identities", async () => {
    const projectId = randomUUID();
    const result = await sandbox.broker.provision(projectId, async () => {});
    expect(result.fullName).toBe(`Hdom/paperclip-${projectId}`);
    expect(sandbox.requests.filter(r => r.method === "PUT").map(r => r.url)).toEqual([`/user/installations/102/repositories/${result.repositoryId}`, `/user/installations/103/repositories/${result.repositoryId}`]);
    const restarted = createProjectAppBroker(sandbox.config, { fetch: sandbox.fetchImpl });
    await restarted.provision(projectId, async () => {});
    expect(sandbox.requests.filter(r => r.url === "/user/repos")).toHaveLength(1);
    const implementer = await restarted.workerCredential("implementer", projectId, async () => {});
    const reviewer = await restarted.workerCredential("reviewer", projectId, async () => {});
    expect(implementer.login).not.toBe(reviewer.login);
    expect(sandbox.tokens.get(reviewer.token)).toEqual({ role: "reviewer", repositoryId: result.repositoryId });
    expect(await readFile(path.join(sandbox.directory, `${projectId}.json`), "utf8")).not.toMatch(/synthetic-|PRIVATE KEY/);
    expect([...sandbox.tokens.values()].some(t => t.role === "coordinator")).toBe(false);
  });
  it.each(["extraPermission", "allRepositories"] as const)("rejects installation scope drift (%s) before creating", async fault => {
    sandbox.faults[fault] = true;
    await expect(sandbox.broker.provision(randomUUID(), async () => {})).rejects.toThrow("approved owner");
    expect(sandbox.repositories.size).toBe(0);
  });
  it("rejects unrelated selected repositories before creation or worker token export", async () => {
    sandbox.enrolled.get("implementer")!.add(777);
    await expect(sandbox.broker.provision(randomUUID(), async () => {})).rejects.toThrow("unrelated repository");
    expect(sandbox.repositories.size).toBe(0);
    sandbox.enrolled.get("implementer")!.clear();
    const projectId = randomUUID(); await sandbox.broker.provision(projectId, async () => {});
    sandbox.enrolled.get("reviewer")!.add(778);
    await expect(sandbox.broker.workerCredential("reviewer", projectId, async () => {})).rejects.toThrow("unrelated repository");
    expect([...sandbox.tokens.values()].some(t => t.role === "reviewer")).toBe(false);
  });
  it("reports enrollment admin rejection without widening access or leaking the provider body", async () => {
    sandbox.faults.adminRefused = true;
    const projectId = randomUUID();
    await expect(sandbox.broker.provision(projectId, async () => {})).rejects.toThrow("HTTP 403; permissions were not expanded");
    expect(sandbox.requests.filter(r => r.method === "PUT")).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(sandbox.directory, `${projectId}.json`), "utf8")).phase).toBe("created");
    expect([...sandbox.tokens.values()].some(t => t.role === "coordinator")).toBe(false);
    sandbox.faults.adminRefused = false;
    await sandbox.broker.provision(projectId, async () => {});
    expect(sandbox.repositories.size).toBe(1);
  });
  it("retains uncertain creation and never blindly repeats POST /user/repos", async () => {
    sandbox.faults.createDrop = true;
    const projectId = randomUUID();
    await expect(sandbox.broker.provision(projectId, async () => {})).rejects.toThrow("uncertain");
    await expect(sandbox.broker.provision(projectId, async () => {})).rejects.toThrow("uncertain");
    expect(sandbox.requests.filter(r => r.url === "/user/repos")).toHaveLength(1);
  });
  it("serializes concurrent provisioning and denies stopped authority before provider mutation", async () => {
    const projectId = randomUUID(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let authorized!: () => void; const entered = new Promise<void>(resolve => { authorized = resolve; });
    const first = sandbox.broker.provision(projectId, async () => { authorized(); await gate; throw new Error("stopped"); });
    await entered;
    await expect(sandbox.broker.provision(projectId, async () => {})).rejects.toThrow("already running");
    release(); await expect(first).rejects.toThrow("stopped");
    expect(sandbox.requests).toHaveLength(0);
  });
  it.each(["driftScope", "longExpiry"] as const)("revokes and withholds unexpected token response (%s)", async fault => {
    const projectId = randomUUID(); await sandbox.broker.provision(projectId, async () => {});
    sandbox.faults[fault] = true;
    await expect(sandbox.broker.workerCredential("reviewer", projectId, async () => {})).rejects.toThrow("unexpected token scope");
    expect([...sandbox.tokens.values()].some(t => t.role === "reviewer")).toBe(false);
  });
  it("withholds and revokes a token when authority changes during issuance", async () => {
    const projectId = randomUUID(); await sandbox.broker.provision(projectId, async () => {}); let checks = 0;
    await expect(sandbox.broker.workerCredential("implementer", projectId, async () => { if (++checks > 1) throw new Error("stopped"); })).rejects.toThrow("stopped");
    expect([...sandbox.tokens.values()].some(t => t.role === "implementer")).toBe(false);
  });
  it("checks repository identity and refuses another project or moved/public repository", async () => {
    const projectId = randomUUID(); const result = await sandbox.broker.provision(projectId, async () => {});
    await expect(sandbox.broker.workerCredential("reviewer", randomUUID(), async () => {})).rejects.toThrow("provision");
    sandbox.repositories.get(result.repositoryId).private = false;
    await expect(sandbox.broker.workerCredential("reviewer", projectId, async () => {})).rejects.toThrow("private project binding");
  });
  it("requires protected Linux configuration and distinct app identities", async () => {
    vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", sandbox.configPath);
    expect((await loadProjectAppsConfig())?.owner).toBe("Hdom");
    await chmod(sandbox.configPath, 0o644);
    await expect(loadProjectAppsConfig()).rejects.toThrow("unprotected");
    const invalid = structuredClone(sandbox.config); invalid.apps.reviewer.appId = invalid.apps.implementer.appId;
    expect(projectAppsConfigSchema.safeParse(invalid).success).toBe(false);
  });
  it("rejects symlinked private keys and unsafe storage permissions", async () => {
    const original = sandbox.config.apps.reviewer.privateKeyPath;
    sandbox.config.apps.reviewer.privateKeyPath = path.join(sandbox.directory, "key-link.pem");
    await symlink(original, sandbox.config.apps.reviewer.privateKeyPath);
    await expect(sandbox.broker.provision(randomUUID(), async () => {})).rejects.toThrow("private key");
    await chmod(sandbox.directory, 0o755);
    await expect(sandbox.broker.provision(randomUUID(), async () => {})).rejects.toThrow("0700");
  });
  it("aborts a slow real HTTP dependency without blocking unrelated requests", async () => {
    sandbox.faults.slow = true;
    const broker = createProjectAppBroker(sandbox.config, { fetch: sandbox.fetchImpl, timeoutMs: 25 });
    await expect(broker.provision(randomUUID(), async () => {})).rejects.toThrow("timed out");
    sandbox.faults.slow = false;
    await expect(sandbox.broker.provision(randomUUID(), async () => {})).resolves.toHaveProperty("status", "ready");
  });
  it("refuses redirects rather than forwarding authorization to another host", async () => {
    let leaked = false;
    const trap = createServer((_req, res) => { leaked = true; res.end("bad"); });
    await new Promise<void>(resolve => trap.listen(0, "127.0.0.1", resolve));
    sandbox.faults.redirect = `http://127.0.0.1:${(trap.address() as { port: number }).port}/leak`;
    try { await expect(sandbox.broker.provision(randomUUID(), async () => {})).rejects.toThrow("request failed"); expect(leaked).toBe(false); }
    finally { await new Promise<void>(resolve => trap.close(() => resolve())); }
  });
});
