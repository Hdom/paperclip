import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type issues, type Db } from "@paperclipai/db";
import { controllerExecutionProtected } from "@paperclipai/adapter-utils/controller-source-protection";

export const TASK_WORKSPACE_RETURN_DISPOSITION = "paperclip.task-workspace-return.v1";
/** Atomic issue-service receipt, never accepted from request/config JSON. It grants no upload or replay. */
export async function recordTaskWorkspaceReturnDisposition(db: Db, input: {
  before: typeof issues.$inferSelect; after: typeof issues.$inferSelect;
  actorAgentId?: string | null; actorRunId?: string | null;
}) {
  const { before, after, actorAgentId, actorRunId } = input;
  if (!controllerExecutionProtected() || !actorRunId || !actorAgentId || before.executionRunId !== actorRunId ||
      (before.checkoutRunId !== null && before.checkoutRunId !== actorRunId) ||
      before.assigneeAgentId !== actorAgentId || after.assigneeAgentId !== actorAgentId ||
      before.assigneeUserId !== after.assigneeUserId || before.companyId !== after.companyId ||
      before.executionWorkspaceId !== after.executionWorkspaceId || !after.executionWorkspaceId ||
      before.workspaceBindingRevision !== after.workspaceBindingRevision ||
      before.status !== "in_progress" || !["blocked", "done", "in_review"].includes(after.status) ||
      after.executionRunId !== null || after.checkoutRunId !== null) return;
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, before.companyId),
    eq(heartbeatRuns.id, actorRunId), eq(heartbeatRuns.agentId, actorAgentId))).for("update");
  if (!run || run.runtimeMode !== "legacy" || run.status !== "running" || run.finishedAt ||
      (run.issueId ?? run.contextSnapshot?.issueId) !== before.id ||
      run.contextSnapshot?.executionWorkspaceId !== after.executionWorkspaceId) return;
  const receipt = { schema: TASK_WORKSPACE_RETURN_DISPOSITION, companyId: before.companyId, issueId: before.id,
    agentId: actorAgentId, runId: actorRunId, workspaceId: after.executionWorkspaceId,
    workspaceBindingRevision: after.workspaceBindingRevision, fromStatusVersion: before.statusVersion,
    toStatusVersion: after.statusVersion, status: after.status };
  await db.update(heartbeatRuns).set({ runnerProfileJson: sql`jsonb_set(coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb),
    '{taskWorkspaceReturnDisposition}', ${JSON.stringify(receipt)}::jsonb)` }).where(and(
      eq(heartbeatRuns.companyId, before.companyId), eq(heartbeatRuns.id, actorRunId), eq(heartbeatRuns.status, "running")));
}
