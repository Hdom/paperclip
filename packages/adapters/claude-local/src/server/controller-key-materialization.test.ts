import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareClaudeConfigSeed } from "./claude-config.js";
import { prepareClaudePromptBundle } from "./prompt-cache.js";
import { createControllerSourceSnapshot } from "@paperclipai/adapter-utils/controller-source-materialization";
let root: string, source: string, home: string, keys: string, snapshots: string;
beforeEach(async () => {
 root = await mkdtemp(path.join(os.tmpdir(), "protected-adapter-assets-")); source = path.join(root, "source"); home = path.join(source, "home"); keys = path.join(root, "keys"); snapshots = path.join(root, "snapshots");
 await mkdir(home, { recursive: true }); await mkdir(keys); await writeFile(path.join(keys, "synthetic.pem"), "synthetic-protected-sentinel", { mode: 0o600 });
 vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", "1"); vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", "");
 vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS", JSON.stringify([source, snapshots, path.join(root, "controller-data", "instances", "default", "companies", "company", "claude-prompt-cache")])); vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS", JSON.stringify([source]));
 vi.stubEnv("PAPERCLIP_CONTROLLER_PROTECTED_PATHS", JSON.stringify([keys])); vi.stubEnv("PAPERCLIP_CONTROLLER_ASSET_SNAPSHOT_ROOT", snapshots); vi.stubEnv("PAPERCLIP_HOME", path.join(root, "controller-data")); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const children = async () => await readdir(snapshots).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
describe("protected Claude asset materialization", () => {
 it.each(["settings.json", "CLAUDE.md"])("refuses a protected Claude %s seed alias", async entry => { await symlink(path.join(keys, "synthetic.pem"), path.join(home, entry)); await expect(prepareClaudeConfigSeed({ ...process.env, CLAUDE_CONFIG_DIR: home }, vi.fn(), "company")).rejects.toThrow(/signing-key protection/); });
 it("refuses protected Claude skill roots before hashing or cache materialization", async () => { await expect(prepareClaudePromptBundle({ companyId: "company", skills: [{ key: "unsafe", runtimeName: "unsafe", source: keys }], instructionsContents: null, onLog: vi.fn() } as never)).rejects.toThrow(/signing-key protection/); });
 it("retains normal Claude seeds and turns approved prompt links into a flat snapshot", async () => {
  await writeFile(path.join(home, "settings.json"), '{"permissions":{"defaultMode":"bypassPermissions"},"hooks":{"test":[]}}'); await writeFile(path.join(home, "CLAUDE.md"), "approved instructions");
  const seed = await prepareClaudeConfigSeed({ ...process.env, CLAUDE_CONFIG_DIR: home }, vi.fn(), "company"); expect(await readFile(path.join(seed, "CLAUDE.md"), "utf8")).toBe("approved instructions"); expect(await readFile(path.join(seed, "settings.json"), "utf8")).not.toContain("bypassPermissions");
  const skill = path.join(source, "skill"); await mkdir(skill); await writeFile(path.join(skill, "SKILL.md"), "approved skill");
  const bundle = await prepareClaudePromptBundle({ companyId: "company", skills: [{ key: "safe", runtimeName: "safe", source: skill }], instructionsContents: "instructions", onLog: vi.fn() } as never);
  const flat = await createControllerSourceSnapshot(bundle.addDir); expect((await lstat(path.join(flat.directory, ".claude/skills/safe"))).isSymbolicLink()).toBe(false); expect(await readFile(path.join(flat.directory, ".claude/skills/safe/SKILL.md"), "utf8")).toBe("approved skill"); await flat.cleanup();
 });

});
