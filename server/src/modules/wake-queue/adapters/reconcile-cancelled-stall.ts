import { and, eq, gte, ne, or, inArray, sql } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, companies, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, workspaceOperations, type Db } from "@paperclipai/db";
import { conflict, forbidden } from "../../../errors.js";
import { authorizationService } from "../../../services/authorization.js";
import { persistActivity, publishActivity } from "../../../services/activity-log.js";
import { getExecutionBlocker } from "../../../services/execution-blocker.js";
import { retainedSshPreservationReceipt } from "../../../services/retained-ssh-workspace-preservation.js";
import { verifyBlockerStallWake } from "../../../services/recovery/blocker-stall-wakeups.js";
import { reconciledStallCancellation, stallSourceLeaseProof, stallWakeSha256 } from "./stall-disposition.js";

export type CancelledStallIdentity = {
  companyId: string; issueId: string; runId: string; sourceActionId: string; wakeId: string;
  stalledIssueId: string; stalledActionId: string; actorId: string;
  pauseActivityId: string; snapshotOperationId: string; cancellationSha256: string;
};

/** Explicit owner-only recovery utility. It neither dispatches nor updates the
 * original wake. An ordinary lifecycle cancellation remains an ordinary
 * cancellation unless this exact, verified source incident is reconciled.
 */
export async function reconcileCancelledBlockerStallWake(db: Db, input: CancelledStallIdentity) {
  if (!/^[a-f0-9]{64}$/.test(input.cancellationSha256)) throw conflict("Inspect the exact cancellation fingerprint first.");
  const result = await db.transaction(async tx => {
    // Same issue-first serialization as public wake admission and recovery.
    const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    if (!task || !(await authorizationService(tx as unknown as Db).decide({
      actor: { type: "board", userId: input.actorId, source: "session" }, action: "issue:mutate",
      resource: { type: "issue", companyId: input.companyId, issueId: task.id, status: task.status,
        assigneeAgentId: task.assigneeAgentId, assigneeUserId: task.assigneeUserId },
    })).allowed) throw forbidden("Current operator task authority is required.");
    // NOWAIT avoids reversing the company/agent lifecycle lock order. A pause
    // transition in flight must finish before this operation is attempted.
    const [company] = await tx.select().from(companies).where(eq(companies.id, input.companyId)).for("share", { noWait: true });
    const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, input.companyId), eq(agents.id, task.assigneeAgentId ?? "00000000-0000-0000-0000-000000000000"))).for("share", { noWait: true });
    if (company?.status !== "paused" || agent?.status !== "paused" || agent.lifecycleState !== "paused" ||
        !agent.lifecycleHolds?.includes("company_paused")) throw conflict("Company and source agent must be fully paused.");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("update");
    const [source] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, task.id), eq(issueRecoveryActions.id, input.sourceActionId))).for("update");
    const [wake] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.wakeId))).for("update");
    const [identity] = await tx.select({ sha256: stallWakeSha256(), reconciled: reconciledStallCancellation() }).from(agentWakeupRequests).where(eq(agentWakeupRequests.id, input.wakeId));
    const context = wake?.payload?._paperclipWakeContext as Record<string, unknown> | undefined;
    if (!run || !source || !wake || source.evidence.runId !== run.id || !run.finishedAt || (wake.finishedAt && wake.finishedAt < run.finishedAt) || task.executionRunId || task.checkoutRunId ||
        (run.issueId ?? run.contextSnapshot?.issueId) !== task.id || run.agentId !== agent.id || wake.agentId !== agent.id ||
        wake.status !== "cancelled" || wake.runId || wake.claimedAt || !wake.finishedAt || wake.error !== "Agent lifecycle stop requested" ||
        identity?.sha256 !== input.cancellationSha256 || wake.source !== "automation" || wake.requestedByActorType !== "system" ||
        wake.requestedByActorId !== "issue-blocker-stall" || wake.payload?.issueId !== task.id ||
        wake.payload?.stalledIssueId !== input.stalledIssueId || (wake.payload?.recoveryAction as { id?: unknown } | undefined)?.id !== input.stalledActionId ||
        context?.wakeReason !== "issue_blocker_stalled") throw conflict("The exact unclaimed lifecycle cancellation changed; inspect it again.");
    const [pause] = await tx.select().from(activityLog).where(and(eq(activityLog.id, input.pauseActivityId), eq(activityLog.companyId, input.companyId),
      eq(activityLog.actorType, "user"), eq(activityLog.action, "company.updated"), eq(activityLog.entityType, "company"), eq(activityLog.entityId, input.companyId),
      sql`${activityLog.details}->>'status' = 'paused'`, sql`${activityLog.createdAt} <= (select w.finished_at from agent_wakeup_requests w where w.id = ${wake.id})`, sql`${activityLog.createdAt} >= (select w.created_at from agent_wakeup_requests w where w.id = ${wake.id})`));
    const [laterStatus] = pause ? await tx.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.companyId, input.companyId),
      eq(activityLog.entityType, "company"), eq(activityLog.entityId, input.companyId), eq(activityLog.action, "company.updated"),
      sql`${activityLog.details} ? 'status'`, sql`${activityLog.createdAt} > (select p.created_at from activity_log p where p.id = ${pause.id})`)).limit(1) : [];
    const [snapshot] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.id, input.snapshotOperationId),
      eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.issueId, input.issueId), eq(workspaceOperations.heartbeatRunId, input.runId),
      eq(workspaceOperations.phase, "workspace_recovery_snapshot"), eq(workspaceOperations.status, "succeeded"),
      sql`${workspaceOperations.metadata}->>'recoveryActionId' = ${source.id}`)).for("share", { noWait: true });
    const [leaseProof] = await tx.select({ value: stallSourceLeaseProof(sql`${environmentLeases}`) }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, run.id),
      sql`${environmentLeases.id}::text = ${heartbeatRuns.resultJson}->'workspaceRestoreRecovery'->'source'->>'leaseId'`
    )).innerJoin(heartbeatRuns, eq(heartbeatRuns.id, run.id)).for("share", { of: environmentLeases, noWait: true });
    if (!leaseProof) throw conflict("Exact stopped source lease proof is unavailable.");
    if (!pause || laterStatus || !snapshot || !await retainedSshPreservationReceipt(tx as unknown as Db, { companyId: input.companyId,
      issueId: task.id, runId: run.id, actionId: source.id, operationIds: [snapshot.id] }))
      throw conflict("Actual pause evidence and verified immutable source snapshot are required.");
    if (identity.reconciled) {
      const [prior] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.companyId, input.companyId),
        eq(activityLog.action, "issue.stall_cancellation_reconciled"), eq(activityLog.entityId, task.id), eq(activityLog.runId, run.id),
        sql`${activityLog.details}->>'wakeId' = ${wake.id}`, sql`${activityLog.details}->>'pauseActivityId' = ${pause.id}`,
        sql`${activityLog.details}->>'snapshotOperationId' = ${snapshot.id}`, sql`${activityLog.details}->>'sourceActionId' = ${source.id}`)).limit(1);
      if (!prior) throw conflict("Cancellation already has a different reconciliation; inspect its evidence.");
      return { alreadyReconciled: true, publication: null };
    }
    if (!await verifyBlockerStallWake(tx as unknown as Db, { companyId: input.companyId, issueId: task.id, contextSnapshot: context, requestedByActorType: "system" }))
      throw conflict("The stalled dependency incident changed.");
    const blocker = await getExecutionBlocker(tx as unknown as Db, input.companyId, task.id);
    if (blocker?.recoveryActionId !== source.id || blocker.runId !== run.id || !blocker.workspaceRepairRequired)
      throw conflict("Source recovery must remain held during reconciliation.");
    const [live] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
      sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${task.id}`,
      or(inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
        and(ne(heartbeatRuns.id, run.id), gte(heartbeatRuns.createdAt, run.createdAt))))).limit(1);
    const [pending] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${task.id}`, inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"])) ).limit(1);
    if (live || pending) throw conflict("Execution or notification ownership changed; nothing was reconciled.");
    const activity = await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "user", actorId: input.actorId,
      action: "issue.stall_cancellation_reconciled", entityType: "issue", entityId: task.id, runId: run.id,
      details: { wakeId: wake.id, sourceActionId: source.id, stalledIssueId: input.stalledIssueId, stalledActionId: input.stalledActionId,
        pauseActivityId: pause.id, pausedByActorId: pause.actorId, snapshotOperationId: snapshot.id,
        sourceDescriptor: run.resultJson?.workspaceRestoreRecovery,
        sourceProof: snapshot.metadata?.sourceProof, archiveDescriptor: snapshot.metadata?.archive, leaseProof: leaseProof.value,
        endpointAttestation: source.evidence.sshRecoveryEndpointAttestation ?? null,
        snapshotSha256: (snapshot.metadata?.archive as { sha256?: unknown })?.sha256,
        cancellationSha256: identity.sha256, originalCancellationPreserved: true, dispatchCreated: false, sourceRecoveryStillRequired: true } });
    const [verified] = await tx.select({ valid: reconciledStallCancellation() }).from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    if (!verified?.valid) throw conflict("Reconciliation evidence did not verify; no disposition was committed.");
    return { alreadyReconciled: false, publication: activity.publication };
  });
  if (result.publication) publishActivity(result.publication);
  return { wakeId: input.wakeId, alreadyReconciled: result.alreadyReconciled, dispatchCreated: false, originalCancellationPreserved: true };
}
