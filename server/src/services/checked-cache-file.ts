import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { controllerExecutionProtected } from "@paperclipai/adapter-utils/controller-source-protection";

/** Cache corruption can be rebuilt. Storage failures must remain failures. */
export class UnsafeCacheFile extends Error {}
export function isCacheFileMiss(error: unknown) {
  return error instanceof UnsafeCacheFile || ["ENOENT", "ENOTDIR", "ELOOP", "EISDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}
function validate(stat: BigIntStats, maximum: number, expected?: number) {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size < 0n || stat.size > BigInt(maximum)
      || (expected !== undefined && stat.size !== BigInt(expected))
      || (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid()))) throw new UnsafeCacheFile("Unsafe cached file identity");
}
async function expectedCachePath(filename: string) {
  const configuredRoot = path.resolve(resolvePaperclipInstanceRoot());
  const relative = path.relative(configuredRoot, path.resolve(filename));
  // The configured instance root is an operator trust anchor. Pin its physical
  // identity before open; never resolve aliases in the cache descendants.
  if (relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
    return path.join(await fs.realpath(configuredRoot), relative);
  return controllerExecutionProtected() ? path.resolve(filename) : await fs.realpath(filename);
}
async function checkPath(filename: string, expected: string, handle?: FileHandle) {
  if (process.platform === "linux") {
    if (await fs.realpath(filename) !== expected
        || (handle && await fs.realpath(`/proc/self/fd/${handle.fd}`) !== expected)) throw new UnsafeCacheFile("Unsafe cached file path");
  } else if (controllerExecutionProtected()) {
    throw new UnsafeCacheFile("Protected cache reads require Linux descriptor path verification");
  }
}
export async function checkedCacheStat(filename: string, maximum: number, expected?: number) {
  const expectedPath = await expectedCachePath(filename);
  const stat = await fs.lstat(filename, { bigint: true });
  validate(stat, maximum, expected); await checkPath(filename, expectedPath);
  return stat;
}
export function sameCacheIdentity(before: BigIntStats, after: BigIntStats) {
  return ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeNs", "ctimeNs"].every(key =>
    before[key as keyof BigIntStats] === after[key as keyof BigIntStats]);
}
export async function checkCacheHandle(handle: FileHandle, filename: string, maximum: number, expected: number | undefined, expectedPath: string) {
  const stat = await handle.stat({ bigint: true });
  validate(stat, maximum, expected); await checkPath(filename, expectedPath, handle);
  const named = await fs.lstat(filename, { bigint: true });
  if (!sameCacheIdentity(stat, named)) throw new UnsafeCacheFile("Cached file changed during read");
  return stat;
}
export async function openCheckedCacheFile(filename: string, maximum: number, expected?: number) {
  const expectedPath = await expectedCachePath(filename);
  // NONBLOCK prevents an unexpected FIFO from blocking before fstat can refuse it.
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { return { handle, expectedPath, stat: await checkCacheHandle(handle, filename, maximum, expected, expectedPath) }; }
  catch (error) { await handle.close(); throw error; }
}
export async function readCheckedCacheFile(filename: string, maximum: number, expected?: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { handle, stat, expectedPath } = await openCheckedCacheFile(filename, maximum, expected);
  try {
    const bytes = Buffer.alloc(Number(stat.size) + 1); let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== Number(stat.size) || !sameCacheIdentity(stat, await checkCacheHandle(handle, filename, maximum, expected, expectedPath)))
      throw new UnsafeCacheFile("Cached file changed during read");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
