import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { ControllerSourceProtectionError } from "./controller-source-error.js";

const refused = () => new ControllerSourceProtectionError("Controller workspace authority is missing, stale or unsafe");
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
type Operation = "read" | "return_read" | "publish";
type Authority = {
  root: string;
  target: string;
  open: boolean;
  returnReady: boolean;
  signal: AbortSignal;
  validate: (phase: "upload" | "return") => Promise<void>;
  restoreFailed?: () => Promise<void>;
  assertPublication?: () => Promise<void>;
  publish: <T>(action: () => Promise<T>) => Promise<T>;
  dev: number;
  ino: number;
};
const invocation = new AsyncLocalStorage<Authority>();
const operation = new AsyncLocalStorage<{ authority: Authority; kind: Operation }>();

/** Called only by the server after persisted domain/lease validation. Never serialize this authority. */
export async function withControllerWorkspaceAuthority<T>(input: {
  root: string; target: string; signal: AbortSignal;
  validate: (phase: "upload" | "return") => Promise<void>;
  restoreFailed?: () => Promise<void>;
  assertPublication?: () => Promise<void>;
  publish: <V>(action: () => Promise<V>) => Promise<V>;
}, action: () => Promise<T>): Promise<T> {
  if (!path.isAbsolute(input.root) || await realpath(input.root) !== input.root) throw refused();
  const stat = await lstat(input.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw refused();
  await input.validate("upload");
  const authority: Authority = { ...input, dev: stat.dev, ino: stat.ino, open: true, returnReady: false };
  try { return await invocation.run(authority, action); }
  finally { authority.open = false; }
}

async function assertLive(authority: Authority, kind: Operation, domain = true) {
  if (!authority.open || (kind !== "read" && !authority.returnReady) || (kind !== "publish" && authority.signal.aborted)) throw refused();
  const stat = await lstat(authority.root);
  if (await realpath(authority.root) !== authority.root || stat.isSymbolicLink() || !stat.isDirectory() ||
      stat.dev !== authority.dev || stat.ino !== authority.ino || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw refused();
  if (domain) await authority.validate(kind === "read" ? "upload" : "return");
}

/** Called by checked SSH preparation only after a genuine baseline and upload succeed.
 * This capability is invocation-local and never accepted from adapter configuration.
 */
export async function markControllerWorkspaceReturnReady(root: string, target: string): Promise<void> {
  const authority = invocation.getStore();
  if (!authority || authority.root !== root || authority.target !== target || authority.returnReady) throw refused();
  await assertLive(authority, "read");
  authority.returnReady = true;
}

export function hasControllerWorkspaceAuthority(root: string, target: string): boolean {
  const authority = invocation.getStore();
  return !!authority && authority.open && authority.root === root && authority.target === target;
}

export async function withControllerWorkspaceOperation<T>(root: string, target: string, kind: Operation,
  action: () => Promise<T>): Promise<T> {
  const authority = invocation.getStore();
  if (!authority || authority.root !== root || authority.target !== target) throw refused();
  const perform = async () => {
    await assertLive(authority, kind);
    const result = await operation.run({ authority, kind }, action);
    await assertLive(authority, kind);
    return result;
  };
  return kind === "publish" ? authority.publish(perform) : perform();
}

/** Returns an exact-root exception only during a server-authorized workspace operation.
 * A lexical alias or opened descriptor may never fall back to a different static root.
 */
export async function controllerWorkspacePathAdmission(file: string, canonical: string, writing: boolean): Promise<string | null> {
  const active = operation.getStore();
  if (!active) return null;
  const { authority, kind } = active;
  const relevant = inside(authority.root, file) || inside(authority.root, canonical) || file.startsWith("/proc/self/fd/");
  if (!relevant) return null;
  await assertLive(authority, kind, false);
  if (!inside(authority.root, canonical) || (writing && kind !== "publish")) throw refused();
  return authority.root;
}

/** Record an obligation for this original source; this does not reopen read or write admission. */
export async function recordControllerWorkspaceRestoreFailure(root: string, target: string): Promise<void> {
  const authority = invocation.getStore();
  if (!authority?.open || authority.root !== root || authority.target !== target) throw refused();
  await authority.restoreFailed?.();
}

export async function assertControllerWorkspacePublication(): Promise<void> {
  const active = operation.getStore();
  if (!active || active.kind !== "publish") throw refused();
  await assertLive(active.authority, "publish", false);
  await active.authority.assertPublication?.();
}
