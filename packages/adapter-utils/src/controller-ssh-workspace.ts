import path from "node:path";
import { extractControllerWorkspaceArchive } from "./controller-workspace-archive.js";
import fs from "node:fs/promises";
import { createControllerSourceSnapshot, createControllerSourceStagingDirectory } from "./controller-source-materialization.js";
import { assertControllerWorkspacePublication, markControllerWorkspaceReturnReady, hasControllerWorkspaceAuthority, withControllerWorkspaceOperation, recordControllerWorkspaceRestoreFailure } from "./controller-workspace-authority.js";
import { captureDirectorySnapshot, directorySnapshotSha256, disposeDirectorySnapshot, mergeDirectoryWithBaseline } from "./workspace-restore-merge.js";
import { prepareWorkspaceForSshExecution, downloadControllerWorkspaceArchive, type SshRemoteExecutionSpec } from "./ssh.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";

/** No credentials in the binding or diagnostics. Scope includes lease generation and boot. */
export function controllerSshWorkspaceTarget(spec: SshRemoteExecutionSpec, runId: string, remoteDir: string): string {
  return JSON.stringify({ runId, host: spec.host, port: spec.port, username: spec.username,
    knownHosts: spec.knownHosts, strictHostKeyChecking: spec.strictHostKeyChecking,
    remoteWorkspacePath: spec.remoteWorkspacePath, remoteCwd: spec.remoteCwd, remoteDir, scope: spec.runScope ? [spec.runScope.schema, spec.runScope.companyId, spec.runScope.runId,
      spec.runScope.leaseId, spec.runScope.generation, spec.runScope.bootId] : null });
}

/** Native repository-free attempts use checked flat trees; never grant generic tar access to the original. */
export async function prepareControllerSshWorkspace(input: {
  spec: SshRemoteExecutionSpec; runId: string; localDir: string; remoteDir: string;
  workspaceExclude?: string[]; onProgress?: RuntimeProgressSink;
}) {
  const target = controllerSshWorkspaceTarget(input.spec, input.runId, input.remoteDir);
  if (!hasControllerWorkspaceAuthority(input.localDir, target)) return null;
  const excludeNames = new Set([".git", ".paperclip-runtime"]);
  const snapshot = await withControllerWorkspaceOperation(input.localDir, target, "read", () =>
    createControllerSourceSnapshot(input.localDir, { excludeNames, rejectLinks: true, preserveFileModes: true }));
  const exclude = [".git", ".git/*", "*/.git", "*/.git/*", ".paperclip-runtime", ...(input.workspaceExclude ?? [])];
  let baseline;
  try {
    baseline = await captureDirectorySnapshot(snapshot.directory, { exclude });
    await withControllerWorkspaceOperation(input.localDir, target, "read", async () => {});
    await prepareWorkspaceForSshExecution({ ...input, localDir: snapshot.directory, workspaceFileMode: "all", workspaceExclude: exclude });
    await markControllerWorkspaceReturnReady(input.localDir, target);
  } catch (error) {
    if (baseline) await disposeDirectorySnapshot(baseline);
    throw error;
  } finally { await snapshot.cleanup(); }
  // The baseline is closure-owned, never accepted from adapter config or a restore request.
  const genuineBaseline = baseline;
  let restored = false;
  let restoring: Promise<void> | undefined;
  const restore = async (onProgress?: RuntimeProgressSink) => {
      if (restored) return;
      const staging = await createControllerSourceStagingDirectory();
      try {
        // No ownership/DB lock while waiting for SSH. No authority is active here.
        const archive = path.join(staging, "download.tar");
        await downloadControllerWorkspaceArchive({ spec: input.spec, remoteDir: input.remoteDir, archivePath: archive, exclude });
        const extracted = path.join(staging, "tree"); await fs.mkdir(extracted, { mode: 0o700 });
        await extractControllerWorkspaceArchive(archive, extracted);
        // Bound and validate the downloaded tree before entering a publication fence.
        const remote = await createControllerSourceSnapshot(extracted, { excludeNames, rejectLinks: true, preserveFileModes: true });
        try {
          await mergeDirectoryWithBaseline({ baseline: genuineBaseline, sourceDir: remote.directory, targetDir: input.localDir,
            publicationPreflight: () => withControllerWorkspaceOperation(input.localDir, target, "return_read", async () => {
              const checked = await createControllerSourceSnapshot(input.localDir, { excludeNames, rejectLinks: true, preserveFileModes: true });
              try { return await captureDirectorySnapshot(checked.directory, { exclude }); } finally { await checked.cleanup(); }
            }),
            publicationFence: action => withControllerWorkspaceOperation(input.localDir, target, "publish", action),
            beforeMutation: assertControllerWorkspacePublication,
          });
          restored = true;
        } finally { await remote.cleanup(); }
      } catch (error) {
        await recordControllerWorkspaceRestoreFailure(input.localDir, target);
        throw error;
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
  };
  return { baselineSha256: directorySnapshotSha256(genuineBaseline), exclude: genuineBaseline.exclude, restore: (onProgress?: RuntimeProgressSink) => {
    // A second caller joins the same restore; it cannot race or duplicate publication.
    restoring ??= restore(onProgress);
    return restoring;
  } };

}
