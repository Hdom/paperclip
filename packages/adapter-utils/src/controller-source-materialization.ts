import { constants } from "node:fs";
import fs from "node:fs/promises";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertControllerSourcePathAllowed, assertControllerSourceSnapshotRoot, controllerExecutionProtected } from "./controller-source-protection.js";

const refused = () => new Error("Controller signing-key protection refused unsafe asset materialization");
export const CONTROLLER_ASSET_LIMITS = { fileBytes: 64 * 1024 * 1024, snapshotBytes: 256 * 1024 * 1024, entries: 10_000, depth: 64 } as const;

/** Validate the opened file too, so a replaced alias cannot bypass a pre-read check. */
export async function readControllerSourceFile(source: string): Promise<Buffer>;
export async function readControllerSourceFile(source: string, encoding: BufferEncoding): Promise<string>;
export async function readControllerSourceFile(source: string, encoding?: BufferEncoding): Promise<Buffer | string> {
  if (!controllerExecutionProtected()) {
    const bytes = await fs.readFile(source);
    return encoding ? bytes.toString(encoding) : bytes;
  }
  if (process.platform !== "linux") throw refused();
  await assertControllerSourcePathAllowed(source);
  const resolved = await realpath(source);
  await assertControllerSourcePathAllowed(resolved);
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > CONTROLLER_ASSET_LIMITS.fileBytes) throw refused();
    await assertControllerSourcePathAllowed(`/proc/self/fd/${file.fd}`);
    const chunks: Buffer[] = []; let size = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead; if (size > CONTROLLER_ASSET_LIMITS.fileBytes) throw refused();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size || size !== after.size) throw refused();
    const bytes = Buffer.concat(chunks, size);
    return encoding ? bytes.toString(encoding) : bytes;
  } finally { await file.close(); }
}

/** Private controller scratch is separate from mutable agent restore roots. */
export async function createControllerSourceStagingDirectory(): Promise<string> {
  const root = process.env.PAPERCLIP_CONTROLLER_ASSET_SNAPSHOT_ROOT || "/var/lib/paperclip/controller-assets";
  await assertControllerSourceSnapshotRoot(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw refused();
  await assertControllerSourceSnapshotRoot(root);
  return await mkdtemp(path.join(root, "asset-"));
}

/** Materialize only approved resolved sources; providers always receive a flat snapshot without tar -h. */
export async function createControllerSourceSnapshot(source: string): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  if (!controllerExecutionProtected()) throw refused();
  await assertControllerSourcePathAllowed(source);
  const directory = await createControllerSourceStagingDirectory();
  let entries = 0, bytes = 0;
  const active = new Set<string>();
  const copy = async (from: string, to: string, depth: number): Promise<void> => {
    if (++entries > CONTROLLER_ASSET_LIMITS.entries || depth > CONTROLLER_ASSET_LIMITS.depth) throw refused();
    await assertControllerSourcePathAllowed(from);
    const resolved = await realpath(from);
    await assertControllerSourcePathAllowed(resolved);
    const info = await lstat(resolved);
    if (info.isDirectory()) {
      if (active.has(resolved)) throw refused();
      active.add(resolved);
      await mkdir(to, { recursive: true, mode: 0o700 });
      const children = await readdir(resolved);
      if (children.length > CONTROLLER_ASSET_LIMITS.entries - entries) throw refused();
      for (const name of children) await copy(path.join(resolved, name), path.join(to, name), depth + 1);
      active.delete(resolved);
    } else if (info.isFile()) {
      if (info.size > CONTROLLER_ASSET_LIMITS.snapshotBytes - bytes) throw refused();
      const contents = await readControllerSourceFile(resolved);
      bytes += contents.length; if (bytes > CONTROLLER_ASSET_LIMITS.snapshotBytes) throw refused();
      await writeFile(to, contents, { mode: info.mode & 0o111 ? 0o700 : 0o600, flag: "wx" });
    } else throw refused();
  };
  const cleanup = async () => { await rm(directory, { recursive: true, force: true }); };
  try {
    await copy(source, directory, 0);
    return { directory, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
