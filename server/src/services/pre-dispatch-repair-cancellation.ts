import { hasSuccessfulLegacyControllerSettlement } from "./legacy-controller-settlement.js";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED, recordedLocalExecutionStopped, hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";

type Run = typeof heartbeatRuns.$inferSelect;
const REASON = "issue_disposition_repair";
const SUPERSEDED = "issue_disposition_repair_superseded";
const MESSAGE = "Scheduled disposition repair suppressed because the source state changed or gained a durable path";
const EXECUTION_EVENTS = ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
  "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
  "provider.event", "provider.rpc_result", "tool.execution.started"];

function candidate(run: Run) {
  const c = run.contextSnapshot ?? {};
  return run.runtimeMode === "legacy" && run.status === "cancelled" && run.errorCode === SUPERSEDED
    && !!run.finishedAt && !!run.scheduledRetryAt && run.scheduledRetryAt <= run.finishedAt
    && run.scheduledRetryReason === REASON && run.scheduledRetryAttempt > 0
    && c.retryReason === REASON && c.dispositionRepairAttempt === run.scheduledRetryAttempt
    && typeof c.dispositionRepairFingerprint === "string" && !!c.dispositionRepairFingerprint
    && typeof c.issueId === "string" && (run.issueId === null || run.issueId === c.issueId)
    && (c.retryOfRunId ?? null) === run.retryOfRunId
    && run.startedAt === null && run.runtimeModeResolvedAt === null
    && run.processPid === null && run.processGroupId === null && run.processStartedAt === null
    && run.controllerBootId === null && run.controllerLeaseExpiresAt === null && run.executionStage === null
    && run.nativeIssueId === null && run.nativeSessionId === null && run.sessionIdAfter === null
    && run.runnerProfileJson === null && !run.stdoutExcerpt && !run.stderrExcerpt && !run.logRef && !run.logBytes
    && !run.resultJson?.startupCancellation && !run.resultJson?.cancellation
    && !run.resultJson?.workspaceRestoreFailure && !hasRequiredWorkspaceRecovery(run.resultJson);
}

/** Positive scheduler provenance, not missing PID fields. Called under the issue
 * and run locks. A suppressed repair cannot conceal an unsettled predecessor. */
export async function isPreDispatchRepairCancellationVerified(db: Db, run: Run): Promise<boolean> {
  if (!candidate(run)) return false;
  const issueId = run.contextSnapshot!.issueId;
  const visited = new Set<string>();
  let current: Run | undefined = run;
  for (let depth = 0; current && depth < 8; depth++) {
    if (visited.has(current.id) || current.companyId !== run.companyId || current.agentId !== run.agentId
      || (current.issueId ?? current.contextSnapshot?.issueId) !== issueId
      || adapterExecutionControls.has(current.id)) return false;
    visited.add(current.id);
    const [coordinator] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, current.id),
    )).limit(1);
    if (coordinator) return false;
    const leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, current.id),
    ));
    if (candidate(current)) {
      if (leases.length) return false;
      const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, current.id),
        or(isNotNull(heartbeatRunEvents.sourceEventId), inArray(heartbeatRunEvents.eventType, EXECUTION_EVENTS)),
      )).limit(1);
      if (execution) return false;
      const [wake] = current.wakeupRequestId ? await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.id, current.wakeupRequestId),
        eq(agentWakeupRequests.runId, current.id), eq(agentWakeupRequests.agentId, run.agentId),
        eq(agentWakeupRequests.status, "cancelled"), eq(agentWakeupRequests.reason, REASON),
        eq(agentWakeupRequests.requestedByActorType, "system"),
      )).limit(1) : [];
      if (!wake || wake.payload?.issueId !== issueId
        || wake.idempotencyKey !== `issue_disposition_repair:${issueId}:${current.contextSnapshot!.dispositionRepairFingerprint}:${current.scheduledRetryAttempt}`
        || wake.payload?.dispositionRepairFingerprint !== current.contextSnapshot!.dispositionRepairFingerprint
        || wake.payload?.dispositionRepairAttempt !== current.scheduledRetryAttempt
        || wake.finishedAt?.getTime() !== current.finishedAt?.getTime()) return false;
      const receipt = current.resultJson?.preDispatchScheduledRetryCancellation as Record<string, unknown> | undefined;
      const machineReceipt = receipt?.version === 1 && receipt.runId === current.id
        && receipt.previousStatus === "scheduled_retry" && receipt.errorCode === SUPERSEDED;
      if (!machineReceipt) {
        // Historical releases have an atomic system event from the same
        // scheduled_retry -> cancelled CAS, before any executor could claim it.
        const events = await db.select().from(heartbeatRunEvents).where(and(
          eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, current.id),
          eq(heartbeatRunEvents.agentId, run.agentId), eq(heartbeatRunEvents.eventType, "lifecycle"),
          eq(heartbeatRunEvents.stream, "system"), eq(heartbeatRunEvents.level, "warn"),
        ));
        if (current.error !== MESSAGE || !events.some(event => event.sourceEventId === null && event.message === MESSAGE
          && event.payload?.expectedFingerprint === current!.contextSnapshot?.dispositionRepairFingerprint
          && event.payload?.scheduledRetryReason === REASON
          && event.payload?.scheduledRetryAttempt === current!.scheduledRetryAttempt
          && event.payload?.scheduledRetryAt === current!.scheduledRetryAt?.toISOString())) return false;
      }
      if (!current.retryOfRunId) return true;
      [current] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, current.retryOfRunId),
      )).limit(1);
      if (!current) return false;
      continue;
    }
    // An actual earlier execution keeps its existing stop and cleanup burden.
    if (current.runtimeMode !== "legacy" || !current.finishedAt
      || !["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(current.status)
      || (current.controllerLeaseExpiresAt && current.controllerLeaseExpiresAt > new Date())
      || (current.controllerBootId && !current.controllerLeaseExpiresAt && !await hasSuccessfulLegacyControllerSettlement(db, current))
      || current.resultJson?.workspaceRestoreFailure || hasRequiredWorkspaceRecovery(current.resultJson)
      || leases.some(lease => !lease.releasedAt || ["active", "retained", "pending_cleanup"].includes(lease.status)
        || (lease.cleanupStatus !== null && lease.cleanupStatus !== "success"))) return false;
    if (leases.some(lease => lease.provider !== "local")) return leases.every(hasRemoteTerminationReceipt);
    // A historical stop receipt cannot override currently retained process
    // fields. Re-observe that exact host/process generation whenever present.
    return current.processPid || current.processGroupId
      ? await recordedLocalExecutionStopped(db, current)
      : await hasNativeLocalProcessStop(db, run.companyId, current.id);
  }
  return false;
}
