import { and, eq, sql } from "drizzle-orm";
import { environments, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { hasRetainedSshWorkspaceSource, inspectRetainedSshWorkspaceSource, parseRetainedSshWorkspaceSource,
  retainedSshHostKeyPolicySha256, type RetainedSshSourceIdentity } from "./retained-ssh-workspace-source.js";

/** One-time compatibility attestation for a receipt written before host-policy
 * digests existed. Only the reviewed controller operator utility supplies the
 * independently verified pre-run deployment clone. There is no agent/API route.
 */
export async function attestRetainedSshEndpointFromHistoricalEnvironment(db: Db, input: RetainedSshSourceIdentity & {
  historicalDb: Db; historicalDatabase: string; historicalBackupSha256: string; expectedHostKeyPolicySha256: string; actorId: string;
}) {
  if (!/^paperclip_qualify_[a-f0-9]{12}$/.test(input.historicalDatabase) || !/^[a-f0-9]{64}$/.test(input.historicalBackupSha256) || !/^[a-f0-9]{64}$/.test(input.expectedHostKeyPolicySha256))
    throw conflict("A verified pre-run deployment clone and public endpoint digest are required.");
  const identity = await input.historicalDb.execute(sql`select current_database() as name, current_setting('default_transaction_read_only') as readonly`);
  if (identity[0]?.name !== input.historicalDatabase || identity[0]?.readonly !== "on")
    throw conflict("Historical endpoint verification requires the exact read-only deployment clone.");
  const result = await db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("update");
    const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.actionId))).for("update");
    if (!issue || !run || !run.startedAt || !run.finishedAt || !action || action.evidence.runId !== run.id || issue.executionRunId || issue.checkoutRunId ||
        !hasRetainedSshWorkspaceSource(run.resultJson?.workspaceRestoreRecovery)) throw conflict("The retained source changed; no endpoint attestation was recorded.");
    const recovery = run.resultJson!.workspaceRestoreRecovery as { source: unknown };
    const source = parseRetainedSshWorkspaceSource(recovery.source);
    if (source.hostKeyPolicySha256) throw conflict("The original receipt already declares its endpoint policy; it cannot be replaced.");
    const [historical] = await input.historicalDb.select({ id: environments.id, driver: environments.driver, config: environments.config, updatedAt: environments.updatedAt })
      .from(environments).where(eq(environments.id, source.environmentId));
    const [current] = await tx.select().from(environments).where(eq(environments.id, source.environmentId)).for("share", { noWait: true });
    if (!historical || !current || historical.driver !== "ssh" || current.driver !== "ssh" || historical.updatedAt > run.startedAt ||
        retainedSshHostKeyPolicySha256(historical.id, historical.config as Record<string, unknown>, source.endpoint.remoteCwd) !== input.expectedHostKeyPolicySha256 ||
        retainedSshHostKeyPolicySha256(current.id, current.config as Record<string, unknown>, source.endpoint.remoteCwd) !== input.expectedHostKeyPolicySha256)
      throw conflict("The current worker endpoint does not match its verified pre-run configuration.");
    const fields = { schema: "paperclip.ssh-recovery-endpoint-attestation.v1", companyId: input.companyId, issueId: input.issueId,
      runId: run.id, actionId: action.id, leaseId: source.leaseId, sourceReceiptSha256: nativeSha256(run.resultJson!.workspaceRestoreRecovery),
      hostKeyPolicySha256: input.expectedHostKeyPolicySha256, provenance: "verified_pre_run_database_clone", historicalDatabase: input.historicalDatabase, historicalBackupSha256: input.historicalBackupSha256 };
    const prior = action.evidence.sshRecoveryEndpointAttestation;
    if (prior && nativeSha256(prior) !== nativeSha256(fields)) throw conflict("A different endpoint attestation already exists.");
    if (!prior) await tx.update(issueRecoveryActions).set({ evidence: { ...action.evidence, sshRecoveryEndpointAttestation: fields }, updatedAt: new Date() })
      .where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, action.id)));
    // Recheck every source/scope/stop/target guard with the new attestation in
    // this same transaction before it can become visible to recovery.
    if (!await inspectRetainedSshWorkspaceSource(tx as unknown as Db, input)) throw conflict("Retained source verification failed.");
    if (prior) return { alreadyAttested: true, publication: null };
    const activity = await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "user", actorId: input.actorId,
      action: "issue.ssh_recovery_endpoint_attested", entityType: "issue", entityId: input.issueId, runId: run.id,
      details: { recoveryActionId: action.id, historicalDatabase: input.historicalDatabase, historicalBackupSha256: input.historicalBackupSha256, hostKeyPolicySha256: input.expectedHostKeyPolicySha256,
        sourceReceiptSha256: fields.sourceReceiptSha256 } });
    return { alreadyAttested: false, publication: activity.publication };
  });
  if (result.publication) publishActivity(result.publication);
  return { alreadyAttested: result.alreadyAttested, hostKeyPolicySha256: input.expectedHostKeyPolicySha256 };
}
