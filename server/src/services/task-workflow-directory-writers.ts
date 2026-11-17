import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, type Db } from "@paperclipai/db";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { hasPendingRunCleanup } from "./execution-blocker.js";
import { hasRemoteTerminationReceipt, remoteTerminationReceiptSql } from "./remote-execution-termination.js";

/** Caller owns the exact directory publication lock, then the source task/run
 * locks. Earlier attempts and alternate workspace records can share a native
 * directory; source-run stop alone does not prove every writer is gone. */
export async function hasCompetingTaskWorkflowWriter(db: Db, input: {
  companyId: string; sourceRunId: string; workspaceId: string; cwd: string;
}): Promise<boolean> {
  const roots = await db.select({ id: executionWorkspaces.id, companyId: executionWorkspaces.companyId })
    .from(executionWorkspaces).where(or(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.cwd, input.cwd)))
    .limit(101).for("share", { noWait: true });
  if (!roots.length || roots.length > 100 || roots.some(root => root.companyId !== input.companyId)) return true;
  const ids = roots.map(root => root.id);
  const references = sql`ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::text[]`;
  // Bound only unresolved writer candidates, not the lifetime task history.
  const activeControls = [...adapterExecutionControls.keys()];
  const potential = or(
    sql`${heartbeatRuns.finishedAt} is null or ${heartbeatRuns.status} not in ('succeeded','failed','cancelled','timed_out','interrupted')`,
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceFinalizationOwner' is not null and ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceFinalizationOwner' <> 'null'::jsonb`,
    sql`${heartbeatRuns.controllerLeaseExpiresAt} is not null`,
    activeControls.length ? inArray(heartbeatRuns.id, activeControls) : undefined,
    sql`exists (select 1 from environment_leases writer where writer.heartbeat_run_id = ${heartbeatRuns.id}
      and (coalesce(writer.metadata->>'pendingCleanupInFlight', 'false') <> 'false'
        or not coalesce((writer.provider = 'local' and writer.released_at is not null and writer.cleanup_status = 'success'
          and writer.status in ('released','expired','failed')) or (${sql.raw(remoteTerminationReceiptSql("writer"))}), false)))`,
    sql`exists (select 1 from native_run_finalizations writer where writer.run_id = ${heartbeatRuns.id}
      and (writer.lease_owner is not null or writer.phase not in ('committed','applied','terminal_failure')))`,
    sql`exists (select 1 from issue_workflow_handoffs writer where writer.source_run_id = ${heartbeatRuns.id} and writer.state in ('pending','held'))`,
  );
  const others = await db.select().from(heartbeatRuns).where(and(ne(heartbeatRuns.id, input.sourceRunId), potential, or(
    sql`${heartbeatRuns.contextSnapshot}->>'executionWorkspaceId' = ANY(${references})`,
    sql`${heartbeatRuns.runnerProfileJson}#>>'{nativeExecutionInput,binding,workspaceId}' = ANY(${references})`,
    sql`${heartbeatRuns.runnerProfileJson}#>>'{nativeExecutionInput,binding,executionWorkspaceId}' = ANY(${references})`,
    sql`${heartbeatRuns.runnerProfileJson}#>>'{nativeExecutionInput,workspace,cwd}' = ${input.cwd}`,
    sql`${heartbeatRuns.runnerProfileJson}#>>'{nativeExecutionInput,workspace,id}' = ANY(${references})`,
    sql`exists (select 1 from environment_leases writer where writer.heartbeat_run_id = ${heartbeatRuns.id}
      and writer.execution_workspace_id::text = ANY(${references}))`,
  ))).limit(101).for("share", { noWait: true });
  if (others.length > 100) return true;
  for (const run of others) {
    if (!run.finishedAt || ["queued", "running", "scheduled_retry"].includes(run.status)
      || run.runnerProfileJson?.nativeWorkspaceFinalizationOwner || run.controllerLeaseExpiresAt
      || adapterExecutionControls.has(run.id) || await hasPendingRunCleanup(db, run.companyId, run.id)) return true;
    const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, run.id)).limit(101).for("share", { noWait: true });
    if (leases.length > 100 || leases.some(lease => !lease.releasedAt || ["active", "pending_cleanup"].includes(lease.status)
      || lease.cleanupStatus === "failed" || lease.metadata?.pendingCleanupInFlight
      || lease.provider !== "local" && !hasRemoteTerminationReceipt(lease))) return true;
  }
  return false;
}
