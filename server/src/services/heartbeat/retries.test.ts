import { recoveryService } from "../recovery/service.js";
import { requestCheckpointContinuation } from "./checkpoint-continuation.js";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog, environmentLeases, agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunEvents, heartbeatRuns, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { HttpError } from "../../errors.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createRunDispatch, isResolvedInteractionContinuationWakeContext, type PostCommitEffect } from "../../modules/run-dispatch/index.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import * as legacy from "../heartbeat.js";
import { createHeartbeatRunState } from "./run-state.js";
import { pendingCaseHandoffForRun } from "./case-handoff-lifecycle.js";
import * as extracted from "./retries.js";
import type { HeartbeatRetryDependencies } from "./retries.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;

function callbacks() {
  return {
    hasCaseHandoffForRun: vi.fn<HeartbeatRetryDependencies["hasCaseHandoffForRun"]>(async () => false),
    getRun: vi.fn<HeartbeatRetryDependencies["getRun"]>(async () => null),
    getAgent: vi.fn<HeartbeatRetryDependencies["getAgent"]>(async () => undefined),
    resolveSessionBeforeForWakeup: vi.fn(async () => null),
    resolveResponsibleUserIdForRunContext: vi.fn(async () => "retry-user"),
    getAgentInvokability: vi.fn<HeartbeatRetryDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    appendRunEvent: vi.fn<HeartbeatRetryDependencies["appendRunEvent"]>(async () => undefined),
    escalatePlanApprovalResumeFailureNeedsAttention: vi.fn(async () => null),
    recordPlanApprovalResumeFailureRetry: vi.fn(async () => null),
    setRunStatusIfRunning: vi.fn<HeartbeatRetryDependencies["setRunStatusIfRunning"]>(async () => ({ updated: false, run: null })),
    setWakeupStatus: vi.fn(async () => undefined),
    releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
    finalizeAgentStatus: vi.fn(async () => undefined),
    getWorktreeExecutionCutoff: vi.fn(async (): Promise<Date | null> => null),
    applyRunDispatchPostCommitEffects: vi.fn<(effects: PostCommitEffect[]) => void>(),
    runDispatch: {
      nextScheduledRetryAt: vi.fn(async () => null),
      evaluateScheduledRetryGate: vi.fn<HeartbeatRetryDependencies["runDispatch"]["evaluateScheduledRetryGate"]>(async () => ({ allowed: true })),
      promoteDueScheduledRetries: vi.fn<HeartbeatRetryDependencies["runDispatch"]["promoteDueScheduledRetries"]>(async () => ({ promoted: 0, runIds: [], postCommitEffects: [] })),
      promoteScheduledRetry: vi.fn<HeartbeatRetryDependencies["runDispatch"]["promoteScheduledRetry"]>(async () => ({ outcome: "not_promoted" })),
    },
  } satisfies HeartbeatRetryDependencies;
}

// These tests must never query: only the injected lifecycle callbacks may run.
function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected retry database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

function unitRun(): Run {
  const run: Partial<Run> = {
    id: "run", companyId: "company", agentId: "agent", status: "running",
    scopeKind: "issue", issueId: "issue",
    wakeupRequestId: "wake", scheduledRetryAttempt: 0,
    contextSnapshot: { issueId: "issue", timerClaimWasFirstHeartbeat: true },
  };
  return run as Run;
}

function deferral() {
  return new extracted.WorkspaceBusyDeferral({
    holder: { runId: "holder", agentId: "other-agent", issueId: "other-issue", issueIdentifier: "T-2" },
    projectWorkspaceId: "workspace", deferralAttempt: 0, wasIssueAssignee: true,
  });
}

describe("heartbeat retry module callbacks", () => {
  it("preserves legacy helper and error-class identity", () => {
    expect(legacy.computeBoundedTransientHeartbeatRetrySchedule).toBe(extracted.computeBoundedTransientHeartbeatRetrySchedule);
    expect(legacy.computeWorkspaceBusyRetryDelayMs).toBe(extracted.computeWorkspaceBusyRetryDelayMs);
    expect(legacy.BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS).toBe(extracted.BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS);
    expect(legacy.WorkspaceBusyDeferral).toBe(extracted.WorkspaceBusyDeferral);
    expect(deferral()).toBeInstanceOf(legacy.WorkspaceBusyDeferral);
  });

  it("constructs without database access or lifecycle effects", () => {
    const database = guardedDatabase();
    const deps = callbacks();
    extracted.createHeartbeatRetries(database.db, deps);
    expect(database.access).not.toHaveBeenCalled();
    for (const callback of Object.values(deps)) {
      if (typeof callback === "function") expect(callback).not.toHaveBeenCalled();
    }
    for (const callback of Object.values(deps.runDispatch)) expect(callback).not.toHaveBeenCalled();
  });

  it.each(["missing_run", "missing_agent"] as const)("keeps %s lookup behavior and requests the full source result", async (outcome) => {
    const database = guardedDatabase();
    const deps = callbacks();
    if (outcome === "missing_agent") deps.getRun.mockResolvedValue(unitRun());
    expect(await extracted.createHeartbeatRetries(database.db, deps).scheduleBoundedRetry("run")).toEqual({ outcome });
    expect(deps.getRun).toHaveBeenCalledWith("run", { unsafeFullResultJson: true });
    expect(deps.getAgent).toHaveBeenCalledTimes(outcome === "missing_agent" ? 1 : 0);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("records exhaustion before escalating a plan-resume failure", async () => {
    const database = guardedDatabase();
    const deps = callbacks();
    const run = unitRun();
    const retry = await extracted.createHeartbeatRetries(database.db, deps).scheduleBoundedRetryForRun(
      run, { adapterType: "codex_local" } as Agent,
      { retryReason: legacy.INTERACTION_CONTINUATION_INFRA_RETRY_REASON, maxAttempts: 0 },
    );
    expect(retry).toMatchObject({ outcome: "retry_exhausted", attempt: 1, maxAttempts: 0 });
    expect(deps.appendRunEvent).toHaveBeenCalledWith(run, expect.objectContaining({
      retryExhaustion: { retryReason: legacy.INTERACTION_CONTINUATION_INFRA_RETRY_REASON, scheduledRetryAttempt: 0, maxAttempts: 0 },
    }));
    expect(deps.escalatePlanApprovalResumeFailureNeedsAttention).toHaveBeenCalledAfter(deps.appendRunEvent);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("gives every caller the Runner wait budget for a Runner mismatch and reports its exhaustion", async () => {
    const database = guardedDatabase();
    const deps = callbacks();
    const run = { ...unitRun(), status: "failed", errorCode: "runner_revision_mismatch", scheduledRetryReason: "runner_revision_wait", scheduledRetryAttempt: 10,
      contextSnapshot: { issueId: "issue", executionRetryAccounting: { version: 1, failureRetries: 0, maxTurnContinuations: 0 } } } as Run;
    const retry = await extracted.createHeartbeatRetries(database.db, deps).scheduleBoundedRetryForRun(run, { adapterType: "codex_local" } as Agent);
    expect(retry).toMatchObject({ outcome: "retry_exhausted", attempt: 11, maxAttempts: 10 });
    expect(deps.appendRunEvent).toHaveBeenCalledWith(run, expect.objectContaining({
      retryExhaustion: { retryReason: "runner_revision_wait", scheduledRetryAttempt: 10, maxAttempts: 10 },
    }));
    expect(extracted.failedRunRetryBudgetSpent(run)).toBe(true);
    expect(extracted.failedRunRetryBudgetSpent({ ...run, scheduledRetryAttempt: 9 })).toBe(false);
    expect(extracted.failedRunRetryBudgetSpent({ ...run, errorCode: "setup_failed" })).toBe(false);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("ends an answered interaction's storage wait at its limit and escalates it", async () => {
    const database = guardedDatabase();
    const deps = callbacks();
    const run = { ...unitRun(), status: "failed", errorCode: "storage_unavailable", scheduledRetryReason: "storage_unavailable_wait", scheduledRetryAttempt: 10,
      contextSnapshot: { issueId: "issue", interactionId: "interaction-1", interactionStatus: "answered", interactionKind: "ask_user_questions",
        mutation: "interaction", retryReason: "storage_unavailable_wait",
        executionRetryAccounting: { version: 1, failureRetries: 0, maxTurnContinuations: 0 } } } as Run;
    const retry = await extracted.createHeartbeatRetries(database.db, deps).scheduleBoundedRetryForRun(run, { adapterType: "codex_local" } as Agent);
    expect(retry).toMatchObject({ outcome: "retry_exhausted", maxAttempts: 10 });
    expect(deps.escalatePlanApprovalResumeFailureNeedsAttention).toHaveBeenCalledWith(expect.objectContaining({ run, maxAttempts: 10 }));
  });

  it("leaves successor work to the committed case handoff without retry escalation", async () => {
    const database = guardedDatabase();
    const deps = callbacks();
    deps.hasCaseHandoffForRun.mockResolvedValue(true);
    const run = unitRun();
    const retry = await extracted.createHeartbeatRetries(database.db, deps).scheduleBoundedRetryForRun(
      run, { adapterType: "codex_local" } as Agent,
      { retryReason: legacy.INTERACTION_CONTINUATION_INFRA_RETRY_REASON, maxAttempts: 0 },
    );
    expect(retry).toMatchObject({ outcome: "not_scheduled", issueId: "issue" });
    expect(deps.hasCaseHandoffForRun).toHaveBeenCalledWith(run);
    expect(deps.appendRunEvent).not.toHaveBeenCalled();
    expect(deps.escalatePlanApprovalResumeFailureNeedsAttention).not.toHaveBeenCalled();
    expect(database.access).not.toHaveBeenCalled();
  });

  it("passes the service's worktree cutoff and publishes only returned effects", async () => {
    const database = guardedDatabase();
    const deps = callbacks();
    const now = new Date("2026-10-08T12:00:00Z");
    const cutoff = new Date("2026-10-08T11:00:00Z");
    const effect: PostCommitEffect = {
      kind: "run_queued", runId: "retry", companyId: "company", agentId: "agent",
      invocationSource: "automation", triggerDetail: "system", wakeupRequestId: "wake",
    };
    deps.getWorktreeExecutionCutoff.mockResolvedValue(cutoff);
    deps.runDispatch.promoteDueScheduledRetries.mockResolvedValue({ promoted: 1, runIds: ["retry"], postCommitEffects: [effect] });
    expect(await extracted.createHeartbeatRetries(database.db, deps).promoteDueScheduledRetries(now)).toEqual({ promoted: 1, runIds: ["retry"] });
    expect(deps.runDispatch.promoteDueScheduledRetries).toHaveBeenCalledWith({ now, cutoff });
    expect(deps.applyRunDispatchPostCommitEffects).toHaveBeenCalledWith([effect]);
    expect(deps.applyRunDispatchPostCommitEffects).toHaveBeenCalledAfter(deps.runDispatch.promoteDueScheduledRetries);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("does not publish effects when promotion rejects", async () => {
    const deps = callbacks();
    deps.runDispatch.promoteDueScheduledRetries.mockRejectedValue(new Error("promotion failed"));
    await expect(extracted.createHeartbeatRetries(guardedDatabase().db, deps).promoteDueScheduledRetries()).rejects.toThrow("promotion failed");
    expect(deps.applyRunDispatchPostCommitEffects).not.toHaveBeenCalled();
  });

  it.each(["workspace", "connection"] as const)("leaves a %s cancellation race winner alone", async (kind) => {
    const database = guardedDatabase();
    const deps = callbacks();
    const retries = extracted.createHeartbeatRetries(database.db, deps);
    if (kind === "workspace") await retries.finalizeWorkspaceBusyDeferral(unitRun(), deferral());
    else await retries.finalizeAiConnectionBusyDeferral(unitRun(), new HttpError(409, "busy"), true);
    expect(deps.setRunStatusIfRunning).toHaveBeenCalledTimes(1);
    expect(deps.setWakeupStatus).not.toHaveBeenCalled();
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
    expect(deps.finalizeAgentStatus).not.toHaveBeenCalled();
    expect(database.access).not.toHaveBeenCalled();
  });

  it.each(["workspace", "connection"] as const)("settles the agent after a %s deferral cannot keep its issue lock", async (kind) => {
    const database = guardedDatabase();
    const deps = callbacks();
    const run = { ...unitRun(), status: "cancelled" };
    deps.setRunStatusIfRunning.mockResolvedValue({ updated: true, run });
    deps.releaseIssueExecutionAndPromote.mockRejectedValue(new Error("release failed"));
    const retries = extracted.createHeartbeatRetries(database.db, deps);
    if (kind === "workspace") await retries.finalizeWorkspaceBusyDeferral(run, deferral());
    else await expect(retries.finalizeAiConnectionBusyDeferral(run, new HttpError(409, "busy"), true)).rejects.toThrow("release failed");
    expect(deps.setWakeupStatus).toHaveBeenCalledWith("wake", "cancelled", expect.any(Object));
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(run);
    expect(deps.finalizeAgentStatus).toHaveBeenCalledWith("agent", "cancelled", null, { wasFirstHeartbeat: true });
    expect(deps.finalizeAgentStatus).toHaveBeenCalledAfter(deps.releaseIssueExecutionAndPromote);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("decides an interaction continuation retry from a refused exact resume's refusal, not its earlier spawn failure", async () => {
    const refusal = "Plugin Runner retained session is not authorized";
    const interaction = { issueId: "issue", interactionId: "interaction-1", interactionStatus: "answered", mutation: "interaction",
      wakeReason: "issue_commented", timerClaimWasFirstHeartbeat: true };
    // The retry budget is spent, so an eligible run reports exhaustion
    // without scheduling, and an ineligible one escalates directly.
    const failed = { ...unitRun(), status: "failed", errorCode: "adapter_failed", scheduledRetryAttempt: 2,
      scheduledRetryReason: legacy.INTERACTION_CONTINUATION_INFRA_RETRY_REASON, contextSnapshot: interaction } as Run;
    const refused = { ...failed,
      error: `native_session_interrupted: failed to start command: spawn agent ENOENT; exact checkpoint resume refused: ${refusal}`,
      resultJson: { nativeExactResumeRefusal: { originalFailureCode: "native_session_interrupted",
        originalMessage: "failed to start command: spawn agent ENOENT", interruptedAttempt: 1, refusal } } } as Run;
    const spawnFailure = { ...failed, error: "failed to start command: spawn agent ENOENT", resultJson: {} } as Run;
    const exhaustion = expect.objectContaining({ retryExhaustion: expect.objectContaining({
      retryReason: legacy.INTERACTION_CONTINUATION_INFRA_RETRY_REASON }) });

    const database = guardedDatabase();
    const refusedDeps = callbacks();
    await expect(extracted.createHeartbeatRetries(database.db, refusedDeps)
      .scheduleInteractionContinuationInfrastructureRetryIfEligible(refused, { adapterType: "codex_local" } as Agent)).resolves.toBeNull();
    expect(refusedDeps.appendRunEvent).not.toHaveBeenCalledWith(refused, exhaustion);
    expect(refusedDeps.escalatePlanApprovalResumeFailureNeedsAttention).toHaveBeenCalledOnce();

    const spawnDeps = callbacks();
    await extracted.createHeartbeatRetries(database.db, spawnDeps)
      .scheduleInteractionContinuationInfrastructureRetryIfEligible(spawnFailure, { adapterType: "codex_local" } as Agent);
    expect(spawnDeps.appendRunEvent).toHaveBeenCalledWith(spawnFailure, exhaustion);
    expect(database.access).not.toHaveBeenCalled();
  });
});

import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_HEARTBEAT_RETRIES_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping retry PostgreSQL tests: ${support.reason ?? "unsupported host"}`);

describePostgres("heartbeat retry module database wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const now = new Date("2026-10-08T12:00:00Z");

  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("heartbeat-retries-");
    db = createDb(external ?? database.connectionString, { maxConnections: 6 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  function boundRetries() {
    const state = createHeartbeatRunState(db);
    const deps = {
      ...callbacks(), getRun: state.getRun, getAgent: state.getAgent,
      hasCaseHandoffForRun: async (run: Pick<Run, "id" | "companyId">) => Boolean(await pendingCaseHandoffForRun(db, run.id, run.companyId)),
      resolveSessionBeforeForWakeup: state.resolveSessionBeforeForWakeup,
      getAgentInvokability: (agent: Agent | null | undefined) => evaluateAgentInvokabilityFromDb(db, agent),
      runDispatch: createRunDispatch(db),
    };
    return { retries: extracted.createHeartbeatRetries(db, deps), deps };
  }

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retries", issuePrefix: `R${companyId.slice(0, 8)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Retry agent", adapterType: "codex_local", status: "active" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Retry task", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, scopeKind: "issue", issueId: issue.id,
      status: "failed", errorCode: "codex_transient_upstream", finishedAt: now,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: issue.id },
    }).returning();
    await db.update(issues).set({ executionRunId: run.id, checkoutRunId: run.id }).where(eq(issues.id, issue.id));
    return { companyId, agent, issue, run };
  }

  it.each([false, true])("records a workspace wait only for the deferral's workspace (task moved after cancel: %s)", async (moved) => {
    const { run, agent, issue, companyId } = await fixture();
    const [project] = await db.insert(projects).values({ companyId, name: "Shared" }).returning();
    const [deferredOn, movedTo] = await db.insert(projectWorkspaces).values([
      { companyId, projectId: project.id, name: "Deferred", sourceType: "local_path", cwd: "/tmp/deferred" },
      { companyId, projectId: project.id, name: "Moved", sourceType: "local_path", cwd: "/tmp/moved" },
    ]).returning();
    try {
      await db.update(issues).set({ projectId: project.id, projectWorkspaceId: deferredOn.id }).where(eq(issues.id, issue.id));
      await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, errorCode: null }).where(eq(heartbeatRuns.id, run.id));
      const { retries, deps } = boundRetries();
      // The move lands in the gap after the cancellation commits, as a user edit can.
      deps.setRunStatusIfRunning.mockImplementation(async (runId, status, patch) => {
        const [cancelled] = await db.update(heartbeatRuns).set({ status, ...patch }).where(eq(heartbeatRuns.id, runId)).returning();
        if (moved) await db.update(issues).set({ projectWorkspaceId: movedTo.id }).where(eq(issues.id, issue.id));
        return { updated: true, run: cancelled! };
      });
      await retries.finalizeWorkspaceBusyDeferral({ ...run, status: "running" }, new extracted.WorkspaceBusyDeferral({
        holder: { runId: randomUUID(), agentId: agent.id, issueId: randomUUID(), issueIdentifier: null },
        projectWorkspaceId: deferredOn.id, deferralAttempt: 0, wasIssueAssignee: true,
      }));
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id));
      expect(successor?.status).toBe("scheduled_retry");
      const wait = (successor!.contextSnapshot as Record<string, unknown>).workspaceBusyWait;
      if (moved) expect(wait).toBeUndefined();
      else expect(wait).toMatchObject({ key: `project:${deferredOn.id}`, issueProjectWorkspaceId: deferredOn.id, issueExecutionWorkspaceId: null });
    } finally {
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      await db.delete(issues).where(eq(issues.companyId, companyId));
      await db.delete(projectWorkspaces).where(eq(projectWorkspaces.companyId, companyId));
      await db.delete(projects).where(eq(projects.companyId, companyId));
    }
  });

  it("bounds answered chat attestation retries across restarts and escalates their exhaustion", async () => {
    const { run, agent, companyId } = await fixture();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId: agent.id,
      runId: run.id, source: "automation", status: "failed" }).returning();
    const contextSnapshot = { ...run.contextSnapshot, source: "issue.interaction.respond", externalChatContinuation: true,
      interactionId: randomUUID(), interactionStatus: "answered", interactionKind: "ask_user_questions",
      mutation: "interaction", wakeReason: "issue_commented", wakeCommentIds: [randomUUID()] };
    const [failed] = await db.update(heartbeatRuns).set({ wakeupRequestId: wake!.id,
      errorCode: "reviewed_chat_execution_binding_not_ready", contextSnapshot,
    }).where(eq(heartbeatRuns.id, run.id)).returning();
    let predecessor = failed!;
    for (const attempt of [1, 2]) {
      const { retries, deps } = boundRetries();
      expect(await retries.scheduleInteractionContinuationInfrastructureRetryIfEligible(predecessor, agent))
        .toMatchObject({ outcome: "scheduled", attempt, maxAttempts: 2 });
      const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, predecessor.id));
      expect(successors).toHaveLength(1);
      const successor = successors[0]!;
      expect(successor).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: attempt,
        scheduledRetryReason: legacy.INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
        contextSnapshot: { ...contextSnapshot, wakeReason: legacy.INTERACTION_CONTINUATION_INFRA_WAKE_REASON } });
      expect(deps.escalatePlanApprovalResumeFailureNeedsAttention).not.toHaveBeenCalled();
      const [next] = await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
        errorCode: "reviewed_chat_execution_binding_not_ready", resultJson: run.resultJson,
      }).where(eq(heartbeatRuns.id, successor.id)).returning();
      predecessor = next!;
    }
    const { retries, deps } = boundRetries();
    expect(await retries.scheduleInteractionContinuationInfrastructureRetryIfEligible(predecessor, agent))
      .toMatchObject({ outcome: "retry_exhausted", maxAttempts: 2 });
    expect(deps.escalatePlanApprovalResumeFailureNeedsAttention).toHaveBeenCalledOnce();
    expect(deps.escalatePlanApprovalResumeFailureNeedsAttention)
      .toHaveBeenCalledWith(expect.objectContaining({ attempt: 2, maxAttempts: 2, run: predecessor }));
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(3);
  });

  it("keeps the accepted interaction owner and its catalog provider deadline", async () => {
    const { run, agent } = await fixture();
    const retryAt = new Date(now.getTime() + 3600_000);
    const [failed] = await db.update(heartbeatRuns).set({ errorCode: "repository_catalog_unavailable",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        errorFamily: "transient_upstream", retryNotBefore: retryAt.toISOString() },
      contextSnapshot: { ...run.contextSnapshot, interactionId: "answered-question", interactionStatus: "answered",
        interactionKind: "ask_user_questions", mutation: "interaction", wakeReason: "issue_commented" },
    }).where(eq(heartbeatRuns.id, run.id)).returning();
    expect(await boundRetries().retries.scheduleBoundedRetryForRun(failed!, agent, {
      now, random: () => 0, retryReason: legacy.INTERACTION_CONTINUATION_INFRA_RETRY_REASON, maxAttempts: 2,
    })).toMatchObject({ outcome: "scheduled" });
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id));
    expect(successor!.scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(retryAt.getTime());
    expect(successor).toMatchObject({ scheduledRetryReason: legacy.INTERACTION_CONTINUATION_INFRA_RETRY_REASON });
    expect(isResolvedInteractionContinuationWakeContext(successor!.contextSnapshot)).toBe(true);
    expect(successor!.contextSnapshot?.codexTransientFallbackMode).toBeUndefined();
  });

  it("waits for a Runner update without spending failure retries and keeps an answered interaction", async () => {
    const { run, agent } = await fixture();
    const snapshot = { ...run.contextSnapshot, interactionId: "interaction-1", interactionStatus: "answered", interactionKind: "ask_user_questions",
      mutation: "interaction", wakeReason: "issue_commented", executionRetryAccounting: { version: 1, failureRetries: 1, maxTurnContinuations: 0 } };
    const [failed] = await db.update(heartbeatRuns).set({ errorCode: "runner_revision_mismatch", contextSnapshot: snapshot })
      .where(eq(heartbeatRuns.id, run.id)).returning();
    const result = await boundRetries().retries.scheduleBoundedRetryForRun(failed!, agent, { now });
    expect(result.outcome).toBe("scheduled");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id));
    expect(successor).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "runner_revision_wait", scheduledRetryAttempt: 1 });
    expect(successor!.contextSnapshot).toMatchObject({ mutation: "interaction", interactionId: "interaction-1",
      executionRetryAccounting: { failureRetries: 1 } });
    expect(isResolvedInteractionContinuationWakeContext(successor!.contextSnapshot)).toBe(true);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, successor!.wakeupRequestId!));
    expect(wake!.payload).toMatchObject({ mutation: "interaction", interactionId: "interaction-1", retryReason: "runner_revision_wait" });
  });

  it("waits out a storage outage in its own lane without spending failure retries", async () => {
    const { run, agent } = await fixture();
    const ledger = { executionRetryAccounting: { version: 1, failureRetries: 1, maxTurnContinuations: 0 } };
    let [failed] = await db.update(heartbeatRuns).set({ status: "failed", errorCode: "storage_unavailable",
      contextSnapshot: { ...run.contextSnapshot, ...ledger } }).where(eq(heartbeatRuns.id, run.id)).returning();
    for (let attempt = 1; attempt <= 10; attempt++) {
      const result = await boundRetries().retries.scheduleBoundedRetryForRun(failed!, agent, { now });
      expect(result.outcome).toBe("scheduled");
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, failed!.id));
      expect(successor).toMatchObject({ scheduledRetryReason: "storage_unavailable_wait", scheduledRetryAttempt: attempt });
      expect(successor!.contextSnapshot).toMatchObject({ executionRetryAccounting: { failureRetries: 1 } });
      [failed] = await db.update(heartbeatRuns).set({ status: "failed", errorCode: "storage_unavailable", finishedAt: now,
        resultJson: run.resultJson })
        .where(eq(heartbeatRuns.id, successor!.id)).returning();
      await db.update(issues).set({ executionRunId: successor!.id, checkoutRunId: successor!.id }).where(eq(issues.id, run.issueId!));
    }
    expect(await boundRetries().retries.scheduleBoundedRetryForRun(failed!, agent, { now }))
      .toMatchObject({ outcome: "retry_exhausted", maxAttempts: 10 });
  });

  it("keeps an answered interaction through a storage outage wait", async () => {
    const { run, agent } = await fixture();
    const snapshot = { ...run.contextSnapshot, interactionId: "interaction-1", interactionStatus: "answered", interactionKind: "ask_user_questions",
      mutation: "interaction", wakeReason: "issue_commented" };
    const [failed] = await db.update(heartbeatRuns).set({ errorCode: "storage_unavailable", contextSnapshot: snapshot })
      .where(eq(heartbeatRuns.id, run.id)).returning();
    expect((await boundRetries().retries.scheduleBoundedRetryForRun(failed!, agent, { now })).outcome).toBe("scheduled");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id));
    expect(successor).toMatchObject({ scheduledRetryReason: "storage_unavailable_wait" });
    expect(isResolvedInteractionContinuationWakeContext(successor!.contextSnapshot)).toBe(true);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, successor!.wakeupRequestId!));
    expect(wake!.payload).toMatchObject({ mutation: "interaction", interactionId: "interaction-1", retryReason: "storage_unavailable_wait" });
  });

  it("resolves current skills on a retry while retaining the failed attempt snapshot", async () => {
    const {run,agent}=await fixture();
    const snapshot={...run.contextSnapshot,skillVersions:{"company/review":"v1"},skillSelectionSnapshot:true,shadowedSkills:[{key:"old",shadowedBy:"company/review"}]};
    await db.update(heartbeatRuns).set({contextSnapshot:snapshot}).where(eq(heartbeatRuns.id,run.id));
    await db.update(agents).set({adapterConfig:writePaperclipSkillSyncPreference({},[{key:"company/review",versionId:"v2"}])}).where(eq(agents.id,agent.id));
    const result=await boundRetries().retries.scheduleBoundedRetryForRun({...run,contextSnapshot:snapshot},agent,{now,random:()=>0});
    expect(result.outcome).toBe("scheduled");
    const [successor]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId,run.id));
    expect(successor!.contextSnapshot).not.toHaveProperty("skillVersions");
    expect(successor!.contextSnapshot).not.toHaveProperty("skillSelectionSnapshot");
    expect(successor!.contextSnapshot).not.toHaveProperty("shadowedSkills");
    const [history]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id));
    expect(history!.contextSnapshot).toEqual(snapshot);
  });

  it("reuses one successor across concurrent factories and keeps writes committed before callbacks", async () => {
    const { run, agent, issue, companyId } = await fixture();
    const first = boundRetries(), second = boundRetries();
    for (const binding of [first, second]) {
      binding.deps.appendRunEvent.mockImplementation(async (_source, event) => {
        const retryId = event.payload?.retryRunId;
        expect(typeof retryId).toBe("string");
        expect(await binding.deps.getRun(retryId as string)).toMatchObject({ retryOfRunId: run.id });
      });
    }
    const results = await Promise.all([
      first.retries.scheduleBoundedRetryForRun(run, agent, { now, random: () => 0 }),
      second.retries.scheduleBoundedRetryForRun(run, agent, { now, random: () => 0 }),
    ]);
    expect(results.every((result) => result.outcome === "scheduled")).toBe(true);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, run.id)));
    expect(successors).toHaveLength(1);
    const successor = successors[0];
    expect(successor).toMatchObject({
      status: "scheduled_retry", issueId: issue.id, responsibleUserId: "retry-user",
      scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure",
    });
    expect(successor.contextSnapshot).toMatchObject({ retryOfRunId: run.id, codexTransientFallbackMode: "same_session" });
    expect(first.deps.resolveResponsibleUserIdForRunContext).toHaveBeenCalledWith(run, expect.objectContaining({ retryOfRunId: run.id }));
    const [locked] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(locked).toMatchObject({ executionRunId: successor.id, checkoutRunId: null });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, successor.id))).toHaveLength(1);
    expect(await boundRetries().retries.scheduleBoundedRetry(run.id, { now })).toMatchObject({ outcome: "scheduled", run: { id: successor.id }, reusedExisting: true });
    expect(first.deps.appendRunEvent).toHaveBeenCalledTimes(1);
    expect(second.deps.appendRunEvent).toHaveBeenCalledTimes(1);
  });

  async function checkpointFixture() {
    const f = await fixture();
    const [run] = await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "legacy",
      errorCode: null, error: null, resultJson: { checkpointCompletionReceipt: { version: 1, sourceRunId: f.run.id } }, finishedAt: null,
    }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    const input = { companyId: f.companyId, issueId: f.issue.id, agentId: f.agent.id, runId: run.id,
      request: { version: 1 as const, summary: "Saved implementation", nextAction: "Verify tests" } };
    return { ...f, run, input };
  }

  it("records one durable request, creates one successor concurrently, and promotes without timer wakes", async () => {
    const f = await checkpointFixture();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).where(eq(agents.id, f.agent.id));
    const accepted = await Promise.all([requestCheckpointContinuation(db, f.input), requestCheckpointContinuation(db, f.input)]);
    expect(accepted.every(value => value.accepted)).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.run.id))).toHaveLength(0);
    await expect(requestCheckpointContinuation(db, { ...f.input, request: { ...f.input.request, nextAction: "Changed" } })).rejects.toThrow(/different checkpoint/);
    const [source] = await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: now }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    const first = boundRetries(), second = boundRetries();
    const options = { retryReason: "checkpoint_continuation", wakeReason: "checkpoint_continuation", delayMs: 1000, now };
    await Promise.all([first.retries.scheduleBoundedRetryForRun(source, f.agent, options), second.retries.scheduleBoundedRetryForRun(source, f.agent, options)]);
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1,
      contextSnapshot: { checkpointContinuationAttempts: 1, previousCheckpoint: { sourceRunId: source.id } } });
    expect(successors[0].contextSnapshot?.checkpointContinuationRequest).toBeUndefined();
    expect(await first.retries.promoteDueScheduledRetries(new Date(now.getTime() + 1000))).toMatchObject({ promoted: 1 });
    expect(await first.deps.getRun(successors[0].id)).toMatchObject({ status: "queued" });
    await expect(requestCheckpointContinuation(db, f.input)).rejects.toThrow(/no longer owns/);
  });

  it.each(["timed_out", "cancelled", "failed"] as const)("never continues a %s checkpoint source", async status => {
    const f = await checkpointFixture();
    await requestCheckpointContinuation(db, f.input);
    const [source] = await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    expect(await boundRetries().retries.scheduleBoundedRetryForRun(source, f.agent, { retryReason: "checkpoint_continuation" })).toMatchObject({ outcome: "not_scheduled" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id))).toHaveLength(0);
  });

  it.each([3, -1, "0", null, 1.5])("fails closed for exhausted or malformed checkpoint counter %s", async count => {
    const f = await checkpointFixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id, checkpointContinuationAttempts: count } }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(requestCheckpointContinuation(db, f.input)).rejects.toThrow(/limit/);
  });

  it.each(["reassigned", "done", "blocked", "review", "lock", "checkout", "foreign_agent", "foreign_company", "native", "recovery"])("rejects checkpoint request after %s", async kind => {
    const f = await checkpointFixture();
    if (["done", "blocked", "review"].includes(kind)) await db.update(issues).set({ status: kind === "review" ? "in_review" : kind }).where(eq(issues.id, f.issue.id));
    if (kind === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issue.id));
    if (kind === "lock" || kind === "checkout") await db.update(issues).set(kind === "lock" ? { executionRunId: null } : { checkoutRunId: (await fixture()).run.id }).where(eq(issues.id, f.issue.id));
    if (kind === "foreign_agent") f.input.agentId = (await fixture()).agent.id;
    if (kind === "foreign_company") f.input.companyId = (await fixture()).companyId;
    if (kind === "native") await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, f.run.id));
    if (kind === "recovery") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id, allowDeliverableWork: false } }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(requestCheckpointContinuation(db, f.input)).rejects.toThrow();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.run.id))).toHaveLength(0);
  });

  it.each(["paused_agent", "disabled_wakes", "blocked", "done", "reassigned", "stopped"])("rechecks %s between acceptance and scheduling", async kind => {
    const f = await checkpointFixture();
    await requestCheckpointContinuation(db, f.input);
    const [source] = await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    if (kind === "paused_agent") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
    if (kind === "disabled_wakes") await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, f.agent.id));
    if (kind === "blocked" || kind === "done") await db.update(issues).set({ status: kind }).where(eq(issues.id, f.issue.id));
    if (kind === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issue.id));
    if (kind === "stopped") await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issue.id));
    expect(await boundRetries().retries.scheduleBoundedRetryForRun(source, f.agent, { retryReason: "checkpoint_continuation", now })).toMatchObject({ outcome: "not_scheduled" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.run.id))).toHaveLength(0);
  });

  it("bounds the complete chain to three successors even when a caller requests more", async () => {
    const f = await checkpointFixture();
    let run = f.run;
    const binding = boundRetries();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await requestCheckpointContinuation(db, { ...f.input, runId: run.id });
      const [source] = await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: now, resultJson: { checkpointCompletionReceipt: { version: 1, sourceRunId: run.id } } }).where(eq(heartbeatRuns.id, run.id)).returning();
      const result = await binding.retries.scheduleBoundedRetryForRun(source, f.agent, { retryReason: "checkpoint_continuation", now, maxAttempts: 999, delayMs: 1000 });
      if (result.outcome !== "scheduled") throw new Error(JSON.stringify(result));
      expect(result.run.contextSnapshot?.checkpointContinuationAttempts).toBe(attempt);
      const [next] = await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, result.run.id)).returning();
      run = next;
    }
    await expect(requestCheckpointContinuation(db, { ...f.input, runId: run.id })).rejects.toThrow(/limit/);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(4);
  });

  it("revalidates authority after scheduling before dispatch", async () => {
    const f = await checkpointFixture();
    await requestCheckpointContinuation(db, f.input);
    const [source] = await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    const binding = boundRetries();
    const scheduled = await binding.retries.scheduleBoundedRetryForRun(source, f.agent, { retryReason: "checkpoint_continuation", now, delayMs: 1000 });
    if (scheduled.outcome !== "scheduled") throw new Error(JSON.stringify(scheduled));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
    expect(await binding.retries.promoteDueScheduledRetries(new Date(now.getTime() + 1000))).toMatchObject({ promoted: 0 });
    expect((await binding.deps.getRun(scheduled.run.id))?.status).not.toBe("queued");
  });

  it("does not carry failed checkpoint intent into an infrastructure retry", async () => {
    const f = await checkpointFixture();
    await requestCheckpointContinuation(db, f.input);
    const [source] = await db.update(heartbeatRuns).set({ status: "failed", errorCode: "codex_transient_upstream",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    const result = await boundRetries().retries.scheduleBoundedRetryForRun(source, f.agent, { now });
    if (result.outcome !== "scheduled") throw new Error(JSON.stringify(result));
    expect(result.run.contextSnapshot?.checkpointContinuationRequest).toBeUndefined();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, result.run.id));
    await expect(requestCheckpointContinuation(db, { ...f.input, runId: result.run.id })).resolves.toMatchObject({ accepted: true });
  });

  function checkpointRecovery(binding = boundRetries()) {
    const enqueueWakeup = vi.fn(async () => { throw new Error("Checkpoint must not fall through to generic recovery"); });
    const recovery = recoveryService(db, { enqueueWakeup,
      replayCheckpointContinuation: id => binding.retries.replayCheckpointContinuation(id, { now }),
    });
    return { binding, recovery, enqueueWakeup };
  }

  it("replays terminal-before-admission across concurrent cold recovery and stale-lock sweeps exactly once", async () => {
    const f = await checkpointFixture();
    await requestCheckpointContinuation(db, f.input);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: now }).where(eq(heartbeatRuns.id, f.run.id));
    const a = checkpointRecovery(), b = checkpointRecovery();
    await Promise.all([a.recovery.reconcileLegacyContinuation(f.run.id), b.recovery.sweepStaleIssueLocks()]);
    await checkpointRecovery().recovery.reconcileStrandedAssignedIssues();
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.run.id));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ scheduledRetryReason: "checkpoint_continuation", scheduledRetryAttempt: 1 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(issue.executionRunId).toBe(successors[0].id);
    expect(a.enqueueWakeup).not.toHaveBeenCalled(); expect(b.enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["live_controller", "undated_controller", "pending_cleanup", "unknown_cleanup", "unverified_process"])("retains the source claim until %s settles", async kind => {
    const f = await checkpointFixture();
    await requestCheckpointContinuation(db, f.input);
    await db.update(heartbeatRuns).set({ status: "succeeded",
      ...(kind === "live_controller" ? { controllerLeaseExpiresAt: new Date(now.getTime() + 60_000) } : {}),
      ...(kind === "undated_controller" ? { controllerBootId: randomUUID(), controllerLeaseExpiresAt: null } : {}),
      ...(kind === "unverified_process" ? { processPid: 999999, processGroupId: 999999, processStartedAt: now } : {}),
    }).where(eq(heartbeatRuns.id, f.run.id));
    if (kind === "pending_cleanup") await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.run.id, provider: "local", status: "pending_cleanup" });
    if (kind === "unknown_cleanup") await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.run.id, provider: "local", status: "released", releasedAt: now, cleanupStatus: "unknown" });
    const a = checkpointRecovery();
    await a.recovery.sweepStaleIssueLocks();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.run.id))).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].executionRunId).toBe(f.run.id);
    expect(a.enqueueWakeup).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ controllerBootId: null, controllerLeaseExpiresAt: null, processPid: null, processGroupId: null }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(environmentLeases).set({ status: "released", releasedAt: now, cleanupStatus: "success" }).where(eq(environmentLeases.heartbeatRunId, f.run.id));
    await checkpointRecovery().recovery.sweepStaleIssueLocks();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.run.id))).toHaveLength(1);
  });

  it.each([true, false])("requires exact remote termination even when PID fields are retained: %s", async retainedPid => {
    const f = await checkpointFixture();
    await requestCheckpointContinuation(db, f.input);
    await db.update(heartbeatRuns).set({ status: "succeeded", processPid: retainedPid ? process.pid : null, processGroupId: retainedPid ? process.pid : null, processStartedAt: retainedPid ? now : null }).where(eq(heartbeatRuns.id, f.run.id));
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.run.id,
      provider: "ssh", providerLeaseId: "test-remote", status: "released", releasedAt: now, cleanupStatus: "success" }).returning();
    const receipt = { schema: "paperclip.remote-termination.v1", companyId: f.companyId, runId: f.run.id,
      leaseId: lease.id, provider: "ssh", providerLeaseId: "test-remote", state: "stopped" };
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: { ...receipt, runId: "foreign-run" } } }).where(eq(environmentLeases.id, lease.id));
    expect(await boundRetries().retries.replayCheckpointContinuation(f.run.id, { now })).toBe("pending");
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: receipt } }).where(eq(environmentLeases.id, lease.id));
    expect(await boundRetries().retries.replayCheckpointContinuation(f.run.id, { now })).toBe("scheduled");
  });

  it.each(["missing_receipt", "stopped", "paused", "reassigned", "exhausted"])("does not replay or grant generic repair after %s", async kind => {
    const f = await checkpointFixture();
    await requestCheckpointContinuation(db, f.input);
    await db.update(heartbeatRuns).set({ status: "succeeded",
      ...(kind === "missing_receipt" ? { resultJson: {} } : {}),
      ...(kind === "exhausted" ? { contextSnapshot: { ...(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].contextSnapshot, checkpointContinuationAttempts: 3 } } : {}),
    }).where(eq(heartbeatRuns.id, f.run.id));
    if (kind === "stopped") await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issue.id));
    if (kind === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
    if (kind === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issue.id));
    const a = checkpointRecovery();
    await a.recovery.reconcileLegacyContinuation(f.run.id);
    await a.recovery.sweepStaleIssueLocks();
    await a.recovery.reconcileLegacyContinuation(f.run.id);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.run.id))).toHaveLength(0);
    expect(a.enqueueWakeup).not.toHaveBeenCalled();
    expect((await a.binding.deps.getRun(f.run.id))?.resultJson?.checkpointContinuationReplayClosed).toBe(true);
  });

  it("promotes only due retries and publishes after commit", async () => {
    const { run } = await fixture();
    const { retries, deps } = boundRetries();
    const scheduled = await retries.scheduleBoundedRetry(run.id, { now, delayMs: 60_000 });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") throw new Error("Expected retry");
    expect(await retries.promoteDueScheduledRetries(now)).toEqual({ promoted: 0, runIds: [] });
    deps.applyRunDispatchPostCommitEffects.mockClear();
    const committedStatuses: string[] = [];
    const reads: Promise<void>[] = [];
    deps.applyRunDispatchPostCommitEffects.mockImplementation(() => {
      // Read outside the dispatch transaction after the callback is invoked.
      // The assertion below waits for that read without making publication async.
      reads.push(deps.getRun(scheduled.run.id).then((row) => { committedStatuses.push(row!.status); }));
    });
    expect(await retries.promoteDueScheduledRetries(scheduled.dueAt)).toEqual({ promoted: 1, runIds: [scheduled.run.id] });
    await Promise.all(reads);
    expect(committedStatuses).toEqual(["queued"]);
    expect(deps.applyRunDispatchPostCommitEffects).toHaveBeenCalledWith([expect.objectContaining({ kind: "run_queued", runId: scheduled.run.id })]);
  });

  it("binds retry-now to the requested issue and persists its actor before promotion", async () => {
    const selected = await fixture(), other = await fixture();
    const { retries, deps } = boundRetries();
    const scheduled = await retries.scheduleBoundedRetry(selected.run.id, { now, delayMs: 60_000 });
    const foreign = await retries.scheduleBoundedRetry(other.run.id, { now, delayMs: 60_000 });
    if (scheduled.outcome !== "scheduled" || foreign.outcome !== "scheduled") throw new Error("Expected retries");
    expect(await retries.retryScheduledRetryNow({ issueId: selected.issue.id, actor: { actorType: "user", actorId: "retry-user" }, now })).toMatchObject({
      outcome: "promoted", scheduledRetry: { runId: scheduled.run.id, status: "queued" },
    });
    expect(await deps.getRun(scheduled.run.id)).toMatchObject({ contextSnapshot: {
      retryNowRequestedByActorType: "user", retryNowRequestedByActorId: "retry-user", retryNowRequestedAt: now.toISOString(),
    } });
    expect(await deps.getRun(foreign.run.id)).toMatchObject({ status: "scheduled_retry", scheduledRetryAt: foreign.dueAt });
    expect(await retries.retryScheduledRetryNow({ issueId: selected.issue.id, now })).toMatchObject({ outcome: "already_promoted" });
  });
});

describe("interrupted preparation retry schedule", () => {
  it("retries a preparation a restart interrupted at once, and backs off only if it keeps being interrupted", () => {
    const now = new Date("2026-11-09T11:09:41.846Z");
    const first = extracted.computeInterruptedPreparationRetrySchedule(1, now, () => 0.5);
    expect(first).toMatchObject({ attempt: 1, delayMs: 0, dueAt: now });
    const second = extracted.computeInterruptedPreparationRetrySchedule(2, now, () => 0.5);
    expect(second?.delayMs).toBeGreaterThan(0);
    expect(second).toMatchObject({ attempt: 2, baseDelayMs: extracted.BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0] });
    // Later attempts keep the longest transient delay.
    expect(extracted.computeInterruptedPreparationRetrySchedule(5, now, () => 0.5))
      .toMatchObject({ attempt: 5, baseDelayMs: extracted.BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.at(-1) });
    expect(extracted.computeInterruptedPreparationRetrySchedule(0, now)).toBeNull();
  });
});

