import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

export function controllerExecutionProtected(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS || env.PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG);
}
const refused = () => new Error("Controller signing-key protection refused an unapproved source path or unsafe Git metadata");
function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
async function canonical(file: string): Promise<string> {
  if (!path.isAbsolute(file)) throw refused();
  try { return await realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw refused();
    const parent = path.dirname(file);
    if (parent === file) throw refused();
    return path.join(await canonical(parent), path.basename(file));
  }
}
function pathList(name: string, required = false): string[] {
  const raw = process.env[name];
  if (!raw && !required) return [];
  try {
    if (!raw || raw.length > 8192) throw refused();
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.length || value.length > 32 || value.some(item => typeof item !== "string" || !path.isAbsolute(item))) throw refused();
    return value;
  } catch { throw refused(); }
}
async function boundedText(file: string, maximum: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw refused();
    const bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximum) throw refused();
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

/** Applies to persisted paths and aliases too; a route-only check is insufficient. */
export async function assertControllerSourcePathAllowed(file: string, writing = false): Promise<void> {
  if (!controllerExecutionProtected()) return;
  try {
    const protectedPaths = ["/etc/paperclip/github-project-apps", "/var/lib/paperclip/github-project-apps", ...pathList("PAPERCLIP_CONTROLLER_PROTECTED_PATHS")];
    const configFile = process.env.PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG;
    if (configFile) {
      protectedPaths.push(path.dirname(configFile));
      const config = JSON.parse(await boundedText(configFile, 65536));
      if (typeof config.stateDirectory !== "string" || !config.apps || typeof config.apps !== "object") throw refused();
      protectedPaths.push(config.stateDirectory);
      for (const role of ["coordinator", "implementer", "reviewer"]) {
        if (typeof config.apps[role]?.privateKeyPath !== "string") throw refused();
        protectedPaths.push(path.dirname(config.apps[role].privateKeyPath));
      }
    }
    const secrets = await Promise.all(protectedPaths.map(canonical));
    const roots = await Promise.all(pathList(writing ? "PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS" : "PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS", true).map(canonical));
    if (roots.some(root => secrets.some(secret => inside(root, secret) || inside(secret, root)))) throw refused();
    const source = await canonical(file);
    if (!roots.some(root => inside(root, source)) || secrets.some(secret => inside(secret, source) || inside(source, secret))) throw refused();
  } catch { throw refused(); }
}

/** Controller Git must not execute commands from agent-introduced configuration. */
export async function assertControllerGitWorkspaceSafe(cwd: string): Promise<void> {
  if (!controllerExecutionProtected()) return;
  await assertControllerSourcePathAllowed(cwd);
  try {
    let repositoryRoot = await canonical(cwd);
    let gitDir = "";
    let marker;
    while (true) {
      gitDir = path.join(repositoryRoot, ".git");
      try { marker = await lstat(gitDir); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try {
        await lstat(path.join(repositoryRoot, "HEAD")); await lstat(path.join(repositoryRoot, "objects"));
        gitDir = repositoryRoot; marker = await lstat(repositoryRoot); break;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const parent = path.dirname(repositoryRoot);
      if (parent === repositoryRoot) return;
      repositoryRoot = parent;
    }
    await assertControllerSourcePathAllowed(repositoryRoot);
    if (marker.isSymbolicLink()) throw refused();
    if (marker.isFile()) {
      const pointer = /^gitdir: ([^\r\n]+)\s*$/.exec(await boundedText(gitDir, 4096));
      if (!pointer) throw refused();
      gitDir = path.resolve(repositoryRoot, pointer[1]!);
    }
    await assertControllerSourcePathAllowed(gitDir);
    const directories = [gitDir];
    try { directories.push(path.resolve(gitDir, (await boundedText(path.join(gitDir, "commondir"), 4096)).trim())); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
    for (const directory of new Set(directories)) {
      await assertControllerSourcePathAllowed(directory);
      for (const name of ["config", "config.worktree"]) {
        const file = path.join(directory, name);
        try { await boundedText(file, 65536); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        // --file + a non-repository cwd parses data only. It does not run Git
        // against the untrusted repository, and --no-includes rejects aliases.
        const { stdout } = await promisify(execFile)("git", ["-C", "/", "config", "--file", file, "--no-includes", "--null", "--list"],
          { env, timeout: 5000, maxBuffer: 131072, encoding: "utf8" });
        for (const entry of stdout.split("\0").filter(Boolean)) {
          const separator = entry.indexOf("\n");
          const key = entry.slice(0, separator).toLowerCase(), value = entry.slice(separator + 1);
          if (separator < 0) throw refused();
          if (/^user\.(name|email)$/.test(key) || /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|protectntfs|protecthfs)$/.test(key) ||
              /^extensions\.(objectformat|refstorage|worktreeconfig)$/.test(key) || /^branch\..+\.(remote|merge)$/.test(key) || /^remote\..+\.fetch$/.test(key)) continue;
          if (key === "core.hookspath" && value === "/dev/null") continue;
          if (key === "core.fsmonitor" && ["false", "0"].includes(value)) continue;
          if (key === "core.worktree") { await assertControllerSourcePathAllowed(path.resolve(directory, value)); continue; }
          if (/^remote\..+\.url$/.test(key)) {
            if (/^git@github\.com:[A-Za-z0-9_.\/-]+$/.test(value)) continue;
            const url = new URL(value);
            if (url.protocol === "https:" && !url.username && !url.password) continue;
          }
          throw refused();
        }
      }
      const hookDir = path.join(directory, "hooks");
      try {
        await assertControllerSourcePathAllowed(hookDir);
        const entries = await readdir(hookDir);
        if (entries.length > 100) throw refused();
        for (const name of entries.filter(name => !name.endsWith(".sample"))) {
          const info = await lstat(path.join(hookDir, name));
          if (info.isSymbolicLink() || (info.mode & 0o111) !== 0) throw refused();
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } catch { throw refused(); }
}
