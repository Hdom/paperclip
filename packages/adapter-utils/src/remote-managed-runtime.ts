import { lstat, realpath } from "node:fs/promises";
import { hasControllerWorkspaceAuthority, withControllerWorkspaceOperation } from "./controller-workspace-authority.js";
import { controllerSshWorkspaceTarget } from "./controller-ssh-workspace.js";
import { prepareControllerSshWorkspace } from "./controller-ssh-workspace.js";
import { createControllerSourceSnapshot } from "./controller-source-materialization.js";
import { controllerExecutionProtected } from "./controller-source-protection.js";
import path from "node:path";
import { GIT_ARCHIVE_EXCLUDES, PROJECT_REPOSITORIES_DIR } from "./git-workspace-sync.js";
import {
  type SshRemoteExecutionSpec,
  prepareWorkspaceForSshExecution,
  runSshCommand,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
} from "./ssh.js";
import {
  mergeExcludes,
  referencedSourceIgnoreExcludeEntries,
  type SandboxAdditionalSource,
  type SandboxManagedRuntimeAssetRestoreContext,
} from "./sandbox-managed-runtime.js";
import { captureDirectorySnapshot, captureDirectorySnapshotOffThread, directorySnapshotSha256, disposeDirectorySnapshot, type DirectorySnapshot } from "./workspace-restore-merge.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";

// The fixed heavy-directory excludes every referenced project drops,
// regardless of its ignore resolution. A `git`-resolved project additionally
// drops its own resolved ignored paths (see `referencedSourceIgnoreExcludeEntries`
// and the per-project merge below); an `other` project keeps only this set.
const REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".git",
].flatMap((entry) => [entry, `${entry}/*`, `*/${entry}`, `*/${entry}/*`]);

/** Issued only by this process after genuine baseline/upload and successful SSH restore. */
export interface WorkspaceCopybackReceipt {
  readonly schema: "paperclip.workspace-copyback.v1";
  readonly runId: string;
  readonly localDir: string;
  readonly remoteDir: string;
  readonly rootIdentity: Readonly<{ dev: number; ino: number; uid: number; mode: number }>;
  readonly scope: Readonly<NonNullable<SshRemoteExecutionSpec["runScope"]>>;
  readonly baselineSha256: string;
  readonly treeSha256: string;
  readonly entryCount: number;
  readonly exclude: readonly string[];
}
const issuedCopybacks = new WeakSet<object>();
/** Configuration, agent output and serialized objects cannot manufacture this attestation. */
export function isIssuedWorkspaceCopyback(value: unknown): value is WorkspaceCopybackReceipt {
  return Boolean(value && typeof value === "object" && issuedCopybacks.has(value));
}
export type WorkspaceCopybackSink = (verify: () => Promise<WorkspaceCopybackReceipt>) => Promise<void>;

export interface RemoteManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
  restore?: (ctx: SandboxManagedRuntimeAssetRestoreContext) => Promise<void>;
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  /**
   * Remote directory of each additional (referenced) project that staged
   * successfully, keyed by `projectId`. A project whose staging failed is
   * absent (per-project failure isolation).
   */
  additionalSourceDirs: Record<string, string>;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function readRemoteFile(spec: SshRemoteExecutionSpec, remotePath: string): Promise<Buffer> {
  const result = await runSshCommand(spec, `base64 < ${shellQuote(remotePath)}`, {
    maxBuffer: 1024 * 1024,
  });
  return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
}

export function buildRemoteExecutionSessionIdentity(spec: SshRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "ssh",
    host: spec.host,
    port: spec.port,
    username: spec.username,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function remoteExecutionSessionMatches(saved: unknown, current: SshRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildRemoteExecutionSessionIdentity(current);
  if (!currentIdentity) return false;

  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.host) === currentIdentity.host &&
    asNumber(parsedSaved.port) === currentIdentity.port &&
    asString(parsedSaved.username) === currentIdentity.username &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

export async function prepareRemoteManagedRuntime(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  syncWorkspace?: boolean;
  workspaceFileMode?: "all";
  workspaceExclude?: string[];
  assets?: RemoteManagedRuntimeAsset[];
  /** Referenced (additional) projects to stage as plain, read-only trees. */
  additionalSources?: SandboxAdditionalSource[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into the workspace/asset transfers.
  onWorkspaceCopyback?: WorkspaceCopybackSink;
  onProgress?: RuntimeProgressSink;
}): Promise<PreparedRemoteManagedRuntime> {
  const baseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const syncWorkspace = input.syncWorkspace !== false;
  const workspaceRemoteDir = syncWorkspace
    ? path.posix.join(
        baseWorkspaceRemoteDir,
        ".paperclip-runtime",
        "runs",
        input.runId,
        "workspace",
      )
    : baseWorkspaceRemoteDir;
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);
  const originalRoot = input.onWorkspaceCopyback && syncWorkspace ? await lstat(input.workspaceLocalDir) : null;

  const scopedWorkspace = syncWorkspace && controllerExecutionProtected()
    ? await prepareControllerSshWorkspace({ spec: input.spec, runId: input.runId, localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir, workspaceExclude: input.workspaceExclude, onProgress: input.onProgress }) : null;
  const preparedWorkspace = syncWorkspace && !scopedWorkspace
    ? await prepareWorkspaceForSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        onProgress: input.onProgress,
        workspaceFileMode: input.workspaceFileMode,
        workspaceExclude: input.workspaceExclude,
      })
    : null;
  const projectRepositories = preparedWorkspace?.repositories ?? [];
  const baselineSnapshot = preparedWorkspace
    ? await captureDirectorySnapshot(input.workspaceLocalDir, {
        exclude: preparedWorkspace.gitBacked
          ? [
              ...GIT_ARCHIVE_EXCLUDES,
              ...(controllerExecutionProtected() ? ["*/.git", "*/.git/*"] : []),
              ".paperclip-runtime",
              ...(projectRepositories.length > 0 ? [PROJECT_REPOSITORIES_DIR] : preparedWorkspace.excludedPaths ?? []),
            ]
          : [".paperclip-runtime", ...(preparedWorkspace.excludedPaths ?? []), ...(controllerExecutionProtected() ? [".git", ".git/*", "*/.git", "*/.git/*"] : []), ...(input.workspaceFileMode === "all" ? input.workspaceExclude ?? [] : [])],
      })
    : null;
  const repositoryBaselines: Array<{ path: string; baselineSnapshot: DirectorySnapshot }> = [];
  for (const repository of projectRepositories) {
    repositoryBaselines.push({
      path: repository,
      baselineSnapshot: await captureDirectorySnapshot(path.join(input.workspaceLocalDir, repository), {
        exclude: [...GIT_ARCHIVE_EXCLUDES, ...(controllerExecutionProtected() ? ["*/.git", "*/.git/*"] : []), ".paperclip-runtime"],
      }),
    });
  }

  const assetDirs: Record<string, string> = {};
  try {
    for (const asset of input.assets ?? []) {
      const remoteDir = path.posix.join(runtimeRootDir, asset.key);
      assetDirs[asset.key] = remoteDir;
      const snapshot = controllerExecutionProtected() && asset.followSymlinks
        ? await createControllerSourceSnapshot(asset.localDir) : null;
      try {
        await syncDirectoryToSsh({
          spec: input.spec,
          localDir: snapshot?.directory ?? asset.localDir,
          remoteDir,
          followSymlinks: snapshot ? false : asset.followSymlinks,
          exclude: asset.exclude,
          onProgress: input.onProgress,
          progressLabel: asset.key,
        });
      } finally { await snapshot?.cleanup(); }
    }
  } catch (error) {
    if (scopedWorkspace) await scopedWorkspace.restore(input.onProgress);
    if (preparedWorkspace && baselineSnapshot) {
      await restoreWorkspaceFromSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        baselineSnapshot,
        restoreGitHistory: preparedWorkspace.gitBacked,
        onProgress: input.onProgress,
        repositories: repositoryBaselines,
      });
    }
    throw error;
  }

  // Stage each referenced (additional) project as a plain, read-only tree in its
  // OWN isolated remote directory (`project-<projectId>`). Additional sources
  // never get the anchor's git-history/overlay semantics. Per-project failure
  // isolation: one project's failure logs a warning and is skipped; the run and
  // the other projects continue (no workspace restore, unlike an asset failure).
  const additionalSourceDirs: Record<string, string> = {};
  for (const source of input.additionalSources ?? []) {
    const { localPath, projectId, ignoreResolution } = source;
    try {
      if (!path.posix.isAbsolute(localPath)) {
        throw new Error(`additional source localPath is not an absolute path: ${localPath}`);
      }
      if (
        projectId.length === 0 ||
        projectId.includes("/") ||
        projectId.includes("\\") ||
        projectId.includes("..")
      ) {
        throw new Error(`additional source projectId is not a simple path segment: ${projectId}`);
      }
      // Fail closed: a project whose ignore resolution failed is not staged at
      // all — the existing per-project skip-and-warn path below handles it.
      if (ignoreResolution.kind === "failed") {
        throw new Error(`referenced project ignore resolution failed: ${ignoreResolution.reason}`);
      }
      const remoteDir = path.posix.join(runtimeRootDir, `project-${projectId}`);
      const exclude = mergeExcludes(
        REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES,
        referencedSourceIgnoreExcludeEntries(ignoreResolution),
      );
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: localPath,
        remoteDir,
        exclude,
        onProgress: input.onProgress,
        progressLabel: `project-${projectId}`,
      });
      additionalSourceDirs[projectId] = remoteDir;
    } catch (error) {
      console.warn(
        `[paperclip] Failed to stage referenced project ${projectId}; skipping it. ${String(error)}`,
      );
    }
  }

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    additionalSourceDirs,
    restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
      if (scopedWorkspace) await scopedWorkspace.restore(onProgress);
      if (preparedWorkspace && baselineSnapshot) {
        await restoreWorkspaceFromSshExecution({
          spec: input.spec,
          localDir: input.workspaceLocalDir,
          remoteDir: workspaceRemoteDir,
          baselineSnapshot,
          restoreGitHistory: preparedWorkspace.gitBacked,
          onProgress,
          repositories: repositoryBaselines,
        });
      }
      for (const asset of input.assets ?? []) {
        if (!asset.restore) continue;
        await asset.restore({
          assetDir: path.posix.join(runtimeRootDir, asset.key),
          readFile: (remotePath) => readRemoteFile(input.spec, remotePath),
        });
      }
      if (input.onWorkspaceCopyback && originalRoot && input.spec.runScope && (scopedWorkspace || baselineSnapshot)) {
        // The closure exists only after the actual transport restore above succeeded.
        // Hashing is lazy: runs with no workflow intent incur no extra tree walk.
        let verified: Promise<WorkspaceCopybackReceipt> | undefined;
        await input.onWorkspaceCopyback(() => verified ??= (async () => {
          const verify = async () => {
            const now = await lstat(input.workspaceLocalDir);
            if (await realpath(input.workspaceLocalDir) !== input.workspaceLocalDir || !now.isDirectory() || now.isSymbolicLink()
                || now.dev !== originalRoot.dev || now.ino !== originalRoot.ino) throw Error("workspace_copyback_identity_changed");
            const exclude = scopedWorkspace?.exclude ?? baselineSnapshot!.exclude;
            const checked = await createControllerSourceSnapshot(input.workspaceLocalDir,
              { excludeNames: new Set(exclude.filter(name => !name.includes("/"))), rejectLinks: true, preserveFileModes: true });
            try {
            const snapshot = await captureDirectorySnapshotOffThread(checked.directory, { exclude, diskBacked: true });
            try {
              if (snapshot.entries.size > 100_000) throw Error("workspace_copyback_inventory_exceeded");
              const receipt: WorkspaceCopybackReceipt = Object.freeze({ schema: "paperclip.workspace-copyback.v1", runId: input.runId,
                localDir: input.workspaceLocalDir, remoteDir: workspaceRemoteDir,
                rootIdentity: Object.freeze({ dev: now.dev, ino: now.ino, uid: now.uid, mode: now.mode }),
                scope: Object.freeze({ ...input.spec.runScope! }), baselineSha256: scopedWorkspace?.baselineSha256 ?? directorySnapshotSha256(baselineSnapshot!),
                treeSha256: directorySnapshotSha256(snapshot), entryCount: snapshot.entries.size, exclude: Object.freeze([...exclude]) });
              issuedCopybacks.add(receipt); return receipt;
            } finally { await disposeDirectorySnapshot(snapshot); }
            } finally { await checked.cleanup(); }
          };
          const target = controllerSshWorkspaceTarget(input.spec, input.runId, workspaceRemoteDir);
          return hasControllerWorkspaceAuthority(input.workspaceLocalDir, target)
            ? withControllerWorkspaceOperation(input.workspaceLocalDir, target, "return_read", verify) : verify();
        })());
      }
    },
  };
}
