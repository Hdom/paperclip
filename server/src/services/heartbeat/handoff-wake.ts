import { PersistedExecutionWaitRefusal } from "../deferred-execution-wait.js";
import { createHash } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { parseIssueExecutionState } from "../issue-execution-policy.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { registerExecutionControlWork } from "../execution-control-work.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import type { WakeupOptions } from "./run-preparation.js";

// A known admission refusal whose original durable receipt remains pending.
export class HandoffWakeDeferred extends PersistedExecutionWaitRefusal {
  constructor(message: string, details?: unknown) { super(message, details); }
}

export const HANDOFF_WAKE_KEY = "_paperclipExecutionHandoff";
type Issue = Pick<typeof issues.$inferSelect, "id" | "companyId" | "statusVersion" | "status" | "assigneeAgentId" | "executionState">;
type Intent = { key: string; reason: string; sourceRunId: string };

export function readHandoffWake(payload: Record<string, unknown> | null): Intent | null {
  const intent = payload?.[HANDOFF_WAKE_KEY] as Partial<Intent> | undefined;
  return intent && typeof intent.key === "string" && typeof intent.reason === "string" &&
    typeof intent.sourceRunId === "string" ? intent as Intent : null;
}

export function handoffWakeKey(issue: Issue, agentId: string, reason: string | null): string | null {
  if (["done", "cancelled"].includes(issue.status)) return null;
  const state = parseIssueExecutionState(issue.executionState);
  if (reason === "issue_assigned") {
    if (issue.assigneeAgentId !== agentId) return null;
  } else if (reason === "execution_changes_requested") {
    if (state?.status !== "changes_requested" || state.returnAssignee?.agentId !== agentId) return null;
  } else if (reason === "execution_review_requested" || reason === "execution_approval_requested") {
    if (issue.status !== "in_review" || state?.status !== "pending" || state.currentParticipant?.agentId !== agentId ||
        state.currentStageType !== (reason === "execution_review_requested" ? "review" : "approval")) return null;
  } else return null;
  return createHash("sha256").update(JSON.stringify([
    issue.companyId, issue.id, issue.statusVersion, agentId, reason,
    state?.currentStageId, state?.currentParticipant, state?.lastDecisionId,
  ])).digest("hex");
}

export async function handoffSourceStopped(db: Db, companyId: string, issueId: string, sourceRunId: string) {
  if (!isUuidLike(sourceRunId)) return true;
  const [source] = await db.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, sourceRunId), eq(heartbeatRuns.companyId, companyId),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`,
  ));
  return !source || source.result?.executionHandoffStop !== undefined;
}

/** Caller owns task -> source-run locks. A later human Stop revokes only this
 * source's unadmitted handoffs, even if reassignment already terminalized it. */
export async function stopHandoffWakesForSource(tx: Db, companyId: string, issueId: string, sourceRunId: string) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionHandoff, companyId);
  await tx.update(heartbeatRuns).set({
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ executionHandoffStop: { requestedAt: new Date().toISOString() } })}::jsonb`,
  }).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, sourceRunId)));
  await tx.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date(),
    error: "Source execution handoff stopped by user",
  }).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    sql`${agentWakeupRequests.payload}->${HANDOFF_WAKE_KEY}->>'sourceRunId' = ${sourceRunId}`,
  ));
}

export async function deferHandoffWake(tx: Db, input: {
  issue: Issue; request: typeof agentWakeupRequests.$inferInsert; sourceRunId: string; key: string;
  context: Record<string, unknown>;
}) {
  // The issue lock serializes this with Stop; no late writer can revive it.
  if (await handoffSourceStopped(tx, input.issue.companyId, input.issue.id, input.sourceRunId)) return;
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionHandoff, input.issue.companyId);
  await tx.insert(agentWakeupRequests).values({
    ...input.request, reason: "execution_owner_active", status: "deferred_issue_execution",
    payload: { ...input.request.payload, issueId: input.issue.id, _paperclipWakeContext: input.context,
      [HANDOFF_WAKE_KEY]: { key: input.key, reason: input.request.reason, sourceRunId: input.sourceRunId } },
    runId: null, finishedAt: null,
  });
}

type Entry = { id: string; companyId: string; dueAt: number };
type Enqueue = (agentId: string, options: WakeupOptions, requestId?: string) => Promise<unknown>;

export function handoffWakeWork(db: Db, enqueue: Enqueue) {
  const pending = (companyId?: string, id?: string, after?: string, queryDb: Db = db) => queryDb.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload} ? ${HANDOFF_WAKE_KEY}`,
    companyId ? eq(agentWakeupRequests.companyId, companyId) : undefined,
    id ? eq(agentWakeupRequests.id, id) : undefined,
    after ? gt(agentWakeupRequests.id, after) : undefined,
  )).orderBy(asc(agentWakeupRequests.id)).limit(100);
  async function load(companyId?: string, signal?: AbortSignal): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (true) {
      if (signal?.aborted) throw new Error("Handoff wake discovery stopped");
      const rows = await pending(companyId, undefined, after);
      entries.push(...rows.map(row => ({ id: row.id, companyId: row.companyId, dueAt: Date.now() })));
      if (rows.length < 100) return entries;
      after = rows[rows.length - 1].id;
    }
  }
  async function check(entry: Entry): Promise<Entry | null> {
    const [observed] = await pending(entry.companyId, entry.id);
    if (!observed) return null;
    const wake = await db.transaction(async tx => {
      const issueId = observed.payload?.issueId;
      const [issue] = typeof issueId === "string" && isUuidLike(issueId)
        ? await tx.select({ id: issues.id, companyId: issues.companyId, status: issues.status,
          statusVersion: issues.statusVersion, assigneeAgentId: issues.assigneeAgentId, executionState: issues.executionState,
        }).from(issues).where(and(eq(issues.companyId, entry.companyId), eq(issues.id, issueId))).for("update")
        : [];
      const [current] = await pending(entry.companyId, entry.id, undefined, tx as unknown as Db);
      const intent = readHandoffWake(current?.payload ?? null);
      if (!current || !intent) return null;
      if (!issue || current.source !== "assignment" || intent.key !== handoffWakeKey(issue, current.agentId, intent.reason) ||
          await handoffSourceStopped(tx as unknown as Db, entry.companyId, issue.id, intent.sourceRunId)) {
        await tx.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date(),
          error: "Execution handoff no longer matches the current assignment or review stage",
        }).where(and(eq(agentWakeupRequests.companyId, entry.companyId), eq(agentWakeupRequests.id, current.id),
          eq(agentWakeupRequests.status, "deferred_issue_execution")));
        return null;
      }
      return current;
    });
    const intent = readHandoffWake(wake?.payload ?? null);
    if (!wake || !intent) return null;
    try { await enqueue(wake.agentId, {
      source: wake.source as WakeupOptions["source"], triggerDetail: wake.triggerDetail as WakeupOptions["triggerDetail"],
      reason: intent.reason, payload: wake.payload ?? {},
      contextSnapshot: wake.payload?._paperclipWakeContext as Record<string, unknown>,
      requestedByActorType: wake.requestedByActorType as WakeupOptions["requestedByActorType"],
      requestedByActorId: wake.requestedByActorId, idempotencyKey: wake.idempotencyKey,
    }, wake.id); } catch (error) {
      if (!(error instanceof PersistedExecutionWaitRefusal)) throw error;
    }
    return (await pending(entry.companyId, entry.id)).length ? { ...entry, dueAt: Date.now() + 30_000 } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    // Startup reconstructs receipts. Only unresolved durable work schedules a
    // deadline; retained settled history creates no idle scans.
    return registerExecutionControlWork(coordinator, [{
      queue: DELIVERY_QUEUES.executionHandoff,
      run: async signal => {
        const failures: unknown[] = [];
        for (const entry of await load(undefined, signal)) {
          if (signal?.aborted || !canRun()) break;
          try { await check(entry); } catch (error) { failures.push(error); }
        }
        // One refused/broken receipt must never starve other companies. Keep
        // unexpected failures visible and retry durable work through the owner.
        if (failures.length) throw new AggregateError(failures, "Execution handoff reconciliation failed");
      },
      next: async () => (await pending()).length ? Date.now() + 30_000 : null,
    }], canRun);
  }
  return { load, check, register };
}
