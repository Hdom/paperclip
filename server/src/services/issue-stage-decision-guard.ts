import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { documents, issueDocuments, type Db } from "@paperclipai/db";
import { conflict, unprocessable } from "../errors.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

type DecisionGuard = {
  expectedExecutionStageId: string;
  expectedDecisionStatusVersion: number;
  expectedDecisionLastDecisionId: string | null;
  expectedPlanRevisionId: string | null;
};
type Snapshot = {
  status?: string;
  statusVersion?: number;
  executionState?: unknown;
  executionPolicy?: unknown;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

/** This narrow opt-in contract cannot be combined with board override fields. */
export function assertStageDecisionRequest(body: Record<string, unknown>): DecisionGuard | null {
  const fields = ["expectedExecutionStageId", "expectedDecisionStatusVersion", "expectedDecisionLastDecisionId", "expectedPlanRevisionId"];
  if (!fields.some((field) => body[field] !== undefined)) return null;
  const allowed = new Set([...fields, "status", "comment"]);
  if (typeof body.expectedExecutionStageId !== "string"
    || typeof body.expectedDecisionStatusVersion !== "number"
    || !(body.expectedDecisionLastDecisionId === null || typeof body.expectedDecisionLastDecisionId === "string")
    || !(body.expectedPlanRevisionId === null || typeof body.expectedPlanRevisionId === "string")
    || !["done", "in_progress"].includes(String(body.status))
    || typeof body.comment !== "string" || !body.comment.trim()
    || Object.keys(body).some((key) => !allowed.has(key))) {
    throw unprocessable("A stage decision requires its stage, status version, plan revision (or null), decision status and note only");
  }
  return body as DecisionGuard;
}

/** Called before work and again under the issue lock, before any decision writes. */
export function assertStageDecisionSnapshot(
  issue: Snapshot | null,
  guard: DecisionGuard,
  actor: { agentId?: string | null; userId?: string | null },
  initial?: Snapshot,
) {
  const state = parseIssueExecutionState(issue?.executionState);
  const participant = state?.currentParticipant;
  const actorMatches = participant?.type === "user"
    ? !!actor.userId && actor.userId === participant.userId
    : participant?.type === "agent" && !!actor.agentId && actor.agentId === participant.agentId;
  if (!issue || issue.status !== "in_review" || state?.status !== "pending"
    || state.currentStageId !== guard.expectedExecutionStageId || !actorMatches
    || issue.statusVersion !== guard.expectedDecisionStatusVersion
    || (state.lastDecisionId ?? null) !== guard.expectedDecisionLastDecisionId
    || (initial && (!isDeepStrictEqual(issue.executionState, initial.executionState)
      || !isDeepStrictEqual(issue.executionPolicy, initial.executionPolicy)
      || issue.assigneeAgentId !== initial.assigneeAgentId
      || issue.assigneeUserId !== initial.assigneeUserId))) {
    throw conflict("This review or approval stage has changed. Reload the task and decide again.", {
      code: "stage_decision_changed",
      expectedExecutionStageId: guard.expectedExecutionStageId,
    });
  }
}

/** Caller holds the issue row lock, also acquired by plan create/write/restore/delete. */
export async function readPlanRevisionForDecision(db: Db, companyId: string, issueId: string) {
  const [plan] = await db.select({ revisionId: documents.latestRevisionId })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(eq(issueDocuments.companyId, companyId), eq(documents.companyId, companyId),
      eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, "plan")));
  return plan?.revisionId ?? null;
}
