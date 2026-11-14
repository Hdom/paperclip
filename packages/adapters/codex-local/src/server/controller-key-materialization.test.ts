import { buildSshEnvLabFixtureConfig, getSshEnvLabSupport, startSshEnvLabFixture, stopSshEnvLabFixture } from "@paperclipai/adapter-utils/ssh";
import { prepareRemoteManagedRuntime } from "@paperclipai/adapter-utils/remote-managed-runtime";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageCodexHomeForSync } from "./codex-home.js";
let root: string, source: string, home: string, keys: string, snapshots: string;
beforeEach(async () => {
 root = await mkdtemp(path.join(os.tmpdir(), "protected-adapter-assets-")); source = path.join(root, "source"); home = path.join(source, "home"); keys = path.join(root, "keys"); snapshots = path.join(root, "snapshots");
 await mkdir(home, { recursive: true }); await mkdir(keys); await writeFile(path.join(keys, "synthetic.pem"), "synthetic-protected-sentinel", { mode: 0o600 });
 vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", "1"); vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", "");
 vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS", JSON.stringify([source, snapshots])); vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS", JSON.stringify([source]));
 vi.stubEnv("PAPERCLIP_CONTROLLER_PROTECTED_PATHS", JSON.stringify([keys])); vi.stubEnv("PAPERCLIP_CONTROLLER_ASSET_SNAPSHOT_ROOT", snapshots); vi.stubEnv("PAPERCLIP_HOME", path.join(root, "controller-data")); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const children = async () => await readdir(snapshots).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
describe("pre-transfer adapter signing-key safeguards", () => {
 it.each(["auth.json", "config.toml"])("refuses a protected %s alias before Codex materialization", async entry => { await symlink(path.join(keys, "synthetic.pem"), path.join(home, entry)); await expect(stageCodexHomeForSync(home)).rejects.toThrow(/signing-key protection/); expect(await children()).toEqual([]); });
 it("refuses a top-level Codex skill link into protected storage", async () => { await mkdir(path.join(home, "skills")); await symlink(keys, path.join(home, "skills/unsafe")); await expect(stageCodexHomeForSync(home)).rejects.toThrow(/signing-key protection/); expect(await children()).toEqual([]); });
 it("retains approved shared Codex credential and skill links as regular snapshot files", async () => {
  await writeFile(path.join(source, "shared-auth.json"), '{"synthetic":"approved"}'); await symlink(path.join(source, "shared-auth.json"), path.join(home, "auth.json"));
  const skill = path.join(source, "skill-store/topic"); await mkdir(skill, { recursive: true }); await writeFile(path.join(skill, "SKILL.md"), "approved skill"); await mkdir(path.join(home, "skills")); await symlink(skill, path.join(home, "skills/topic"));
  const staged = await stageCodexHomeForSync(home); expect(await readFile(path.join(staged, "auth.json"), "utf8")).toContain("approved"); expect((await lstat(path.join(staged, "auth.json"))).isSymbolicLink()).toBe(false); expect(await readFile(path.join(staged, "skills/topic/SKILL.md"), "utf8")).toBe("approved skill");
 });
 it("bounds aggregate bytes during the first Codex staging pass", async () => {
   await mkdir(path.join(home, "skills/large"), { recursive: true });
   for (let i = 0; i < 5; i++) { const file = path.join(home, `skills/large/${i}.bin`); await writeFile(file, ""); await truncate(file, 64 * 1024 * 1024); }
   await expect(stageCodexHomeForSync(home)).rejects.toThrow(/oversized Codex asset/); expect(await children()).toEqual([]);
 });
 it("bounds the number of Codex skill entries before materializing the oversized directory", async () => {
   const many = path.join(home, "skills/many"); await mkdir(many, { recursive: true });
   for (let batch = 0; batch < 101; batch++) await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(path.join(many, `${batch}-${index}`), "")));
   await expect(stageCodexHomeForSync(home)).rejects.toThrow(/oversized Codex asset/); expect(await children()).toEqual([]);
 });
 it("bounds Codex skill recursion depth before copying deeper files", async () => {
   const deep = path.join(home, "skills", ...Array.from({ length: 66 }, () => "deep")); await mkdir(deep, { recursive: true }); await writeFile(path.join(deep, "leaf"), "approved");
   await expect(stageCodexHomeForSync(home)).rejects.toThrow(/oversized Codex asset/); expect(await children()).toEqual([]);
 });
 it("uploads legacy Codex and Claude assets over real isolated SSH without dereferenced transport", async () => {
   const support = await getSshEnvLabSupport(); expect(support.supported, support.reason ?? undefined).toBe(true);
   const fixture = await startSshEnvLabFixture({ statePath: path.join(root, "ssh/state.json") });
   try {
     const config = await buildSshEnvLabFixtureConfig(fixture);
     const workspace = path.join(source, "workspace"); await mkdir(workspace); await writeFile(path.join(workspace, "work.txt"), "approved work");
     await writeFile(path.join(source, "shared-auth.json"), '{"synthetic":"approved"}'); await symlink(path.join(source, "shared-auth.json"), path.join(home, "auth.json"));
     const codex = await stageCodexHomeForSync(home);
     const claude = path.join(source, "claude"); await mkdir(claude); await symlink(path.join(source, "shared-auth.json"), path.join(claude, "settings.json"));
     const prepared = await prepareRemoteManagedRuntime({ spec: { ...config, remoteCwd: fixture.workspaceDir }, runId: "synthetic-assets", adapterKey: "codex", workspaceLocalDir: workspace, workspaceFileMode: "all", assets: [{ key: "home", localDir: codex, followSymlinks: true }, { key: "config-seed", localDir: claude, followSymlinks: true }] });
     expect(await readFile(path.join(prepared.assetDirs.home, "auth.json"), "utf8")).toContain("approved");
     expect((await lstat(path.join(prepared.assetDirs["config-seed"], "settings.json"))).isSymbolicLink()).toBe(false);
     expect(await readFile(path.join(prepared.assetDirs["config-seed"], "settings.json"), "utf8")).toContain("approved");
     expect(await children()).toEqual([path.basename(codex)]); await prepared.restoreWorkspace();
   } finally { await stopSshEnvLabFixture(fixture); }
 }, 30_000);

});
