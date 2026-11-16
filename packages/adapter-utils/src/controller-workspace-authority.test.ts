import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withControllerWorkspaceAuthority, withControllerWorkspaceOperation } from "./controller-workspace-authority.js";
import { assertControllerSourcePathAllowed } from "./controller-source-protection.js";
import { createControllerSourceSnapshot } from "./controller-source-materialization.js";

let root: string, attempt: string, snapshots: string, keys: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "scoped-native-workspace-"));
  attempt = path.join(root, "instances/default/isolated-workspace-attempts/company/issue/run");
  snapshots = path.join(root, "snapshots"); keys = path.join(root, "keys");
  await mkdir(attempt, { recursive: true, mode: 0o700 }); await mkdir(keys);
  await writeFile(path.join(attempt, "work.txt"), "work"); await writeFile(path.join(keys, "synthetic.pem"), "synthetic-secret");
  vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", "1"); vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", "");
  vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS", JSON.stringify([snapshots]));
  vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS", JSON.stringify([path.join(root, "legacy")]));
  vi.stubEnv("PAPERCLIP_CONTROLLER_PROTECTED_PATHS", JSON.stringify([keys]));
  vi.stubEnv("PAPERCLIP_CONTROLLER_ASSET_SNAPSHOT_ROOT", snapshots);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const grant = (action: () => Promise<void>, overrides = {}) => withControllerWorkspaceAuthority({
  root: attempt, target: "company/run/lease/generation/endpoint/remote", signal: new AbortController().signal,
  validate: async () => {}, publish: async <T>(action: () => Promise<T>) => action(), ...overrides,
}, action);
const op = <T>(kind: "read" | "publish", action: () => Promise<T>) => withControllerWorkspaceOperation(attempt, "company/run/lease/generation/endpoint/remote", kind, action);

it("reproduces native attempt denial without authority", async () => {
  await expect(assertControllerSourcePathAllowed(attempt)).rejects.toThrow();
  await expect(op("read", async () => {})).rejects.toThrow();
});
it("allows a checked snapshot only inside a read operation; static roots stay unchanged", async () => grant(async () => {
  await expect(assertControllerSourcePathAllowed(attempt)).rejects.toThrow();
  const snapshot = await op("read", () => createControllerSourceSnapshot(attempt));
  try { expect(await readFile(path.join(snapshot.directory, "work.txt"), "utf8")).toBe("work"); }
  finally { await snapshot.cleanup(); }
  await expect(assertControllerSourcePathAllowed(attempt, true)).rejects.toThrow();
}));
it("does not escalate read to write or authorize a sibling", async () => grant(async () => {
  await op("read", async () => {
    await expect(assertControllerSourcePathAllowed(attempt, true)).rejects.toThrow();
    await expect(assertControllerSourcePathAllowed(path.join(attempt, "../other"))).rejects.toThrow();
  });
  await op("publish", () => assertControllerSourcePathAllowed(attempt, true));
}));
it("rejects protected aliases and hardlinks before snapshot bytes are read", async () => grant(async () => {
  await symlink(keys, path.join(attempt, "escape"));
  await expect(op("read", () => createControllerSourceSnapshot(attempt))).rejects.toThrow();
  await rm(path.join(attempt, "escape"));
  await link(path.join(keys, "synthetic.pem"), path.join(attempt, "hardlink"));
  await expect(op("read", () => createControllerSourceSnapshot(attempt))).rejects.toThrow();
}));
it("rejects private-directory permissions and root inode replacement", async () => {
  await chmod(attempt, 0o755); await expect(grant(async () => {})).rejects.toThrow(); await chmod(attempt, 0o700);
  await grant(async () => {
    await rename(attempt, attempt + "-old"); await mkdir(attempt, { mode: 0o700 });
    await expect(op("publish", async () => {})).rejects.toThrow();
  });
});
it("rejects a different target and rechecks generation before each operation", async () => {
  let current = true;
  await grant(async () => {
    await expect(withControllerWorkspaceOperation(attempt, "forged", "read", async () => {})).rejects.toThrow();
    current = false; await expect(op("publish", async () => {})).rejects.toThrow();
  }, { validate: async () => { if (!current) throw new Error("stale generation"); } });
});
it("revokes new reads on abort and all detached authority after completion", async () => {
  const abort = new AbortController(); let release!: () => void; let detached!: Promise<void>;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await grant(async () => {
    abort.abort(); await expect(op("read", async () => {})).rejects.toThrow();
    detached = ready.then(() => op("publish", async () => {}));
  }, { signal: abort.signal });
  const denied = expect(detached).rejects.toThrow(); release(); await denied;
});

it("does not leak authority across concurrent invocation contexts", async () => {
  await grant(async () => {
    await mkdir(snapshots, { mode: 0o700 });
    await Promise.all([op("read", () => assertControllerSourcePathAllowed(attempt)),
      grant(async () => { await expect(op("read", () => assertControllerSourcePathAllowed(attempt))).rejects.toThrow(); }, { root: snapshots })]);
  });
});
