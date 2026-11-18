import { assertMaintenanceAdmission, maintenanceClosed } from "./instance-maintenance.js";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueWorkflowHandoffs, issues, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import { EXECUTION_RECONCILIATION_INTERVAL_MS } from "./execution-control-deadline.js";
import { commitTaskWorkflowHandoff } from "./task-workflow-handoff.js";
import { recordRequiredWorkspaceRestoreFailure } from "./legacy-execution-recovery.js";
import { hasRequiredWorkspaceRecovery, LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";
import { parseRetainedSshWorkspaceSource } from "./retained-ssh-workspace-source.js";
import { verifiedSshWorkspacePreservationReceipt } from "./workspace-recovery-receipt.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { notifyDeferredWakesForIssue } from "./deferred-execution-notifications.js";
import { persistActivity, publishActivity } from "./activity-log.js";

/** Event-driven owner. Startup reconstructs durable intents; active turns and
 * held repair obligations cause no idle polling. Real cleanup/eligibility
 * changes signal a fresh bounded sweep. Never synthesizes a return proof. */
export function registerTaskWorkflowHandoffWork(db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun = () => true) {
  let cursor: string | undefined, more = false, stopped = false;
  let requested = 1, reconciled = 0, scanning = false, restart = false;
  const settleRow = async (row: typeof issueWorkflowHandoffs.$inferSelect) => {
    if (await maintenanceClosed(db)) return;
    if (row.state === "pending") await commitTaskWorkflowHandoff(db, row.companyId, row.sourceRunId);
    const [current] = await db.select().from(issueWorkflowHandoffs).where(and(
      eq(issueWorkflowHandoffs.companyId, row.companyId), eq(issueWorkflowHandoffs.id, row.id)));
    if (current?.state !== "held") return;
    const [source] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, row.companyId), eq(heartbeatRuns.id, row.sourceRunId)));
    if (!source || !["succeeded", "cancelled", "failed", "interrupted", "timed_out"].includes(source.status)) return;
    if (!hasRequiredWorkspaceRecovery(source.resultJson)) {
      const original = parseRetainedSshWorkspaceSource(current.intent.source);
      if (original.runId !== row.sourceRunId || original.leaseId !== row.leaseId || original.executionWorkspaceId !== row.workspaceId)
        throw Error("workflow_handoff_recovery_source_changed");
      await recordRequiredWorkspaceRestoreFailure(db, source, { workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA, leaseIds: [row.leaseId], source: original } });
      return;
    }
    // Preservation settles the canceled/failed obligation, never commits
    // the old proposal or revives its credentials. The original intent,
    // failure and recovered archive remain auditable.
    const activity = await db.transaction(async raw => {
      const tx = raw as unknown as Db;
      await assertMaintenanceAdmission(tx);
      const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, row.companyId), eq(issues.id, row.issueId))).for("update");
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, row.companyId), eq(heartbeatRuns.id, row.sourceRunId))).for("share", { noWait: true });
      const [intent] = await tx.select().from(issueWorkflowHandoffs).where(and(eq(issueWorkflowHandoffs.companyId, row.companyId), eq(issueWorkflowHandoffs.id, row.id))).for("update");
      const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, row.companyId), eq(environmentLeases.id, row.leaseId))).for("share", { noWait: true });
      if (!task || !run || intent?.state !== "held" || !lease || !hasRemoteTerminationReceipt(lease)
        || adapterExecutionControls.has(run.id) || run.controllerLeaseExpiresAt || run.runnerProfileJson?.nativeWorkspaceFinalizationOwner
        || !await verifiedSshWorkspacePreservationReceipt(tx, run)) return null;
      await tx.update(issueWorkflowHandoffs).set({ state: "revoked", updatedAt: new Date() }).where(eq(issueWorkflowHandoffs.id, row.id));
      if (task.executionRunId === run.id || task.checkoutRunId === run.id) await tx.update(issues).set({
        ...(task.executionRunId === run.id ? { executionRunId: null, executionAgentNameKey: null, executionLockedAt: null } : {}),
        ...(task.checkoutRunId === run.id ? { checkoutRunId: null } : {}), updatedAt: new Date(),
      }).where(and(eq(issues.companyId, row.companyId), eq(issues.id, row.issueId)));
      await notifyDeferredWakesForIssue(tx, { companyId: row.companyId, issueId: row.issueId });
      return persistActivity(tx, { companyId: row.companyId, actorType: "system", actorId: "workflow-owner",
        action: "issue.workflow_handoff_recovery_settled", entityType: "issue", entityId: row.issueId, runId: run.id,
        details: { handoffId: row.id, oldTransitionApplied: false, credentialsRevived: false } });
    });
    if (activity) publishActivity(activity.publication);
  };
  const requestScan = () => {
    requested += 1;
    // Complete pagination before revisiting newly inserted/changed earlier IDs.
    if (scanning || cursor !== undefined) restart = true;
  };
  const worker = coordinator.register(DELIVERY_QUEUES.taskWorkflowHandoff, {
    retryMs: EXECUTION_RECONCILIATION_INTERVAL_MS, coalesceMs: 50,
    pausePassiveMaintenance: true, runDuringDrain: true,
    onSettled: requestScan,
    run: async () => {
      if (stopped || !canRun()) return;
      const generation = requested; scanning = true;
      try {
        const rows = await db.select().from(issueWorkflowHandoffs).where(and(
          inArray(issueWorkflowHandoffs.state, ["pending", "held"]), cursor ? gt(issueWorkflowHandoffs.id, cursor) : undefined))
          .orderBy(asc(issueWorkflowHandoffs.id)).limit(100);
        more = rows.length === 100;
        for (const row of rows) {
          if (stopped || !canRun()) return;
          await settleRow(row); cursor = row.id;
        }
        if (!more) { cursor = undefined; if (restart) { restart = false; more = true; } }
        reconciled = generation;
      } finally { scanning = false; }
    },
    hasPending: async () => !stopped && (requested !== reconciled || more),
    nextRunAt: () => more ? Date.now() : null,
  });
  const subscriptions = [DELIVERY_QUEUES.environmentCleanup, DELIVERY_QUEUES.executionStatus,
    DELIVERY_QUEUES.nativeResultCommit, DELIVERY_QUEUES.deferredExecutionReceipts,
    DELIVERY_QUEUES.agentLifecycle, DELIVERY_QUEUES.executionFinalization].map(queue => subscribeDeliveryWork(db, queue,
      () => { requestScan(); worker.wake(); }));
  return { ready: worker.ready, wake() { requestScan(); worker.wake(); }, stop() {
    stopped = true; for (const unsubscribe of subscriptions) unsubscribe(); return worker.stop();
  } };
}
