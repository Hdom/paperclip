import { isDeepStrictEqual } from "node:util";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { buildExecutionStageWakeup } from "./task-workflow-stage-wakeup.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issueWorkflowHandoffs, type Db } from "@paperclipai/db";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { readRunCancellation } from "./run-cancellation.js";

export const WORKFLOW_PATCH_KEYS = ["status", "assigneeAgentId", "assigneeUserId", "executionState", "executionPolicy",
  "monitorNextCheckAt", "monitorWakeRequestedAt", "monitorNotes", "monitorScheduledBy"] as const;
export const WORKFLOW_HANDOFF_SCHEMA = "paperclip.task-workflow-handoff.v1";
export const WORKFLOW_RETURN_SCHEMA = "paperclip.task-workflow-return.v1";
export function taskWorkflowSnapshot(task: Record<string, unknown>) {
  return Object.fromEntries(["id", "companyId", "status", "statusVersion", "assigneeAgentId", "assigneeUserId",
    "executionRunId", "checkoutRunId", "executionWorkspaceId", "workspaceBindingRevision", "projectId", "projectWorkspaceId",
    "parentId", "executionPolicy", "executionState", "reviewPolicy", "visibility", "privacyRootIssueId", "responsibleUserId",
    "monitorNextCheckAt", "monitorWakeRequestedAt", "monitorLastTriggeredAt", "monitorAttemptCount", "monitorNotes", "monitorScheduledBy",
  ].map(key => [key, task[key] instanceof Date ? (task[key] as Date).toISOString() : task[key] ?? null]));
}
export const taskWorkflowFingerprint = (task: Record<string, unknown>) => nativeSha256(taskWorkflowSnapshot(task));
export function workflowHandoffRevoked(run: Pick<typeof heartbeatRuns.$inferSelect, "status" | "resultJson">) {
  return run.status === "cancelled" || Boolean(run.resultJson?.startupCancellation || run.resultJson?.nativeCancellation
    || run.resultJson?.executionCancellation || readRunCancellation(run.resultJson));
}
/** A shared admission/claim guard; it never gives the original agent new write authority. */
export async function workflowHandoffBlocksRun(db: Db, companyId: string, runId: string) {
  const [row] = await db.select({ state: issueWorkflowHandoffs.state, status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson })
    .from(issueWorkflowHandoffs).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, issueWorkflowHandoffs.sourceRunId)))
    .where(and(eq(issueWorkflowHandoffs.companyId, companyId), eq(issueWorkflowHandoffs.sourceRunId, runId), inArray(issueWorkflowHandoffs.state, ["pending", "held"]))).limit(1);
  return Boolean(row);
}
export async function pendingTaskWorkflowHandoff(db: Db, companyId: string, issueId: string) {
  const [row] = await db.select().from(issueWorkflowHandoffs).where(and(eq(issueWorkflowHandoffs.companyId, companyId),
    eq(issueWorkflowHandoffs.issueId, issueId), inArray(issueWorkflowHandoffs.state, ["pending", "held"]))).limit(1);
  return row ?? null;
}
export async function notifyWorkflowHandoff(db: Db) {
  const { notifyDeliveryWork } = await import("./delivery-work-notifications.js");
  await notifyDeliveryWork(db, "task-workflow-handoff");
}

/** Read-only proof check. Caller owns the task row lock and uses the exact saved
 * wake receipt; payload presence alone never authorizes an assignment. */
export async function committedTaskWorkflowWakeMatches(db: Db, task: Record<string, unknown>, wake: {
  id: string; companyId: string; agentId: string; source: string; triggerDetail: string | null;
  reason: string | null; requestedByActorType: string | null; requestedByActorId: string | null;
  idempotencyKey: string | null; payload: Record<string, unknown> | null; runId: string | null;
}) {
  const id = wake.payload?.workflowHandoffId;
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id) || wake.companyId !== task.companyId || wake.runId) return false;
  const [handoff] = await db.select().from(issueWorkflowHandoffs).where(and(eq(issueWorkflowHandoffs.companyId, wake.companyId),
    eq(issueWorkflowHandoffs.issueId, String(task.id)), eq(issueWorkflowHandoffs.id, id))).for("share", { noWait: true });
  if (!handoff || handoff.state !== "committed" || !handoff.committedAt ||
    handoff.returnProof?.successorWakeId !== wake.id || handoff.returnProof?.committedTaskSha256 !== taskWorkflowFingerprint(task)
    || task.assigneeAgentId !== wake.agentId || task.assigneeUserId || handoff.workspaceId !== task.executionWorkspaceId
    || wake.source !== "assignment" || wake.triggerDetail !== "system" || wake.requestedByActorType !== "agent"
    || wake.requestedByActorId !== handoff.agentId || wake.idempotencyKey !== `workflow-handoff:${id}`) return false;
  const previous = handoff.intent.task as Record<string, unknown> | undefined;
  const expected = buildExecutionStageWakeup({ issueId: String(task.id), previousState: parseIssueExecutionState(previous?.executionState),
    nextState: parseIssueExecutionState(task.executionState), interruptedRunId: null,
    requestedByActorType: "agent", requestedByActorId: handoff.agentId });
  return Boolean(expected && expected.agentId === wake.agentId && expected.wakeup.reason === wake.reason
    && wake.payload?.issueId === task.id && wake.payload?.mutation === "update"
    && isDeepStrictEqual(wake.payload?.executionStage, expected.wakeup.payload.executionStage)
    && isDeepStrictEqual(wake.payload?._paperclipWakeContext, expected.wakeup.contextSnapshot));
}
