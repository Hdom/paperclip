import { isDeepStrictEqual } from "node:util";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Environment, EnvironmentLease, EnvironmentLeaseStatus } from "@paperclipai/shared";
import { parseSshRunScope, verifiedSshRunScopeStop } from "@paperclipai/adapter-utils/ssh-run-scope";
import { ensureSshWorkspaceReady, prepareSshRunScope, probeSshRunScope, stopSshRunScope, type SshConnectionConfig } from "@paperclipai/adapter-utils/ssh";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import { environmentService } from "./environments.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { readRunCancellation } from "./run-cancellation.js";
import type { EnvironmentDriverAcquireInput } from "./environment-runtime.js";

async function assertRunAdmission(db: Db, companyId: string, runId: string | null) {
  if (!runId) return;
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
    eq(heartbeatRuns.companyId, companyId))).for("update");
  if (!run || run.status !== "running" || run.finishedAt || readRunCancellation(run.resultJson) ||
      run.resultJson?.startupCancellation || run.resultJson?.nativeCancellation || run.resultJson?.executionCancellation) {
    throw new Error("ssh_run_scope_admission_closed");
  }
}

export async function acquireSshRunLease(db: Db, input: EnvironmentDriverAcquireInput) {
  const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, input.environment, {
    issueId: input.issueId, heartbeatRunId: input.heartbeatRunId, applyCustomImageTemplate: input.applyCustomImageTemplate ?? false,
  });
  if (parsed.driver !== "ssh") throw new Error("ssh_run_scope_unsupported");
  const { remoteCwd, bootId } = await probeSshRunScope(parsed.config);
  // The slow probe is outside the transaction. Cancellation and allocation
  // serialize on the owning run, including its cancellation-before-insert case.
  const lease = await db.transaction(async tx => {
    await assertRunAdmission(tx as unknown as Db, input.companyId, input.heartbeatRunId);
    return await environmentService(tx as unknown as Db).acquireLease({ companyId: input.companyId, environmentId: input.environment.id,
      executionWorkspaceId: input.executionWorkspaceId, issueId: input.issueId, heartbeatRunId: input.heartbeatRunId,
      leasePolicy: "ephemeral", provider: "ssh", assertCompanyBinding: input.assertCompanyBinding,
      providerLeaseId: `ssh://${parsed.config.username}@${parsed.config.host}:${parsed.config.port}${remoteCwd}`,
      metadataForNewLease: leaseId => ({ ...(input.agentId ? { agentId: input.agentId } : {}),
        driver: "ssh", executionWorkspaceMode: input.executionWorkspaceMode,
        host: parsed.config.host, port: parsed.config.port, username: parsed.config.username,
        remoteWorkspacePath: parsed.config.remoteWorkspacePath, remoteCwd, remoteExecutionScopeRequired: true,
        remoteExecutionScope: parseSshRunScope({schema: "paperclip.ssh-run-scope.v1", companyId: input.companyId,
          runId: input.heartbeatRunId, leaseId, generation: randomUUID(), bootId}),
      }),
    });
  });
  return await initializeSshRunLease(db, parsed.config, input.environment, lease);
}

/** Persist scope ownership before any remote command can enter it. A recovery
 * retry stops existing ownership; it never calls this initializer again. */
export async function initializeSshRunLease(db: Db, config: SshConnectionConfig, environment: Environment,
  lease: EnvironmentLease): Promise<EnvironmentLease> {
  const service = environmentService(db);
  const scope = parseSshRunScope(lease.metadata?.remoteExecutionScope);
  try {
    // Provision only the empty control owner, even if cancellation won just
    // after insertion. This lets cleanup converge; no workload is admitted.
    await prepareSshRunScope(config, scope);
    await db.transaction(tx => assertRunAdmission(tx as unknown as Db, lease.companyId, lease.heartbeatRunId));
    const before = await service.getLeaseById(lease.id);
    if (before?.status !== "active" || before.releasedAt || !isDeepStrictEqual(before.metadata?.remoteExecutionScope, scope)) throw new Error("ssh_run_scope_admission_closed");
    const workspace = await ensureSshWorkspaceReady({ ...config, runScope: scope });
    await db.transaction(tx => assertRunAdmission(tx as unknown as Db, lease.companyId, lease.heartbeatRunId));
    const current = await service.getLeaseById(lease.id);
    if (workspace.remoteCwd !== lease.metadata?.remoteCwd || current?.status !== "active" || current.releasedAt || !isDeepStrictEqual(current.metadata?.remoteExecutionScope, scope)) {
      throw new Error("ssh_run_scope_admission_closed");
    }
    return current;
  } catch (error) {
    await releaseSshRunLease(db, { environment, lease, status: "failed" });
    throw error;
  }
}

/** Provider mechanics stay outside heartbeat. A local SSH-client exit, a
 * released row, or an absent numeric PID never supplies this acknowledgement. */
export async function verifySshLeaseStopped(db: Db, environment: Environment | null, lease: EnvironmentLease) {
  const scope = parseSshRunScope(lease.metadata?.remoteExecutionScope);
  if (!environment || environment.driver !== "ssh" || environment.id !== lease.environmentId || lease.provider !== "ssh" ||
      scope.companyId !== lease.companyId || scope.runId !== lease.heartbeatRunId || scope.leaseId !== lease.id || lease.metadata?.remoteExecutionScopeRequired !== true) {
    throw new Error("ssh_run_scope_unverified");
  }
  const parsed = await resolveEnvironmentDriverConfigForRuntime(db, lease.companyId, environment);
  if (parsed.driver !== "ssh") throw new Error("ssh_run_scope_unverified");
  const config = parsed.config, metadata = lease.metadata ?? {};
  if (metadata.host !== config.host || metadata.port !== config.port || metadata.username !== config.username ||
      metadata.remoteWorkspacePath !== config.remoteWorkspacePath || typeof metadata.remoteCwd !== "string" ||
      lease.providerLeaseId !== `ssh://${config.username}@${config.host}:${config.port}${metadata.remoteCwd}`) {
    // Never redirect a cleanup RPC to a newly configured host or workspace.
    throw new Error("ssh_run_scope_unverified");
  }
  const acknowledgement = await stopSshRunScope(config, scope);
  // Revalidate at persistence, even if a transport/plugin producer misbehaves.
  verifiedSshRunScopeStop(scope, acknowledgement);
  return { providerLeaseId: lease.providerLeaseId, state: "stopped" as const, resourceScope: scope };
}

export async function releaseSshRunLease(db: Db, input: {
  environment: Environment; lease: EnvironmentLease;
  status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
}) {
  input = { ...input, lease: structuredClone(input.lease), environment: structuredClone(input.environment) };
  const service = environmentService(db);
  if (!Object.hasOwn(input.lease.metadata ?? {}, "remoteExecutionScope") && input.lease.metadata?.remoteExecutionScopeRequired !== true) {
    // Retain the established bookkeeping contract for historical unscoped
    // leases. This adds no termination receipt; cancelled work stays held.
    return await service.releaseLease(input.lease.id, input.status);
  }
  const metadata = input.lease.metadata ?? {};
  const expectedAuthority = { companyId: input.lease.companyId, environmentId: input.lease.environmentId,
    heartbeatRunId: input.lease.heartbeatRunId, provider: input.lease.provider, providerLeaseId: input.lease.providerLeaseId,
    metadata: Object.fromEntries(["host", "port", "username", "remoteWorkspacePath", "remoteCwd", "remoteExecutionScopeRequired", "remoteExecutionScope"]
      .filter(key => Object.hasOwn(metadata, key)).map(key => [key, metadata[key]])) };
  let receipt: Awaited<ReturnType<typeof verifySshLeaseStopped>>;
  try {
    receipt = await verifySshLeaseStopped(db, input.environment, input.lease);
  } catch {
    // The existing durable cleanup obligation/retry owner handles transport
    // uncertainty. Do not manufacture proof or restart a missing supervisor.
    return await service.releaseLease(input.lease.id, "pending_cleanup", {
      cleanupStatus: "failed", failureReason: "ssh_run_scope_unverified", expectedAuthority, preserveVerifiedTermination: true,
    });
  }
  // Persistence errors/uncertain commits must not erase an already-committed
  // receipt by being reclassified as a transport failure.
  const termination = remoteTerminationReceipt(input.lease, receipt);
  if (input.lease.heartbeatRunId && !termination) throw new Error("ssh_run_scope_unverified");
  return await service.releaseLease(input.lease.id, input.status, {
    cleanupStatus: "success", remoteExecutionTermination: termination, expectedAuthority, preserveVerifiedTermination: true,
  });
}
