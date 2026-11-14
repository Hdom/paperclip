import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertControllerSourcePathAllowed, assertControllerGitWorkspaceSafe } from "./controller-source-protection.js";
const exec = promisify(execFile);
let root: string, source: string, secret: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "controller-source-policy-")); source = path.join(root, "sources"); secret = path.join(root, "protected"); await mkdir(source); await mkdir(secret); vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", "1"); vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", ""); vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS", JSON.stringify([source])); vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS", JSON.stringify([source])); vi.stubEnv("PAPERCLIP_CONTROLLER_PROTECTED_PATHS", JSON.stringify([secret])); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
describe("controller source policy", () => {
 it("accepts native signing references without exposing fixed legacy key storage", async () => {
  const configFile = path.join(secret, "apps.json");
  await writeFile(configFile, JSON.stringify({ stateDirectory: path.join(secret, "ledger"), apps: Object.fromEntries(["coordinator", "implementer", "reviewer"].map((role, i) => [role, { signingKeySecret: { secretId: `00000000-0000-4000-8000-00000000000${i}`, version: 1 } }])) }));
  vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", configFile);
  await expect(assertControllerSourcePathAllowed(source)).resolves.toBeUndefined();
  await expect(assertControllerSourcePathAllowed(path.join(secret, "keys/old.pem"))).rejects.toThrow();
 });
 it("refuses native master-key and database/backup allowlist overlap", async () => {
  vi.stubEnv("PAPERCLIP_HOME", source);
  await expect(assertControllerSourcePathAllowed(source)).rejects.toThrow();
 });
 it("refuses an explicit native master-key file inside a source root", async () => {
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(source, "master.key"));
  await expect(assertControllerSourcePathAllowed(source)).rejects.toThrow();
 });

 it("allows approved source and missing descendants", async () => { await expect(assertControllerSourcePathAllowed(source)).resolves.toBeUndefined(); await expect(assertControllerSourcePathAllowed(path.join(source, "new/file"))).resolves.toBeUndefined(); });
 it("rejects secrets and ancestor copies", async () => { await expect(assertControllerSourcePathAllowed(secret)).rejects.toThrow(); await expect(assertControllerSourcePathAllowed(root)).rejects.toThrow(); });
 it("rejects an approved root that contains protected storage", async () => { vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS", JSON.stringify([root])); await expect(assertControllerSourcePathAllowed(source)).rejects.toThrow(); });
 it("rejects symlink aliases into protected storage", async () => { const alias = path.join(source, "alias"); await symlink(secret, alias); await expect(assertControllerSourcePathAllowed(alias)).rejects.toThrow(); });
 it("separates read-only artifact roots from restore targets", async () => { vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS", JSON.stringify([path.join(source, "writable")])); await expect(assertControllerSourcePathAllowed(source)).resolves.toBeUndefined(); await expect(assertControllerSourcePathAllowed(source, true)).rejects.toThrow(); });
 it("preserves unconfigured behavior", async () => { vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", ""); await expect(assertControllerSourcePathAllowed(secret)).resolves.toBeUndefined(); });
 it("allows ordinary Git metadata and non-Git sources", async () => { await expect(assertControllerGitWorkspaceSafe(source)).resolves.toBeUndefined(); await exec("git", ["init", source]); await expect(assertControllerGitWorkspaceSafe(source)).resolves.toBeUndefined(); });
 it("refuses fsmonitor without executing it, including from a subdirectory", async () => { await exec("git", ["init", source]); const marker = path.join(root, "executed"); await exec("git", ["-C", source, "config", "core.fsmonitor", `touch ${marker}`]); const sub = path.join(source, "sub"); await mkdir(sub); await expect(assertControllerGitWorkspaceSafe(sub)).rejects.toThrow(); await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" }); });
 it("refuses executable hooks", async () => { await exec("git", ["init", source]); const hook = path.join(source, ".git/hooks/pre-commit"); await writeFile(hook, "#!/bin/sh\nexit 0\n"); await chmod(hook, 0o700); await expect(assertControllerGitWorkspaceSafe(source)).rejects.toThrow(); });
 it("refuses includes and symlinked configuration", async () => { await exec("git", ["init", source]); await exec("git", ["-C", source, "config", "include.path", path.join(secret, "config")]); await expect(assertControllerGitWorkspaceSafe(source)).rejects.toThrow(); await rm(path.join(source, ".git/config")); await writeFile(path.join(secret, "config"), "[core]\n bare = false\n"); await symlink(path.join(secret, "config"), path.join(source, ".git/config")); await expect(assertControllerGitWorkspaceSafe(source)).rejects.toThrow(); });
});
