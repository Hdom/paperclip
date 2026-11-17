import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueRecoveryActions, workspaceOperations, type Db } from "@paperclipai/db";
import { downloadStoppedSshWorkspaceArchive } from "@paperclipai/adapter-utils/ssh";
import { extractControllerWorkspaceArchive } from "@paperclipai/adapter-utils/controller-workspace-archive";
import { createControllerSourceSnapshot } from "@paperclipai/adapter-utils/controller-source-materialization";
import { inspectRetainedSshWorkspaceSource, hasRetainedSshWorkspaceSource, type RetainedSshSourceIdentity } from "./retained-ssh-workspace-source.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { preserveWorkspaceSnapshot, readSnapshot } from "./workspace-recovery-snapshot.js";
import { SystemRecoveryFailure } from "./system-recovery-state.js";

export async function preserveRetainedSshWorkspace(input: RetainedSshSourceIdentity & {
  db: Db; assertHeld(): Promise<void>;
}) {
  const initial = await inspectRetainedSshWorkspaceSource(input.db, input);
  if (!initial) throw new SystemRecoveryFailure("source_binding_invalid", "service_required");
  const sourceReceiptSha256 = nativeSha256(initial.run.resultJson!.workspaceRestoreRecovery);
  const assertSource = async () => {
    await input.assertHeld();
    const current = await inspectRetainedSshWorkspaceSource(input.db, input);
    if (!current || nativeSha256(current.run.resultJson!.workspaceRestoreRecovery) !== sourceReceiptSha256 ||
        current.hostKeyPolicySha256 !== initial.hostKeyPolicySha256) throw new SystemRecoveryFailure("source_binding_invalid", "service_required");
  };
  const sourceProof = { schema: "paperclip.stopped-ssh-preservation.v1", sourceReceiptSha256,
    hostKeyPolicySha256: initial.hostKeyPolicySha256, runId: input.runId, leaseId: initial.lease.id,
    generation: initial.source.generation, bootId: initial.source.bootId, remoteDir: initial.source.remoteDir };
  return preserveWorkspaceSnapshot({ ...input, leaseId: initial.lease.id, providerLeaseId: initial.source.providerLeaseId,
    sourceProof, assertHeld: assertSource,
    materializeDirectory: async directory => {
      const archive = path.join(path.dirname(directory), "stopped-source.tar");
      await assertSource();
      try {
        await downloadStoppedSshWorkspaceArchive({ spec: initial.target.spec, archivePath: archive, stop: initial.stop });
        await mkdir(directory, { mode: 0o700 });
        await extractControllerWorkspaceArchive(archive, directory);
        // Recheck the extracted flat tree with the same link/protected-source
        // rules as live transfers before generic snapshot storage can read it.
        const checked = await createControllerSourceSnapshot(directory, { rejectLinks: true, preserveFileModes: true,
          excludeNames: new Set([".git", ".paperclip-runtime", "node_modules"]) });
        await checked.cleanup();
        await assertSource();
      } finally { await rm(archive, { force: true }); }
    },
  });
}

/** Immutable preservation is a repair attachment, not a successful merge/result.
 * Caller additionally requires the existing completed-system/finalize receipt.
 */
export async function retainedSshPreservationReceipt(db: Db, input: {
  companyId: string; issueId: string; runId: string; actionId: string; operationIds: string[];
}) {
  const [run] = await db.select({ recovery: sql<unknown>`${heartbeatRuns.resultJson}->'workspaceRestoreRecovery'` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!hasRetainedSshWorkspaceSource(run?.recovery) || !input.operationIds.length) return null;
  const source = (run!.recovery as { source: Record<string, unknown> }).source;
  if (typeof source.leaseId !== "string") return null;
  const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.id, source.leaseId), eq(environmentLeases.heartbeatRunId, input.runId)));
  const owner = lease?.metadata?.remoteExecutionScope as Record<string, unknown> | undefined;
  if (!lease || lease.provider !== "ssh" || lease.providerLeaseId !== source.providerLeaseId || !hasRemoteTerminationReceipt(lease) ||
      owner?.companyId !== input.companyId || owner.runId !== input.runId || owner.leaseId !== lease.id ||
      owner.generation !== source.generation || owner.bootId !== source.bootId) return null;
  const [action] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.actionId)));
  const attestation = action?.evidence.sshRecoveryEndpointAttestation as { hostKeyPolicySha256?: unknown } | undefined;
  const expectedPolicy = source.hostKeyPolicySha256 ?? attestation?.hostKeyPolicySha256;
  if (typeof expectedPolicy !== "string" || !/^[a-f0-9]{64}$/.test(expectedPolicy)) return null;
  const operations = await db.select().from(workspaceOperations).where(and(
    inArray(workspaceOperations.id, input.operationIds), eq(workspaceOperations.companyId, input.companyId),
    eq(workspaceOperations.issueId, input.issueId), eq(workspaceOperations.heartbeatRunId, input.runId),
    eq(workspaceOperations.phase, "workspace_recovery_snapshot"), eq(workspaceOperations.status, "succeeded"),
    sql`${workspaceOperations.metadata}->>'recoveryActionId' = ${input.actionId}`));
  for (const operation of operations) {
    const proof = operation.metadata?.sourceProof as Record<string, unknown> | undefined;
    if (!proof || proof.schema !== "paperclip.stopped-ssh-preservation.v1" || proof.sourceReceiptSha256 !== nativeSha256(run!.recovery) ||
        proof.hostKeyPolicySha256 !== expectedPolicy || proof.runId !== input.runId || proof.leaseId !== source.leaseId ||
        proof.generation !== source.generation || proof.bootId !== source.bootId || proof.remoteDir !== source.remoteDir) continue;
    try {
      const snapshot = readSnapshot(operation.metadata, input.companyId, input.runId);
      if (snapshot.recoveryActionId === input.actionId && snapshot.leaseId === source.leaseId && snapshot.providerLeaseId === source.providerLeaseId) return operation.id;
    } catch { /* An invalid receipt never certifies repair. */ }
  }
  return null;
}
