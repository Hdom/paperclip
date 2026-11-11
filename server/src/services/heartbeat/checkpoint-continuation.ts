import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issues } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { conflict, forbidden, notFound } from "../../errors.js";

export const CHECKPOINT_CONTINUATION_MAX_ATTEMPTS = 3;
export const checkpointContinuationSchema = z.object({
  version: z.literal(1),
  summary: z.string().trim().min(1).max(4000),
  nextAction: z.string().trim().min(1).max(4000),
}).strict();

type Run = typeof heartbeatRuns.$inferSelect;

// These fields are controller-owned. An invalid counter must never reset a chain.
export function checkpointContinuationAttempts(context: Run["contextSnapshot"]): number | null {
  const value = context?.checkpointContinuationAttempts;
  return value === undefined ? 0
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function isOrdinaryLegacyCheckpointRun(run: Run): boolean {
  const context = run.contextSnapshot ?? {};
  const reason = String(context.wakeReason ?? "");
  return run.runtimeMode === "legacy" && run.scopeKind === "issue" && !!run.issueId
    && context.issueId === run.issueId && !run.runnerProfileJson?.nativeExecutionInput
    && !context.recovery && !context.recoveryIntent
    && context.allowDeliverableWork !== false && context.allowDocumentUpdates !== false
    && context.resumeRequiresNormalModel !== true
    && !reason.includes("recovery") && !reason.includes("disposition_repair")
    && !context.explicitUserContinuation && !context.chatCompletionDeliveryIds;
}

/** Records intent only. Completion and dispatch retain execution authority. */
export async function requestCheckpointContinuation(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string;
  request: z.infer<typeof checkpointContinuationSchema>;
}) {
  const request = checkpointContinuationSchema.parse(input.request);
  return db.transaction(async tx => {
    // Same issue-then-run lock order as Stop, completion and retry admission.
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
    )).for("update");
    if (!issue) throw notFound("Issue not found");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    )).for("update");
    if (!run || run.agentId !== input.agentId || run.issueId !== issue.id
      || !isOrdinaryLegacyCheckpointRun(run)) {
      throw forbidden("Checkpoint continuation requires this agent's ordinary legacy task run");
    }
    if (run.status !== "running" || issue.status !== "in_progress"
      || issue.assigneeAgentId !== input.agentId || issue.assigneeUserId
      || issue.executionRunId !== run.id
      || (issue.checkoutRunId !== null && issue.checkoutRunId !== run.id)) {
      throw conflict("Checkpoint continuation no longer owns active task execution");
    }
    const attempts = checkpointContinuationAttempts(run.contextSnapshot);
    if (attempts === null || attempts >= CHECKPOINT_CONTINUATION_MAX_ATTEMPTS)
      throw conflict("Checkpoint continuation limit reached or invalid");
    const previous = run.contextSnapshot?.checkpointContinuationRequest;
    if (previous) {
      const saved = previous as Record<string, unknown>;
      if (saved.sourceRunId !== run.id || saved.version !== request.version
        || saved.summary !== request.summary || saved.nextAction !== request.nextAction)
        throw conflict("A different checkpoint is already registered for this run");
      return { accepted: true, sourceRunId: run.id, maxAttempts: CHECKPOINT_CONTINUATION_MAX_ATTEMPTS };
    }
    const now = new Date();
    await tx.update(heartbeatRuns).set({ contextSnapshot: {
      ...run.contextSnapshot,
      checkpointContinuationRequest: { ...request, sourceRunId: run.id, requestedAt: now.toISOString() },
    }, updatedAt: now }).where(eq(heartbeatRuns.id, run.id));
    // Atomic audit record; no comment or generic wake is manufactured.
    await tx.insert(activityLog).values({ companyId: run.companyId, actorType: "agent",
      actorId: input.agentId, agentId: input.agentId, runId: run.id,
      action: "issue.checkpoint_continuation_requested", entityType: "issue", entityId: issue.id,
      details: { sourceRunId: run.id, attempt: attempts + 1 },
    });
    return { accepted: true, sourceRunId: run.id, maxAttempts: CHECKPOINT_CONTINUATION_MAX_ATTEMPTS };
  });
}
