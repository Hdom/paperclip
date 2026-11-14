import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createControllerSourceSnapshot, readControllerSourceFile } from "./controller-source-materialization.js";
import { createTarballFromDirectory } from "./sandbox-managed-runtime.js";
vi.mock("node:fs/promises", async importOriginal => {
 const actual = await importOriginal<typeof import("node:fs/promises")>();
 return { ...actual, open: vi.fn(actual.open) };
});
const exec = promisify(execFile);
let root: string, sources: string, snapshots: string, keys: string;
beforeEach(async () => {
 root = await mkdtemp(path.join(os.tmpdir(), "protected-materialization-"));
 sources = path.join(root, "source"); snapshots = path.join(root, "snapshots"); keys = path.join(root, "keys");
 await mkdir(sources); await mkdir(keys); await writeFile(path.join(keys, "synthetic.pem"), "synthetic-protected-sentinel", { mode: 0o600 });
 vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", "1"); vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", "");
 vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS", JSON.stringify([sources, snapshots]));
 vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS", JSON.stringify([sources]));
 vi.stubEnv("PAPERCLIP_CONTROLLER_PROTECTED_PATHS", JSON.stringify([keys])); vi.stubEnv("PAPERCLIP_CONTROLLER_ASSET_SNAPSHOT_ROOT", snapshots);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const stagingEntries = async () => await readdir(snapshots).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
describe("guarded controller asset snapshots", () => {
 it.each([["codex", "auth.json"], ["claude", ".credentials.json"]])("stages approved %s auth and skills with native controller-secret configuration", async (name, authName) => {
  const configFile = path.join(keys, "apps.json");
  await writeFile(configFile, JSON.stringify({ stateDirectory: path.join(keys, "ledger"), apps: Object.fromEntries(["coordinator", "implementer", "reviewer"].map((role, i) => [role, { signingKeySecret: { secretId: `00000000-0000-4000-8000-00000000000${i}`, version: 1 } }])) }));
  vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", configFile);
  const home = path.join(sources, name); await mkdir(home); await mkdir(path.join(home, "skills"));
  await writeFile(path.join(home, authName), "synthetic-approved-auth");
  await writeFile(path.join(home, "skills/SKILL.md"), "synthetic-approved-skill");
  const snapshot = await createControllerSourceSnapshot(home);
  expect(await readFile(path.join(snapshot.directory, authName), "utf8")).toBe("synthetic-approved-auth");
  expect(await readFile(path.join(snapshot.directory, "skills/SKILL.md"), "utf8")).toBe("synthetic-approved-skill");
  await snapshot.cleanup();
  await expect(createControllerSourceSnapshot(keys)).rejects.toThrow(/signing-key protection/);
 });

 it("resolves approved credential and skill aliases into private regular files", async () => {
  await mkdir(path.join(sources, "home")); await mkdir(path.join(sources, "store"));
  await writeFile(path.join(sources, "auth.json"), '{"synthetic":"approved"}');
  await symlink(path.join(sources, "auth.json"), path.join(sources, "home/auth.json"));
  await writeFile(path.join(sources, "store/run.sh"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(sources, "store/run.sh"), 0o755);
  await symlink(path.join(sources, "store"), path.join(sources, "home/skill"));
  const snapshot = await createControllerSourceSnapshot(path.join(sources, "home"));
  expect(await readFile(path.join(snapshot.directory, "auth.json"), "utf8")).toContain("approved");
  expect((await lstat(path.join(snapshot.directory, "auth.json"))).isSymbolicLink()).toBe(false);
  expect((await lstat(path.join(snapshot.directory, "skill/run.sh"))).mode & 0o777).toBe(0o700);
  expect((await lstat(path.join(snapshot.directory, "auth.json"))).mode & 0o777).toBe(0o600);
  await snapshot.cleanup(); expect(await stagingEntries()).toEqual([]);
 });
 it.each(["auth.json", "skills/bad/synthetic.pem"])("refuses a protected alias at %s before upload and removes partial snapshots", async relative => {
  const target = path.join(sources, relative); await mkdir(path.dirname(target), { recursive: true }); await symlink(path.join(keys, "synthetic.pem"), target);
  await expect(createControllerSourceSnapshot(sources)).rejects.toThrow(/signing-key protection/); expect(await stagingEntries()).toEqual([]);
 });
 it("refuses an entire protected directory alias", async () => { await symlink(keys, path.join(sources, "skill")); await expect(createControllerSourceSnapshot(sources)).rejects.toThrow(/signing-key protection/); expect(await stagingEntries()).toEqual([]); });
 it("refuses a protected hard link before reading its bytes", async () => { const alias = path.join(sources, "alias"); await link(path.join(keys, "synthetic.pem"), alias); await expect(readControllerSourceFile(alias)).rejects.toThrow(/signing-key protection/); });
 it("checks the opened descriptor before reading when an alias changes after path validation", async () => {
  const ordinary = path.join(sources, "ordinary"); await writeFile(ordinary, "approved");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const replaced = await actual.open(path.join(keys, "synthetic.pem"), "r"); const read = vi.spyOn(replaced, "read");
  vi.mocked(open).mockResolvedValueOnce(replaced);
  await expect(readControllerSourceFile(ordinary)).rejects.toThrow(/signing-key protection/); expect(read).not.toHaveBeenCalled();
 });
 it("rejects cycles and removes partial snapshots", async () => { await symlink(sources, path.join(sources, "loop")); await expect(createControllerSourceSnapshot(sources)).rejects.toThrow(); expect(await stagingEntries()).toEqual([]); });
 it("refuses snapshots inside agent restore roots", async () => { vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS", JSON.stringify([root])); await expect(createControllerSourceSnapshot(sources)).rejects.toThrow(); });
 it("bounds sparse source files before allocating or copying them", async () => { const large = path.join(sources, "large"); await writeFile(large, ""); await truncate(large, 64 * 1024 * 1024 + 1); await expect(createControllerSourceSnapshot(sources)).rejects.toThrow(); expect(await stagingEntries()).toEqual([]); });
 it("creates a normal tar of a checked flat snapshot for sandbox assets", async () => {
  const home = path.join(sources, "home"), original = path.join(sources, "credential"); await mkdir(home); await writeFile(original, "approved-synthetic"); await symlink(original, path.join(home, "auth.json"));
  const archive = path.join(root, "asset.tar"); await createTarballFromDirectory({ localDir: home, archivePath: archive, followSymlinks: true });
  const listing = (await exec("tar", ["-tvf", archive])).stdout; expect(listing).not.toMatch(/^l/m);
  expect((await exec("tar", ["-xOf", archive, "auth.json"])).stdout).toBe("approved-synthetic"); expect(await stagingEntries()).toEqual([]);
 });
 it("refuses protected sandbox assets before creating an archive", async () => { await symlink(keys, path.join(sources, "skill")); const archive = path.join(root, "asset.tar"); await expect(createTarballFromDirectory({ localDir: sources, archivePath: archive, followSymlinks: true })).rejects.toThrow(); await expect(lstat(archive)).rejects.toMatchObject({ code: "ENOENT" }); });
 it("preserves unprotected reads", async () => { vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", ""); expect(await readControllerSourceFile(path.join(keys, "synthetic.pem"), "utf8")).toContain("synthetic-protected"); });
});
