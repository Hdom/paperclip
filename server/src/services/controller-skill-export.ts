import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { HttpError } from "../errors.js";
import { agents, companies, heartbeatRuns, type Db } from "@paperclipai/db";
import { ControllerSourceProtectionError } from "@paperclipai/adapter-utils/controller-source-error";
import { createControllerSourceStagingDirectory, CONTROLLER_ASSET_LIMITS } from "@paperclipai/adapter-utils/controller-source-materialization";
import { withSkillVersionCacheLock } from "./skill-version-cache.js";
import { currentSkillActor, skillAccessService } from "./skill-access.js";
import { skillPackageStore } from "./skill-package-store.js";
import { skillPackageManifest, verifySkillPackageDirectory } from "./skill-package-files.js";
import { skillFileBytes } from "./skill-snapshot.js";

export type ProtectedSkillRunExport = {
  runId: string;
  agentId: string;
  signal?: AbortSignal;
  onCleanup: (cleanup: () => Promise<void>) => void;
};
type Selection = { companyId: string; skillId: string; key: string; versionId: string | null };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const refuse = () => new ControllerSourceProtectionError("Protected skill delivery refused an unauthorized or invalid pinned version");

/** Called only by the skill service inside its authorized selection/cache lock.
 * Registry bytes are data, never a caller-supplied filesystem read capability. */
export function controllerSkillExporter(db: Db, companyId: string, binding: ProtectedSkillRunExport) {
  const packages = skillPackageStore(db);
  let directory: string | undefined;
  let closed = false;
  let active: Promise<void> = Promise.resolve();
  let removal: Promise<void> | undefined;
  let count = 1, bytes = 0;
  const directories = new Set([""]);
  const published = new Map<string, string>();
  const remove = () => removal ??= directory ? fs.rm(directory, { recursive: true, force: true }) : Promise.resolve();
  const cleanup = async () => { closed = true; await active; await remove(); };
  async function authorized(selection: Selection) {
    binding.signal?.throwIfAborted();
    if (closed || selection.companyId !== companyId || ![companyId, binding.agentId, binding.runId, selection.skillId, selection.versionId].every(id => typeof id === "string" && uuid.test(id))) throw refuse();
    const actor = currentSkillActor();
    if (actor?.type !== "agent" || actor.companyId !== companyId || actor.agentId !== binding.agentId || actor.runId !== binding.runId) throw refuse();
    const [run] = await db.select({ status: heartbeatRuns.status, context: heartbeatRuns.contextSnapshot,
      companyStatus: companies.status, agentStatus: agents.status, lifecycle: agents.lifecycleState }).from(heartbeatRuns)
      .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
      .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
      .where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, binding.agentId)));
    const pins = run?.context?.skillVersions;
    if (!run || run.status !== "running" || run.companyStatus !== "active" || ["paused", "terminated"].includes(run.agentStatus) || run.lifecycle !== "ready"
        || run.context?.skillSelectionSnapshot !== true || !pins || typeof pins !== "object" || Array.isArray(pins)
        || !Object.hasOwn(pins, selection.key) || (pins as Record<string, unknown>)[selection.key] !== selection.versionId) throw refuse();
    try { await skillAccessService(db, actor).assertSkill(companyId, selection.skillId); }
    catch (error) { if (error instanceof HttpError && [403, 404].includes(error.status)) throw refuse(); throw error; }
    binding.signal?.throwIfAborted();
  }
  async function publish(selection: Selection): Promise<string> {
    await authorized(selection);
    const version = await packages.version(companyId, selection.skillId, selection.versionId!);
    if (!version) throw refuse();
    const identity = `${selection.skillId}/${selection.versionId}`;
    const previous = published.get(identity);
    if (previous) { await authorized(selection); return previous; }
    const files = await packages.versionFiles(version, true, binding.signal);
    // Validate the complete inventory before creating any export. No cache links,
    // Git metadata, or arbitrary source paths are consumed by this operation.
    let manifest: ReturnType<typeof skillPackageManifest>;
    try { manifest = skillPackageManifest(files); } catch { throw refuse(); }
    const prefix = `${selection.skillId}/${selection.versionId}`;
    const newDirectories = new Set<string>();
    const admitDirectory = (directory: string) => {
      if (!directories.has(directory)) newDirectories.add(directory);
      if (count + newDirectories.size + manifest.files.length > CONTROLLER_ASSET_LIMITS.entries) throw refuse();
    };
    // Bound the preflight itself, including shared ancestors. Reject excessive
    // depth before constructing ancestor strings or allocating any export.
    admitDirectory(selection.skillId); admitDirectory(prefix);
    for (const file of manifest.files) {
      const parts = file.path.split("/");
      if (parts.length > CONTROLLER_ASSET_LIMITS.depth) throw refuse();
      for (let n = 1; n < parts.length; n++) admitDirectory(`${prefix}/${parts.slice(0, n).join("/")}`);
    }
    const bareGit = manifest.files.some(file => file.path === "HEAD") && manifest.files.some(file => file.path.startsWith("objects/"));
    if (bareGit || !manifest.files.some(file => file.path === "SKILL.md") || manifest.files.some(file =>
        file.path.split("/").some(part => [".git", ".gitmodules", ".gitconfig", ".git-credentials"].includes(part.toLowerCase()))
        || file.path.split("/").length > CONTROLLER_ASSET_LIMITS.depth || file.size > CONTROLLER_ASSET_LIMITS.fileBytes)
        || count + newDirectories.size + manifest.files.length > CONTROLLER_ASSET_LIMITS.entries || bytes + manifest.totalBytes > CONTROLLER_ASSET_LIMITS.snapshotBytes) throw refuse();
    await authorized(selection);
    if (!directory) {
      directory = await createControllerSourceStagingDirectory();
      try { binding.onCleanup(cleanup); } catch (error) { closed = true; await remove(); throw error; }
    }
    const target = path.join(directory, selection.skillId, selection.versionId!);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const file of files) {
      binding.signal?.throwIfAborted();
      if (closed) throw refuse();
      const output = path.join(target, file.path);
      await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      const handle = await fs.open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const actual = await fs.realpath(`/proc/self/fd/${handle.fd}`);
        const info = await handle.stat();
        if (actual !== output || !info.isFile() || info.nlink !== 1 || info.size !== 0
            || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw refuse();
        await handle.writeFile(skillFileBytes(file));
        await handle.chmod(file.executable ? 0o500 : 0o400);
      } finally { await handle.close(); }
    }
    if (!await verifySkillPackageDirectory(target, manifest.files)) throw refuse();
    await authorized(selection);
    count += newDirectories.size + manifest.files.length; bytes += manifest.totalBytes;
    for (const directory of newDirectories) directories.add(directory);
    published.set(identity, target);
    return target;
  }
  return { exportVersion(selection: Selection): Promise<string> {
    // Serialize publication and make cleanup await every admitted writer. The
    // executor waits for parallel preparation before invoking registered cleanup.
    const work = active.then(() => withSkillVersionCacheLock(db, companyId, () => publish(selection))).catch(async error => { closed = true; await remove(); throw error; });
    active = work.then(() => undefined, () => undefined);
    return work;
  } };
}
