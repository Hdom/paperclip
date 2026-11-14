import { runWorkspaceJobForControl } from "../services/workspace-runtime.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { mkdtemp, mkdir, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageRemoteRunnerDirectory, stageRemoteRunnerFile, syncRemoteRunnerDirectoryOut } from "../services/native-runtime/native-session-executor.js";
let root: string, allowed: string, secret: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "native-staging-policy-")); allowed = path.join(root, "sources"); secret = path.join(root, "protected"); await mkdir(allowed); await mkdir(secret); vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", "1"); vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", ""); vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS", JSON.stringify([allowed])); vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS", JSON.stringify([allowed])); vi.stubEnv("PAPERCLIP_CONTROLLER_PROTECTED_PATHS", JSON.stringify([secret])); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
describe("native signing-key source protection", () => {
 it.each([true, false])("blocks native protected file and directory staging before transport (syncIn %s)", async supportsSync => {
  const execute = vi.fn(), syncIn = vi.fn(), runner = { execute, ...(supportsSync ? { syncIn } : {}) } as never;
  const target = { kind: "remote", transport: "ssh", remoteCwd: "/worker" } as never;
  await expect(stageRemoteRunnerFile({ target, runner, sourcePath: path.join(secret, "key.pem"), targetPath: "/worker/key", mode: 0o600 })).rejects.toThrow(/signing-key protection/);
  await expect(stageRemoteRunnerDirectory({ target, runner, sourcePath: root, targetPath: "/worker/all", mode: 0o700 })).rejects.toThrow(/signing-key protection/);
  expect(execute).not.toHaveBeenCalled(); expect(syncIn).not.toHaveBeenCalled();
 });
 it("blocks protected restore destination before remote lookup", async () => { const execute = vi.fn(); await expect(syncRemoteRunnerDirectoryOut({ runner: { execute } as never, sourcePath: "/worker", targetPath: secret, mode: 0o700 })).rejects.toThrow(/signing-key protection/); expect(execute).not.toHaveBeenCalled(); });
 it("rejects a dereferenced nested key alias before native provider dispatch", async () => {
   await symlink(secret, path.join(allowed, "nested-key-alias"));
   const syncIn = vi.fn();
   const runtime = environmentRuntimeService({} as never, { drivers: [{ driver: "plugin", syncIn }] as never });
   await expect(runtime.syncIn({ environment: { driver: "plugin" }, lease: { metadata: { driver: "plugin" } }, operations: [{ operationId: "synthetic", files: [{ sourcePath: allowed, targetPath: "/worker", kind: "directory", followSymlinks: true }] }] } as never)).rejects.toThrow(/forbids dereferenced/);
   expect(syncIn).not.toHaveBeenCalled();
 });

 it.each([false, true])("refuses recorded and unrecorded controller jobs (recorder %s)", async recorded => {
   const marker = path.join(allowed, "host-process-ran");
   const recorder = recorded ? { recordOperation: async (input: { run: () => Promise<unknown> }) => await input.run() } : undefined;
   await expect(runWorkspaceJobForControl({ actor: { id: "test", name: "test", companyId: "test" }, issue: null,
     workspace: { cwd: allowed, baseCwd: allowed, source: "agent_home" }, command: { command: `touch ${marker}` }, recorder } as never)).rejects.toThrow(/signing-key protection/);
   await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
 });

});
