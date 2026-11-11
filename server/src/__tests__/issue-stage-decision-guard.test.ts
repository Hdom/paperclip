import { describe, expect, it } from "vitest";
import { assertStageDecisionRequest, assertStageDecisionSnapshot } from "../services/issue-stage-decision-guard.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
const policy = normalizeIssueExecutionPolicy({ stages: [{ type: "approval", participants: [{ type: "user", userId: "owner" }] }] })!;
const state = { status: "pending", currentStageId: policy.stages[0].id, currentStageType: "approval", currentStageIndex: 0,
  currentParticipant: { type: "user", userId: "owner" }, returnAssignee: null, completedStageIds: [], lastDecisionId: null,
  lastDecisionOutcome: null, changesRequestedCount: 0 };
const issue = { status: "in_review", statusVersion: 3, executionPolicy: policy, executionState: state, assigneeUserId: "owner" };
const guard = { expectedExecutionStageId: policy.stages[0].id, expectedDecisionStatusVersion: 3,
  expectedDecisionLastDecisionId: null, expectedPlanRevisionId: null };
const request = { ...guard, status: "done", comment: "Reviewed" };
describe("explicit stage decision guard", () => {
  it("does not change legacy requests", () => expect(assertStageDecisionRequest({ status: "done" })).toBeNull());
  it("requires every precondition and a decision note", () => {
    expect(assertStageDecisionRequest(request)).toEqual(request);
    for (const key of Object.keys(request)) {
      const partial = { ...request } as Record<string, unknown>; delete partial[key];
      expect(() => assertStageDecisionRequest(partial)).toThrow();
    }
    expect(() => assertStageDecisionRequest({ ...request, comment: " " })).toThrow();
  });
  it("cannot smuggle policy, ownership, attribution or board override fields", () => {
    for (const key of ["executionPolicy", "assigneeUserId", "onBehalfOfUserId", "expectedStatusVersion", "reviewInteractionId"]) {
      expect(() => assertStageDecisionRequest({ ...request, [key]: "other" })).toThrow();
    }
    expect(() => assertStageDecisionRequest({ ...request, status: "cancelled" })).toThrow();
  });
  it("accepts the active participant and supports request changes", () => {
    expect(() => assertStageDecisionSnapshot(issue, guard, { userId: "owner" })).not.toThrow();
    expect(assertStageDecisionRequest({ ...request, status: "in_progress" })).not.toBeNull();
  });
  it("rejects wrong actor, ended stage, changed stage and stale version", () => {
    expect(() => assertStageDecisionSnapshot(issue, guard, { userId: "other" })).toThrow();
    expect(() => assertStageDecisionSnapshot(issue, guard, { agentId: "owner" })).toThrow();
    expect(() => assertStageDecisionSnapshot({ ...issue, status: "done" }, guard, { userId: "owner" })).toThrow();
    expect(() => assertStageDecisionSnapshot(issue, { ...guard, expectedExecutionStageId: "other" }, { userId: "owner" })).toThrow();
    expect(() => assertStageDecisionSnapshot({ ...issue, statusVersion: 4 }, guard, { userId: "owner" })).toThrow();
  });
  it("rejects the same stage recycled with unchanged status/assignment", () => {
    const recycled = { ...issue, executionState: { ...state, lastDecisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } };
    expect(() => assertStageDecisionSnapshot(recycled, guard, { userId: "owner" })).toThrow();
  });
  it("rechecks policy and state under lock before applying a precomputed transition", () => {
    expect(() => assertStageDecisionSnapshot({ ...issue, executionPolicy: { ...policy, maxReviewRounds: 9 } }, guard, { userId: "owner" }, issue)).toThrow();
    expect(() => assertStageDecisionSnapshot({ ...issue, executionState: { ...state, changesRequestedCount: 1 } }, guard, { userId: "owner" }, issue)).toThrow();
    expect(() => assertStageDecisionSnapshot(issue, guard, { userId: "owner" }, issue)).not.toThrow();
  });
});
