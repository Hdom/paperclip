import { withNativeWorkspaceFinalizationOwnership } from "./native-runtime/native-workspace-finalization-ownership.js";
import { parseEnvironmentDriverConfig } from "./environment-config.js";
import { readRunCancellation } from "./run-cancellation.js";
import { recordRequiredWorkspaceRestoreFailure } from "./legacy-execution-recovery.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, environments, environmentLeases, executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { controllerExecutionProtected } from "@paperclipai/adapter-utils/controller-source-protection";
import { withControllerWorkspaceAuthority } from "@paperclipai/adapter-utils/controller-workspace-authority";
import { controllerSshWorkspaceTarget } from "@paperclipai/adapter-utils/controller-ssh-workspace";
import { ControllerSourceProtectionError } from "@paperclipai/adapter-utils/controller-source-error";
import { isBoundIsolatedTaskDirectory } from "./isolated-task-directory.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const refused = () => new ControllerSourceProtectionError("Native task workspace ownership could not be verified");

/** Server-only authority bridge. IDs come from prepared execution, then are checked against persisted owners. */
export async function withScopedTaskWorkspaceAuthority<T>(db: Db, input: {
  companyId: string; agentId: string; issueId: string | null; runId: string;
  workspaceId: string | null; workspaceCwd: string; target: AdapterExecutionTarget | null | undefined; signal: AbortSignal;
}, action: () => Promise<T>): Promise<T> {
  const target = input.target;
  if (!controllerExecutionProtected() || target?.kind !== "remote" || target.transport !== "ssh" || !input.workspaceId || !input.issueId) return action();
  const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId)));
  if (workspace?.mode !== "isolated_workspace" || workspace.strategyType !== "project_primary" || workspace.repoUrl || workspace.branchName) return action();
  const scope = target.spec.runScope;
  if (!scope || scope.companyId !== input.companyId || scope.runId !== input.runId || scope.leaseId !== target.leaseId || !target.environmentId || !workspace.cwd) throw refused();
  const root = workspace.cwd;
  if (root !== input.workspaceCwd) throw refused();
  const [initialLease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, scope.leaseId), eq(environmentLeases.companyId, input.companyId)));
  if (!initialLease?.providerLeaseId) throw refused();
  const transaction = new AsyncLocalStorage<Db>();
  const validate = async (lock = false) => {
    const selected = transaction.getStore() ?? db;
    const agentQuery = selected.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
    const [agent] = await (lock ? agentQuery.for("share", { noWait: true }) : agentQuery);
    const companyQuery = selected.select().from(companies).where(eq(companies.id, input.companyId));
    const [company] = await (lock ? companyQuery.for("share", { noWait: true }) : companyQuery);
    const environmentQuery = selected.select().from(environments).where(eq(environments.id, target.environmentId!));
    const [environment] = await (lock ? environmentQuery.for("share", { noWait: true }) : environmentQuery);
    // NOWAIT on every owner row prevents lock-order waits/deadlocks with lifecycle/config writers.
    // Hold them only during bounded local mutation, after SSH and checked hashing have finished.
    const taskQuery = selected.select().from(issues).where(and(eq(issues.id, input.issueId!), eq(issues.companyId, input.companyId)));
    const [task] = await (lock ? taskQuery.for("share", { noWait: true }) : taskQuery);
    const runQuery = selected.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
    const [run] = await (lock ? runQuery.for("share", { noWait: true }) : runQuery);
    const workspaceQuery = selected.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, workspace.id), eq(executionWorkspaces.companyId, input.companyId)));
    const [current] = await (lock ? workspaceQuery.for("share", { noWait: true }) : workspaceQuery);
    const leaseQuery = selected.select().from(environmentLeases).where(and(eq(environmentLeases.id, scope.leaseId), eq(environmentLeases.companyId, input.companyId)));
    const [lease] = await (lock ? leaseQuery.for("share", { noWait: true }) : leaseQuery);
    const parsed = environment?.driver === "ssh" ? parseEnvironmentDriverConfig({ driver: "ssh", config: environment.config }) : null;
    const config = parsed?.driver === "ssh" ? parsed.config : null;
    const endpoint = { host: target.spec.host, port: target.spec.port, username: target.spec.username,
      remoteWorkspacePath: target.spec.remoteWorkspacePath, remoteCwd: target.spec.remoteCwd };
    if (!agent || !company || company.status !== "active" || agent.lifecycleState !== "ready" || ["paused", "terminated"].includes(agent.status) || agent.lifecycleHolds?.length ||
        !environment || environment.driver !== "ssh" || !config || !task || !run || !current || !lease ||
        Object.entries(endpoint).some(([key, value]) => lease.metadata?.[key] !== value) ||
        ["host", "username", "remoteWorkspacePath"].some(key => config[key as keyof typeof config] !== endpoint[key as keyof typeof endpoint]) ||
        Number(config.port ?? 22) !== endpoint.port || config.knownHosts !== target.spec.knownHosts ||
        config.strictHostKeyChecking !== target.spec.strictHostKeyChecking || lease.expiresAt && lease.expiresAt.getTime() <= Date.now() ||
        run.resultJson?.startupCancellation || run.resultJson?.nativeCancellation || run.resultJson?.executionCancellation || readRunCancellation(run.resultJson) ||
        task.assigneeAgentId !== input.agentId || task.executionRunId !== input.runId ||
        task.executionWorkspaceId !== current.id || run.agentId !== input.agentId || run.status !== "running" || run.finishedAt ||
        (run.issueId ?? run.contextSnapshot?.issueId) !== input.issueId || run.contextSnapshot?.executionWorkspaceId !== current.id ||
        current.cwd !== root || lease.status !== "active" || lease.releasedAt || lease.provider !== "ssh" ||
        lease.environmentId !== target.environmentId || lease.executionWorkspaceId !== current.id || lease.issueId !== input.issueId ||
        lease.heartbeatRunId !== input.runId || lease.providerLeaseId !== initialLease.providerLeaseId ||
        lease.providerLeaseId !== `ssh://${target.spec.username}@${target.spec.host}:${target.spec.port}${target.spec.remoteCwd}` ||
        lease.metadata?.remoteExecutionScopeRequired !== true || !isDeepStrictEqual(lease.metadata.remoteExecutionScope, scope) ||
        !await isBoundIsolatedTaskDirectory({ companyId: input.companyId, issueId: input.issueId!, workspaceId: current.id, workspace: current as Parameters<typeof isBoundIsolatedTaskDirectory>[0]["workspace"] })) throw refused();
    // Native namespace ancestors must also remain controller-owned private directories.
    const base = await realpath(resolvePaperclipInstanceRoot());
    const relative = path.relative(base, root).split(path.sep);
    if (!((relative[0] === "isolated-workspace-attempts" && relative.length === 4) ||
        (relative[0] === "isolated-workspaces" && relative.length === 3)) || relative[1] !== input.companyId || relative[2] !== input.issueId) throw refused();
    if (run.contextSnapshot?.freshSession === true && relative[0] === "isolated-workspace-attempts" && relative[3] !== run.id) throw refused();
    let directory = base;
    for (const segment of relative) {
      directory = path.join(directory, segment);
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw refused();
    }
  };
  const remoteDir = path.posix.join(target.spec.remoteCwd, ".paperclip-runtime", "runs", input.runId, "workspace");
  return withControllerWorkspaceAuthority({ root, target: controllerSshWorkspaceTarget(target.spec, input.runId, remoteDir), signal: input.signal,
    validate: () => validate(),
    restoreFailed: async () => {
      const [sourceRun] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)));
      if (!sourceRun) throw refused();
      await recordRequiredWorkspaceRestoreFailure(db, sourceRun, {
        workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA, leaseIds: [initialLease.id],
          source: { provider: "ssh", runId: input.runId, executionWorkspaceId: workspace.id, leaseId: initialLease.id,
            environmentId: target.environmentId, providerLeaseId: initialLease.providerLeaseId, remoteDir,
            endpoint: { host: target.spec.host, port: target.spec.port, username: target.spec.username, remoteCwd: target.spec.remoteCwd },
            generation: scope.generation, bootId: scope.bootId } },
      });
    },
    assertPublication: async () => {
      const tx = transaction.getStore();
      if (!tx) throw refused();
      // A failed transaction cannot reconnect. Confirm its row locks before each destructive mutation.
      await tx.execute(sql`select 1`);
    },
    publish: async action => {
      // Existing durable owner receipt blocks successors even if a DB connection dies mid-write.
      // The owner helper joins all filesystem work before removing its physical-owner fence.
      const result = await withNativeWorkspaceFinalizationOwnership({ db, companyId: input.companyId, runId: input.runId,
        liveLegacyPublication: true }, async ownership => {
          await ownership.assertHeld();
          let filesystemWork: ReturnType<typeof action> | undefined;
          try {
            const value = await db.transaction(tx => {
              filesystemWork = transaction.run(tx as unknown as Db, async () => {
                await tx.execute(sql`set local idle_in_transaction_session_timeout = 0`);
                await validate(true);
                return action();
              });
              return filesystemWork;
            });
            await ownership.assertHeld();
            return value;
          } finally {
            // postgres.js can reject its transaction before its async callback settles.
            // Keep the durable physical-owner receipt until that callback actually joins.
            await filesystemWork?.catch(() => undefined);
          }
        });
      if (!result.acquired) throw refused();
      return result.value;
    },
  }, action);
}
