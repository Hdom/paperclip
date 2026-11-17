import { SystemRecoveryFailure } from "../../../services/system-recovery-state.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issues, workspaceOperations, type Db } from "@paperclipai/db";
import { retainedSshPreservationReceipt } from "../../../services/retained-ssh-workspace-preservation.js";
import { conflict } from "../../../errors.js";
import { persistActivity, publishActivity } from "../../../services/activity-log.js";
import { getExecutionBlocker } from "../../../services/execution-blocker.js";
import { verifyBlockerStallWake } from "../../../services/recovery/blocker-stall-wakeups.js";

/** Explicit operator disposition, not a retry/coalescing claim. Nothing dispatches.
 * Called from the reviewed controller operator utility, never agent/config JSON.
 */
export async function retireDeferredBlockerStallWake(db: Db, input: {
  companyId: string; issueId: string; runId: string; sourceActionId: string;
  wakeId: string; stalledIssueId: string; stalledActionId: string; actorId: string;
}) {
  const result = await db.transaction(async tx => {
    const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("update");
    const [source] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.sourceActionId))).for("update");
    const [wake] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.wakeId))).for("update");
    if (!task || !run || !source || !wake || source.evidence.runId !== run.id || !run.finishedAt ||
        task.executionRunId || task.checkoutRunId || (run.issueId ?? run.contextSnapshot?.issueId) !== task.id ||
        wake.agentId !== task.assigneeAgentId || wake.agentId !== run.agentId || wake.payload?.issueId !== task.id ||
        wake.requestedByActorType !== "system" || wake.requestedByActorId !== "issue-blocker-stall" || wake.source !== "automation" ||
        wake.payload?.stalledIssueId !== input.stalledIssueId || (wake.payload?.recoveryAction as { id?: unknown } | undefined)?.id !== input.stalledActionId)
      throw conflict("The deferred stall notification changed; inspect it again before disposition.");
    if (wake.status === "cancelled" && wake.error === "operator_retired_stall_after_source_preservation_plan") {
      const [receipt] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.companyId, input.companyId), eq(activityLog.actorType, "user"), eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId), eq(activityLog.runId, input.runId), eq(activityLog.action, "issue.deferred_stall_retired"),
        sql`${activityLog.details}->>'wakeId' = ${wake.id}`,
        sql`${activityLog.details}->>'sourceActionId' = ${source.id}`,
        sql`${activityLog.details}->>'stalledIssueId' = ${input.stalledIssueId}`,
        sql`${activityLog.details}->>'stalledActionId' = ${input.stalledActionId}`)).limit(1);
      if (!receipt) throw conflict("Notification cancellation has no matching retirement receipt; inspect it before recovery.");
      return { alreadyRetired: true, publication: null };
    }
    const context = wake.payload?._paperclipWakeContext as Record<string, unknown> | undefined;
    if (wake.status !== "deferred_issue_execution" || wake.runId || context?.wakeReason !== "issue_blocker_stalled" ||
        !await verifyBlockerStallWake(tx as unknown as Db, { companyId: input.companyId, issueId: input.issueId,
          contextSnapshot: context, requestedByActorType: "system" })) throw conflict("The deferred stall notification is no longer the verified pending incident.");
    const blocker = await getExecutionBlocker(tx as unknown as Db, input.companyId, input.issueId);
    if (blocker?.recoveryActionId !== source.id || blocker.runId !== run.id || blocker.workspaceRepairRequired !== true)
      throw conflict("Source recovery must remain held while retiring its notification.");
    const saved = await tx.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.issueId, input.issueId),
      eq(workspaceOperations.heartbeatRunId, input.runId), eq(workspaceOperations.phase, "workspace_recovery_snapshot"),
      eq(workspaceOperations.status, "succeeded"), sql`${workspaceOperations.metadata}->>'recoveryActionId' = ${source.id}`));
    if (!await retainedSshPreservationReceipt(tx as unknown as Db, { companyId: input.companyId, issueId: input.issueId,
      runId: input.runId, actionId: source.id, operationIds: saved.map(row => row.id) }))
      throw conflict("Verify an immutable snapshot of the exact retained source before retiring its notification.");
    const [live] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
      sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`)).limit(1);
    if (live) throw conflict("Task execution is active; the notification was left untouched.");
    const [changed] = await tx.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date(),
      error: "operator_retired_stall_after_source_preservation_plan" }).where(and(eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId))).returning({ id: agentWakeupRequests.id });
    if (!changed) throw conflict("Notification ownership changed; disposition was not applied.");
    const activity = await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "user", actorId: input.actorId,
      action: "issue.deferred_stall_retired", entityType: "issue", entityId: input.issueId, runId: input.runId,
      details: { wakeId: wake.id, sourceActionId: source.id, stalledIssueId: input.stalledIssueId, stalledActionId: input.stalledActionId,
        dispatchCreated: false, sourceRecoveryStillRequired: true } });
    return { alreadyRetired: false, publication: activity.publication };
  });
  if (result.publication) publishActivity(result.publication);
  return { wakeId: input.wakeId, alreadyRetired: result.alreadyRetired, dispatchCreated: false };
}

/** A preservation receipt cannot silently promote an old system stall notification. */
export async function assertNoPendingDeferredBlockerStall(tx: Db, companyId: string, issueId: string) {
  const [pending] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.requestedByActorType, "system"),
    eq(agentWakeupRequests.requestedByActorId, "issue-blocker-stall"),
    inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`)).limit(1);
  if (pending) throw new SystemRecoveryFailure("effect_unresolved", "user_action_required", "Preserved output remains held until the pending stall notification is explicitly reconciled.");
}
