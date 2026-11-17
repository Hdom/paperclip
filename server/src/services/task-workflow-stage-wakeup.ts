import type { IssueExecutionState } from "@paperclipai/shared";
type ParsedExecutionState = IssueExecutionState;
type ExecutionStageWakeContext = { wakeRole: "reviewer" | "approver" | "executor"; stageId: string | null; stageType: ParsedExecutionState["currentStageType"]; currentParticipant: ParsedExecutionState["currentParticipant"]; returnAssignee: ParsedExecutionState["returnAssignee"]; reviewRequest: ParsedExecutionState["reviewRequest"]; lastDecisionOutcome: ParsedExecutionState["lastDecisionOutcome"]; allowedActions: string[] };
function executionPrincipalsEqual(
  left: ParsedExecutionState["currentParticipant"] | null,
  right: ParsedExecutionState["currentParticipant"] | null,
) {
  if (!left || !right || left.type !== right.type) return false;
  return left.type === "agent"
    ? left.agentId === right.agentId
    : left.userId === right.userId;
}

function buildExecutionStageWakeContext(input: {
  state: ParsedExecutionState;
  wakeRole: ExecutionStageWakeContext["wakeRole"];
  allowedActions: string[];
}): ExecutionStageWakeContext {
  return {
    wakeRole: input.wakeRole,
    stageId: input.state.currentStageId,
    stageType: input.state.currentStageType,
    currentParticipant: input.state.currentParticipant,
    returnAssignee: input.state.returnAssignee,
    reviewRequest: input.state.reviewRequest ?? null,
    lastDecisionOutcome: input.state.lastDecisionOutcome,
    allowedActions: input.allowedActions,
  };
}

export function buildExecutionStageWakeup(input: {
  issueId: string;
  previousState: ParsedExecutionState | null;
  nextState: ParsedExecutionState | null;
  interruptedRunId: string | null;
  requestedByActorType: "user" | "agent";
  requestedByActorId: string;
}) {
  const { issueId, previousState, nextState, interruptedRunId } = input;
  if (!nextState) return null;

  if (nextState.status === "pending") {
    const agentId =
      nextState.currentParticipant?.type === "agent"
        ? (nextState.currentParticipant.agentId ?? null)
        : null;
    const stageChanged =
      previousState?.status !== "pending" ||
      previousState?.currentStageId !== nextState.currentStageId ||
      !executionPrincipalsEqual(
        previousState?.currentParticipant ?? null,
        nextState.currentParticipant ?? null,
      );
    if (!agentId || !stageChanged) return null;

    const reason =
      nextState.currentStageType === "approval"
        ? "execution_approval_requested"
        : "execution_review_requested";
    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole:
        nextState.currentStageType === "approval" ? "approver" : "reviewer",
      allowedActions: ["approve", "request_changes"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason,
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: reason,
          source: "issue.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  if (nextState.status === "changes_requested") {
    const agentId =
      nextState.returnAssignee?.type === "agent"
        ? (nextState.returnAssignee.agentId ?? null)
        : null;
    const becameChangesRequested =
      previousState?.status !== "changes_requested" ||
      previousState?.lastDecisionId !== nextState.lastDecisionId ||
      !executionPrincipalsEqual(
        previousState?.returnAssignee ?? null,
        nextState.returnAssignee ?? null,
      );
    if (!agentId || !becameChangesRequested) return null;

    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: "executor",
      allowedActions: ["address_changes", "resubmit"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason: "execution_changes_requested",
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "execution_changes_requested",
          source: "issue.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  return null;
}
