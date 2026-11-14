import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, environmentLeases, heartbeatRuns, issueRelations, issues, issueTreeHolds, projects } from "@paperclipai/db";
import { filterZombieCoalesceTarget, heartbeatService, mergeCoalescedContextSnapshot } from "../services/heartbeat.js";
import { handoffWakeWork } from "../services/heartbeat/handoff-wake.js";
import { createHeartbeatQueue, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } from "../services/heartbeat/queue.js";
import type { WakeupOptions } from "../services/heartbeat/run-preparation.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { environmentService } from "../services/environments.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { evaluateAgentInvokabilityFromDb } from "../services/agent-invokability.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { budgetService } from "../services/budgets.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { issueService } from "../services/issues.js";
import { createAdmissionTransactionScope, createPostgresWakeQueueAdapter, createWakeAdmissionReader, createWakeAdmissionWriter } from "../modules/wake-queue/adapters/postgres.js";
import { createAdmitWakeBehindIssueExecution, createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("handoff execution waits", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("handoff-execution-wait-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });
  afterEach(async () => { await coordinator?.stop(); coordinator = undefined; });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), reviewerId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff", issuePrefix: "H" + companyId.replaceAll("-", ""), defaultResponsibleUserId: "board" });
    await db.insert(agents).values([agentId, reviewerId].map(id => ({ id, companyId, name: id === agentId ? "Executor" : "Reviewer", adapterType: "codex_local", status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })));
    const stageId = randomUUID();
    const executionState = { status: "pending", currentStageId: stageId, currentStageIndex: 0,
      currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
      returnAssignee: { type: "agent", agentId, userId: null }, reviewRequest: null,
      completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null };
    await db.insert(issues).values({ id: issueId, companyId, title: "Review the change", status: "in_review", assigneeAgentId: reviewerId, executionState });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "cancelled", runtimeMode: "legacy",
      startedAt: new Date(), finishedAt: new Date(), errorCode: "issue_reassigned",
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } }, contextSnapshot: { issueId } }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: run.id,
      provider: "local", status: "active", leasePolicy: "ephemeral" }).returning();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId, agentId: reviewerId, status: "running" }).returning();
    const wake = (actor: Pick<WakeupOptions, "requestedByActorType" | "requestedByActorId"> = {
      requestedByActorType: "agent", requestedByActorId: agentId,
    }, reason = "execution_review_requested") => heartbeatService(db).wakeup(reviewerId, { source: "assignment", triggerDetail: "system",
      reason, ...actor,
      payload: { issueId, mutation: "update", executionStage: { stageId, stageType: "review", currentParticipant: executionState.currentParticipant } },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: reason, source: "issue.execution_stage" } });
    const requests = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    const successors = async () => (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, reviewerId)))).filter(row => row.id !== busy.id);
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockImplementation(async id => (await db.select().from(agents).where(eq(agents.id, id)))[0] ?? null);
    deps.getAgentInvokability.mockImplementation(agent => evaluateAgentInvokabilityFromDb(db, agent));
    deps.instanceSettings.getExperimental.mockImplementation(() => instanceSettingsService(db).getExperimental());
    const work = () => handoffWakeWork(db, createHeartbeatQueue(db, deps).enqueueWakeup);
    const recover = async () => { for (const entry of await work().load(companyId)) await work().check(entry); };
    const release = () => environmentService(db).releaseLease(lease.id, "released", { cleanupStatus: "success" });
    const drain = async () => {
      await db.update(heartbeatRuns).set({ resultJson: { conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, run.id));
      return createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => "board",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      }), recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } })({
        companyId, runId: run.id, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true,
      });
    };
    return { companyId, agentId, reviewerId, issueId, run, lease, wake, requests, successors, recover, release, drain, work, deps };
  }

  it("settles the saved handoff when an existing run absorbs it and never resumes it after that run finishes", async () => {
    const f = await fixture();
    await f.wake();
    const [saved] = await f.requests();
    await f.release();
    const [existing] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.reviewerId,
      status: "queued", contextSnapshot: { issueId: f.issueId } }).returning();
    f.deps.wakeQueue.createAdmissionTransactionScope.mockImplementation(createAdmissionTransactionScope);
    f.deps.wakeQueue.admitWakeBehindIssueExecution.mockImplementation(createAdmitWakeBehindIssueExecution({
      reader: createWakeAdmissionReader(), writer: createWakeAdmissionWriter(),
      helpers: { filterZombieCoalesceTarget, mergeCoalescedContextSnapshot,
        shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
    }));

    await f.recover();
    expect((await f.requests()).find(row => row.id === saved.id)).toMatchObject({
      status: "coalesced", runId: existing.id, finishedAt: expect.any(Date),
    });
    expect(await f.work().load(f.companyId)).toHaveLength(0);
    expect(await f.successors()).toEqual([expect.objectContaining({ id: existing.id, status: "queued" })]);
    const receipts = await f.requests();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, existing.id));
    await Promise.all([f.recover(), f.recover()]);
    expect(await f.requests()).toEqual(receipts);
    await f.wake();
    expect(await f.requests()).toHaveLength(receipts.length);
    expect(await f.successors()).toEqual([expect.objectContaining({ id: existing.id, status: "succeeded" })]);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("keeps one saved handoff while an active conversation run defers it", async () => {
    const f = await fixture();
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    await db.update(issues).set({ conversationAgentId: f.reviewerId, conversationUserId: "board",
      conversationState: "active" }).where(eq(issues.id, f.issueId));
    await f.wake();
    const [saved] = await f.requests();
    expect(saved).toMatchObject({ status: "deferred_issue_execution", runId: null });
    await f.release();
    const [existing] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.reviewerId,
      status: "queued", contextSnapshot: { issueId: f.issueId } }).returning();
    f.deps.wakeQueue.createAdmissionTransactionScope.mockImplementation(createAdmissionTransactionScope);
    f.deps.wakeQueue.admitWakeBehindIssueExecution.mockImplementation(createAdmitWakeBehindIssueExecution({
      reader: createWakeAdmissionReader(), writer: createWakeAdmissionWriter(),
      helpers: { filterZombieCoalesceTarget, mergeCoalescedContextSnapshot,
        shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
    }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await Promise.all([f.recover(), f.recover()]);
      expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id,
        status: "deferred_issue_execution", runId: null, finishedAt: null })]);
      expect(await f.successors()).toEqual([expect.objectContaining({ id: existing.id })]);
    }
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, existing.id));
    await Promise.all([f.recover(), f.recover(), f.wake()]);
    await f.recover();
    const successors = (await f.successors()).filter(run => run.id !== existing.id);
    expect(successors).toEqual([expect.objectContaining({ status: "queued", startedAt: null })]);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id,
      status: "queued", runId: successors[0].id, reason: "execution_review_requested" })]);
    expect(await f.work().load(f.companyId)).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("keeps one recoverable handoff receipt through dependency retries and admits it once the dependency resolves", async () => {
    const f = await fixture();
    await f.wake();
    const [saved] = await f.requests();
    const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Unfinished prerequisite", status: "in_progress" }).returning();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker.id, relatedIssueId: f.issueId, type: "blocks" });
    f.deps.issuesSvc.listDependencyReadiness.mockImplementation(issueService(db).listDependencyReadiness);
    await f.release();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await f.recover();
      expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "deferred_issue_execution",
        reason: "issue_dependencies_blocked", runId: null, finishedAt: null,
        payload: expect.objectContaining({ executionWait: expect.objectContaining({ unresolvedBlockerIssueIds: [blocker.id] }) }),
      })]);
      expect(await f.work().load(f.companyId)).toHaveLength(1);
      expect(await f.successors()).toHaveLength(0);
    }
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blocker.id));
    await Promise.all([f.recover(), f.recover()]);
    await f.recover();
    const runs = await f.successors();
    expect(runs).toHaveLength(1);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "queued", runId: runs[0].id,
      reason: "execution_review_requested", finishedAt: null })]);
    expect(await f.work().load(f.companyId)).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("retains the handoff through ordinary release at the daily limit, then admits exactly one successor", async () => {
    const f = await fixture();
    await f.wake();
    const [saved] = await f.requests();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, maxDailyRuns: 0 } } }).where(eq(agents.id, f.reviewerId));
    await f.release();
    await f.drain();
    expect(await f.successors()).toHaveLength(0);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "deferred_issue_execution", runId: null, finishedAt: null })]);
    await f.recover();
    await f.wake();
    await f.drain();
    expect(await f.successors()).toHaveLength(0);
    expect((await f.requests())[0]).toMatchObject({ id: saved.id, status: "deferred_issue_execution", runId: null, finishedAt: null });
    const errors: unknown[] = [];
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    await f.work().register(coordinator, () => true).ready;
    expect(coordinator.nextWakeAt()).not.toBeNull();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.reviewerId));
    await f.drain();
    await vi.waitFor(async () => expect(await f.successors()).toHaveLength(1), { timeout: 40_000 });
    await Promise.all([f.drain(), f.recover(), f.recover(), f.wake()]);
    await f.recover();
    await f.wake();
    const runs = await f.successors();
    expect(runs).toEqual([expect.objectContaining({ status: "queued", startedAt: null })]);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "queued", runId: runs[0].id, reason: "execution_review_requested" })]);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it.each([{ requestedByActorType: "system" as const, requestedByActorId: null }, {}])(
    "restores assignment with the original nullable actor %j", async actor => {
      const f = await fixture();
      await f.wake(actor, "issue_assigned");
      const [saved] = await f.requests();
      expect(saved).toMatchObject({ status: "deferred_issue_execution", requestedByActorType: actor.requestedByActorType ?? null, requestedByActorId: null });
      await f.release();
      const queue = createHeartbeatQueue(db, f.deps);
      const options: WakeupOptions = { source: "assignment", reason: "issue_assigned", ...actor,
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_assigned" } };
      await queue.enqueueWakeup(f.reviewerId, { ...options, requestedByActorId: "" }, saved.id);
      await queue.enqueueWakeup(f.reviewerId, { ...options, requestedByActorType: "agent", requestedByActorId: f.agentId }, saved.id);
      await queue.enqueueWakeup(f.reviewerId, { ...options, reason: "execution_review_requested" }, saved.id);
      await queue.enqueueWakeup(f.reviewerId, options, randomUUID());
      expect(await f.successors()).toHaveLength(0);
      expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "deferred_issue_execution", runId: null })]);
      await Promise.all([f.recover(), f.recover(), f.wake(actor, "issue_assigned")]);
      await f.recover();
      const runs = await f.successors();
      expect(runs).toHaveLength(1);
      expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "queued", runId: runs[0].id,
        requestedByActorType: actor.requestedByActorType ?? null, requestedByActorId: null, reason: "issue_assigned" })]);
    },
  );

  it.each(["agent_pause", "company_pause", "budget"].flatMap(gate =>
    ["done", "cancelled", "stage"].map(change => ({ gate, change })),
  ))("retires a stale $change handoff before the $gate gate and clears its deadline", async ({ gate, change }) => {
    const f = await fixture();
    await f.wake();
    if (gate === "agent_pause") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.reviewerId));
    else if (gate === "company_pause") await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
    else f.deps.budgets.getInvocationBlock.mockResolvedValue({ scopeType: "agent", scopeId: f.reviewerId, scopeName: "Reviewer", reason: "Budget exhausted" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await db.update(issues).set(change === "stage" ? { executionState: { ...issue.executionState, currentStageId: randomUUID() } } :
      { status: change }).where(eq(issues.id, f.issueId));
    await f.release();
    const errors: unknown[] = [];
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    await f.work().register(coordinator, () => true).ready;
    expect(await f.requests()).toEqual([expect.objectContaining({ status: "cancelled", runId: null, finishedAt: expect.any(Date) })]);
    expect(await f.work().load(f.companyId)).toHaveLength(0);
    expect(await f.successors()).toHaveLength(0);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    expect(errors).toEqual([]);
    const reads = vi.spyOn(db, "select"), transactions = vi.spyOn(db, "transaction"), executes = vi.spyOn(db, "execute");
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      expect(reads).not.toHaveBeenCalled();
      expect(transactions).not.toHaveBeenCalled();
      expect(executes).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      reads.mockRestore(); transactions.mockRestore(); executes.mockRestore();
    }
  });

  it.each(["company_pause", "subtree_pause", "budget"])("preserves ordinary release intent at the %s gate and resumes once", async gate => {
    const f = await fixture();
    await f.wake();
    const [saved] = await f.requests();
    if (gate === "company_pause") await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
    else if (gate === "budget") {
      await db.update(agents).set({ status: "paused", pauseReason: "budget" }).where(eq(agents.id, f.reviewerId));
      f.deps.budgets.getInvocationBlock.mockImplementation((...args) => budgetService(db).getInvocationBlock(...args));
    } else {
      const [parent] = await db.insert(issues).values({ companyId: f.companyId, title: "Paused parent" }).returning();
      await db.update(issues).set({ parentId: parent.id }).where(eq(issues.id, f.issueId));
      await db.insert(issueTreeHolds).values({ companyId: f.companyId, rootIssueId: parent.id, mode: "pause" });
      f.deps.treeControlSvc.getActivePauseHoldGate.mockImplementation((...args) => issueTreeControlService(db).getActivePauseHoldGate(...args));
    }
    await f.release();
    await f.drain();
    expect(await f.successors()).toHaveLength(0);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "deferred_issue_execution", runId: null, finishedAt: null })]);
    await f.recover();
    expect(await f.successors()).toHaveLength(0);
    expect((await f.requests())[0]).toMatchObject({ id: saved.id, status: "deferred_issue_execution", runId: null,
      reason: gate === "budget" ? "budget.blocked" : gate === "subtree_pause" ? "issue_tree_hold_active" : "company.inactive" });
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
    await db.update(agents).set({ status: "idle", pauseReason: null }).where(eq(agents.id, f.reviewerId));
    await db.update(issueTreeHolds).set({ status: "released", releasedAt: new Date() }).where(eq(issueTreeHolds.companyId, f.companyId));
    await Promise.all([f.drain(), f.recover(), f.wake()]);
    await f.recover();
    const runs = await f.successors();
    expect(runs).toHaveLength(1);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "queued", runId: runs[0].id })]);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps one cutoff-blocked handoff through repeated replay and restart (project context: %s)", async projectContext => {
    const f = await fixture();
    if (projectContext) {
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Cutoff replay project" }).returning();
      await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
    }
    await f.wake();
    const [saved] = await f.requests();
    f.deps.getWorktreeExecutionCutoff.mockResolvedValue(new Date(Date.now() + 60_000));
    await f.release();

    // Each recovery constructs a fresh queue/work owner, as startup does.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await f.recover();
      expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id,
        status: "deferred_issue_execution", runId: null, finishedAt: null,
        payload: expect.objectContaining({ executionWait: expect.objectContaining({ reason: "heartbeat.worktree_execution_cutoff" }) }),
      })]);
      expect(await f.successors()).toHaveLength(0);
      expect(await f.work().load(f.companyId)).toHaveLength(1);
    }

    f.deps.getWorktreeExecutionCutoff.mockResolvedValue(null);
    await Promise.all([f.recover(), f.recover()]);
    await f.recover();
    const runs = await f.successors();
    expect(runs).toHaveLength(1);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "queued", runId: runs[0].id })]);
    expect(await f.work().load(f.companyId)).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("keeps one throttled assignment handoff through repeated replay and admits it once the cooldown expires", async () => {
    const f = await fixture();
    await f.wake(undefined, "issue_assigned");
    const [saved] = await f.requests();
    const finishedAt = new Date();
    const history = await db.insert(heartbeatRuns).values([0, 1].map(offset => ({
      companyId: f.companyId, agentId: f.reviewerId, status: "succeeded" as const,
      startedAt: new Date(finishedAt.getTime() - 10_000 - offset),
      finishedAt: new Date(finishedAt.getTime() - offset), contextSnapshot: { issueId: f.issueId },
    }))).returning();
    const historyIds = new Set(history.map(run => run.id));
    const newRuns = async () => (await f.successors()).filter(run => !historyIds.has(run.id));
    await f.release();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await f.recover();
      expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id,
        status: "deferred_issue_execution", runId: null, finishedAt: null,
        payload: expect.objectContaining({ executionWait: expect.objectContaining({ reason: "issue_rewake_throttled" }) }),
      })]);
      expect(await newRuns()).toHaveLength(0);
      expect(await f.work().load(f.companyId)).toHaveLength(1);
    }

    // Move only synthetic history beyond the cooldown; no real timer or dispatch.
    for (const historical of history) await db.update(heartbeatRuns).set({
      startedAt: new Date(Date.now() - 11 * 60_000), finishedAt: new Date(Date.now() - 10 * 60_000),
    }).where(eq(heartbeatRuns.id, historical.id));
    await Promise.all([f.recover(), f.recover()]);
    await f.recover();
    const runs = await newRuns();
    expect(runs).toHaveLength(1);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id,
      status: "queued", runId: runs[0].id, reason: "issue_assigned" })]);
    expect(await f.work().load(f.companyId)).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("preserves an agent-origin review handoff while its cancelled executor still owns a lease", async () => {
    const f = await fixture();
    await f.wake();
    expect(await f.requests()).toEqual([expect.objectContaining({ status: "deferred_issue_execution", runId: null,
      reason: "execution_owner_active", finishedAt: null })]);
    expect(await f.successors()).toHaveLength(0);
  });

  it("retains active and failed cleanup, then admits the reviewer exactly once across repeated recovery and wake signals", async () => {
    const f = await fixture();
    await Promise.all([f.wake(), f.wake()]);
    const [saved] = await f.requests();
    expect(await f.requests()).toHaveLength(1);
    await f.recover();
    expect(await f.successors()).toHaveLength(0);
    await environmentService(db).releaseLease(f.lease.id, "pending_cleanup", { cleanupStatus: "failed" });
    await f.recover();
    expect(await f.successors()).toHaveLength(0);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "deferred_issue_execution", runId: null })]);
    await f.release();
    await Promise.all([f.recover(), f.recover(), f.wake()]);
    await f.recover();
    await f.wake();
    const runs = await f.successors();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", startedAt: null, agentId: f.reviewerId,
      contextSnapshot: { issueId: f.issueId, wakeReason: "execution_review_requested" } });
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "queued", runId: runs[0].id,
      reason: "execution_review_requested" })]);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["stage", "participant", "cancelled", "reassigned"])("discards a stale %s handoff during restart recovery", async change => {
    const f = await fixture();
    await f.wake();
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    if (change === "stage" || change === "participant") {
      await db.update(issues).set({ executionState: { ...issue.executionState,
        ...(change === "stage" ? { currentStageId: randomUUID() } : { currentParticipant: { type: "agent", agentId: f.agentId, userId: null } }) },
      }).where(eq(issues.id, f.issueId));
    } else await db.update(issues).set(change === "cancelled" ? { status: "cancelled" } : {
      assigneeAgentId: f.agentId, statusVersion: issue.statusVersion + 1,
    }).where(eq(issues.id, f.issueId));
    await f.release();
    await f.recover();
    expect(await f.successors()).toHaveLength(0);
    expect(await f.requests()).toEqual([expect.objectContaining({ status: "cancelled", runId: null })]);
  });

  it("does not treat a released lease as proof that its provider process stopped", async () => {
    const f = await fixture();
    await f.wake();
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.run.id));
    await f.release();
    await f.recover();
    expect(await f.successors()).toHaveLength(0);
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, f.run.id));
    await f.recover();
    expect(await f.successors()).toHaveLength(1);
  });

  it.each([false, true])("rechecks the stage in ordinary release promotion (stale: %s)", async stale => {
    const f = await fixture();
    await f.wake();
    await db.update(heartbeatRuns).set({ resultJson: { conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, f.run.id));
    if (stale) {
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      await db.update(issues).set({ executionState: { ...issue.executionState, currentStageId: randomUUID() } }).where(eq(issues.id, f.issueId));
    }
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => "board",
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    }), recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } });
    const input = { companyId: f.companyId, runId: f.run.id, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true };
    await release(input);
    expect(await f.successors()).toHaveLength(0);
    await f.release();
    await Promise.all([release(input), release(input), f.recover()]);
    expect(await f.successors()).toHaveLength(stale ? 0 : 1);
    expect((await f.requests())[0].status).toBe(stale ? "cancelled" : "queued");
  });

  it.each(["agent_pause", "company_pause", "daily_limit"])("keeps the %s admission gate after cleanup", async gate => {
    const f = await fixture();
    await f.wake();
    if (gate === "agent_pause") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.reviewerId));
    else if (gate === "company_pause") await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
    else await db.update(agents).set({ runtimeConfig: { heartbeat: { maxDailyRuns: 0 } } }).where(eq(agents.id, f.reviewerId));
    await f.release();
    await f.recover();
    expect(await f.successors()).toHaveLength(0);
    expect(await f.requests()).toEqual([expect.objectContaining({ status: "deferred_issue_execution", runId: null })]);
    await db.update(agents).set({ status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.reviewerId));
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
    await f.recover();
    expect(await f.successors()).toHaveLength(1);
  });

  it.each([true, false])("reconstructs pending work (saved before startup: %s), wakes from lease cleanup and becomes idle", async savedBeforeStartup => {
    const f = await fixture();
    if (savedBeforeStartup) await f.wake();
    const errors: unknown[] = [];
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
    let sweepRunning = false;
    const register = coordinator.register.bind(coordinator);
    vi.spyOn(coordinator, "register").mockImplementation((queue, task) => register(queue, {
      ...task, run: async signal => {
        sweepRunning = true;
        try { await task.run(signal); } finally { sweepRunning = false; }
      },
    }));
    await heartbeatService(db).registerExecutionHandoffWork(coordinator, () => true).ready;
    if (!savedBeforeStartup) await f.wake();
    expect(await f.successors()).toHaveLength(0);
    await f.release();
    await vi.waitFor(async () => expect(await f.successors()).toHaveLength(1), { timeout: 40_000 });
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull(), { timeout: 40_000 });
    // A null future deadline is not proof the current duty has returned.
    // Observe the actual registered duty's completion, including postcommit reads.
    await vi.waitFor(() => { expect(sweepRunning).toBe(false); expect(coordinator!.nextWakeAt()).toBeNull(); });
    const reads = vi.spyOn(db, "select");
    try {
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(reads).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); }
    expect(errors).toEqual([]);
  });
  it("local fault: rollback after successor INSERT retains original deferred receipt", async () => {
    const f = await fixture();
    await f.wake(); await f.release();
    const [saved] = await f.requests();
    const originalTransaction = db.transaction.bind(db);
    let injected = false;
    const spy = vi.spyOn(db, "transaction").mockImplementation((async (callback: any, options: any) =>
      originalTransaction(async (tx: any) => {
        const result = await callback(tx);
        const rows = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.reviewerId)));
        const inserted = rows.filter((r:any) => r.contextSnapshot?.issueId === f.issueId);
        if (!injected && inserted.length) {
          injected = true; throw new Error("fault-before-admission-commit");
        }
        return result;
      }, options)) as any);
    try {
      await expect(f.recover()).rejects.toThrow("fault-before-admission-commit");
      expect(injected).toBe(true);
      expect(await f.successors()).toHaveLength(0);
      expect(await f.requests()).toEqual([expect.objectContaining({
        id: saved.id, status: "deferred_issue_execution", runId: null})]);
    } finally { spy.mockRestore(); }
    await Promise.all([f.recover(), f.recover()]);
    const runs = await f.successors();
    expect(runs).toHaveLength(1);
    expect(await f.requests()).toEqual([expect.objectContaining({id: saved.id, status: "queued", runId: runs[0].id})]);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("local fault: postcommit start failure cannot resurrect or duplicate handoff", async () => {
    const f = await fixture();
    await f.wake(); await f.release();
    const [saved] = await f.requests();
    let injected = false;
    f.deps.getAgent.mockImplementation(async id => {
      if (!injected && (await f.successors()).length > 0) {
        injected = true; throw new Error("fault-after-admission-commit-before-start");
      }
      return (await db.select().from(agents).where(eq(agents.id,id)))[0] ?? null;
    });
    await expect(f.recover()).rejects.toThrow("fault-after-admission-commit-before-start");
    expect(injected).toBe(true);
    const runs = await f.successors();
    expect(runs).toHaveLength(1);
    expect(await f.requests()).toEqual([expect.objectContaining({id:saved.id,status:"queued",runId:runs[0].id})]);
    await Promise.all([f.recover(), f.recover(), f.wake()]);
    expect(await f.successors()).toHaveLength(1);
    expect(await f.work().load(f.companyId)).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("backport: one unexpected receipt failure does not starve a later company", async () => {
    const a = await fixture(), b = await fixture();
    await a.wake(); await b.wake(); await a.release(); await b.release();
    const all = [...await a.requests(), ...await b.requests()].sort((x, y) => x.id.localeCompare(y.id));
    const first = all[0].companyId === a.companyId ? a : b;
    const later = first === a ? b : a;
    const queue = createHeartbeatQueue(db, later.deps);
    const errors: unknown[] = [];
    const enqueue = vi.fn(async (agent: string, options: WakeupOptions, id?: string) => {
      if (agent === first.reviewerId) throw new Error("isolated receipt failure");
      return queue.enqueueWakeup(agent, options, id);
    });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: e => errors.push(e) });
    await handoffWakeWork(db, enqueue).register(coordinator, () => true).ready;
    expect(await first.successors()).toHaveLength(0);
    expect(await later.successors()).toHaveLength(1);
    expect((await first.requests())[0].status).toBe("deferred_issue_execution");
    expect(errors).toHaveLength(1);
    expect(coordinator.nextWakeAt()).not.toBeNull();
  });

  it.each(["agent_pause", "budget"])("backport: blocked earlier %s receipt does not starve healthy later receipt", async gate => {
    const a = await fixture(), b = await fixture();
    await a.wake(); await b.wake(); await a.release(); await b.release();
    const all = [...await a.requests(), ...await b.requests()].sort((x, y) => x.id.localeCompare(y.id));
    const first = all[0].companyId === a.companyId ? a : b;
    const later = first === a ? b : a;
    if (gate === "agent_pause") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, first.reviewerId));
    else later.deps.budgets.getInvocationBlock.mockImplementation(async (_company: string, agent: string) =>
      agent === first.reviewerId ? { scopeType: "agent", scopeId: agent, scopeName: "blocked", reason: "Budget exhausted" } : null);
    const errors: unknown[] = [];
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: e => errors.push(e) });
    await handoffWakeWork(db, createHeartbeatQueue(db, later.deps).enqueueWakeup).register(coordinator, () => true).ready;
    expect(await first.successors()).toHaveLength(0);
    expect(await later.successors()).toHaveLength(1);
    expect((await first.requests())[0].status).toBe("deferred_issue_execution");
    expect(errors).toEqual([]);
  });

  it("backport: pending deadline replays after lease release without a notification", async () => {
    const f = await fixture(); await f.wake();
    const errors: unknown[] = [];
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: e => errors.push(e) });
    await f.work().register(coordinator, () => true).ready;
    expect(coordinator.nextWakeAt()).not.toBeNull();
    // Deliberately bypass only the notification in this synthetic fixture.
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() })
      .where(eq(environmentLeases.id, f.lease.id));
    await vi.waitFor(async () => expect(await f.successors()).toHaveLength(1), { timeout: 40_000 });
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    expect(errors).toEqual([]);
  }, 60_000);

  it.each(["drain", "shutdown"])("backport: %s during a sweep retains later receipts without dispatch", async mode => {
    const a = await fixture(), b = await fixture();
    await a.wake(); await b.wake(); await a.release(); await b.release();
    let enabled = true;
    let entered!: () => void, release!: () => void;
    const entry = new Promise<void>(r => { entered = r; });
    const barrier = new Promise<void>(r => { release = r; });
    const enqueue = vi.fn(async () => { entered(); await barrier; });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, onError: () => {} });
    const worker = handoffWakeWork(db, enqueue).register(coordinator, () => enabled);
    await entry;
    let stopping: Promise<void> | undefined;
    if (mode === "shutdown") stopping = coordinator.stop();
    else enabled = false;
    release(); await worker.ready; await stopping;
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await a.successors()).toHaveLength(0); expect(await b.successors()).toHaveLength(0);
    expect((await a.requests())[0].status).toBe("deferred_issue_execution");
    expect((await b.requests())[0].status).toBe("deferred_issue_execution");
    await coordinator.stop();
    enabled = true;
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, onError: e => { throw e; } });
    await handoffWakeWork(db, createHeartbeatQueue(db, a.deps).enqueueWakeup).register(coordinator, () => enabled).ready;
    expect(await a.successors()).toHaveLength(1); expect(await b.successors()).toHaveLength(1);
  });
  it("backport: later human Stop revokes the saved handoff from an already-cancelled source", async () => {
    const f = await fixture(); await f.wake();
    const [saved] = await f.requests();
    await heartbeatService(db).cancelRun(f.run.id, "Stopped by user", {
      resultJson: { cancelledByActorType: "user", cancelledByActorId: "board" },
    });
    await f.release(); await f.recover();
    expect(await f.successors()).toHaveLength(0);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "cancelled", runId: null })]);
  });

  it("backport: human Stop before the delayed handoff prevents a fresh durable receipt", async () => {
    const f = await fixture();
    await heartbeatService(db).cancelRun(f.run.id, "Stopped by user", {
      resultJson: { cancelledByActorType: "user", cancelledByActorId: "board" },
    });
    await f.wake();
    await f.release(); await f.recover();
    expect(await f.successors()).toHaveLength(0);
    expect((await f.requests()).filter(row => row.status === "deferred_issue_execution" || row.status === "queued")).toHaveLength(0);
  });
  it.each(["precommit", "postcommit"])("backport: SIGKILL at %s boundary recovers exactly one successor", async mode => {
    const f = await fixture(); await f.wake(); await f.release();
    const [saved] = await f.requests();
    const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run",
      "server/src/__tests__/heartbeat-handoff-crash-child.test.ts", "--maxWorkers=1"], {
      cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=512",
        PAPERCLIP_BACKPORT_CRASH_DB: database.connectionString,
        PAPERCLIP_BACKPORT_CRASH_COMPANY: f.companyId,
        PAPERCLIP_BACKPORT_CRASH_ISSUE: f.issueId,
        PAPERCLIP_BACKPORT_CRASH_REVIEWER: f.reviewerId,
        PAPERCLIP_BACKPORT_CRASH_MODE: mode },
    });
    let reached = false;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.stderr.on("data", () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Isolated crash child boundary timeout")), 60_000);
        let text = "";
        child.stdout.on("data", chunk => {
          text = (text + chunk.toString()).slice(-4096);
          if (text.includes("BACKPORT_CRASH_BOUNDARY_READY")) {
            reached = true; clearTimeout(timer); resolve();
          }
        });
        child.once("exit", () => { clearTimeout(timer); if (!reached) reject(new Error("Isolated crash child exited before boundary")); });
        child.once("error", error => { clearTimeout(timer); reject(error); });
      });
      // Only this newly spawned, detached test process group is terminated.
      process.kill(-child.pid!, "SIGKILL"); await exited;
      if (mode === "precommit") {
        await vi.waitFor(async () => expect(await f.successors()).toHaveLength(0));
        expect((await f.requests())[0]).toMatchObject({ id: saved.id, status: "deferred_issue_execution", runId: null });
      } else {
        expect(await f.successors()).toHaveLength(1);
        expect((await f.requests())[0]).toMatchObject({ id: saved.id, status: "queued" });
      }
      await Promise.all([f.recover(), f.recover()]); await f.wake();
      const runs = await f.successors(); expect(runs).toHaveLength(1);
      expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "queued", runId: runs[0].id })]);
      expect(f.deps.executeRun).not.toHaveBeenCalled();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ }
      }
      await exited;
    }
  }, 90_000);
  it.each(["stop", "admission"])("backport: %s wins the task lock against concurrent Stop/replay", async winner => {
    const f = await fixture(); await f.wake(); await f.release();
    const transaction = db.transaction.bind(db);
    let entered!: () => void, release!: () => void, held = false;
    const entry = new Promise<void>(r => { entered = r; });
    const barrier = new Promise<void>(r => { release = r; });
    const spy = vi.spyOn(db, "transaction").mockImplementation((async (fn: any, options: any) =>
      transaction(async tx => {
        const result = await fn(tx);
        if (!held) {
          const rows = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
          const ready = winner === "stop"
            ? rows.some(row => row.id === f.run.id && row.resultJson?.executionHandoffStop)
            : rows.some(row => row.agentId === f.reviewerId && row.contextSnapshot?.issueId === f.issueId);
          if (ready) { held = true; entered(); await barrier; }
        }
        return result;
      }, options)) as any);
    const stop = () => heartbeatService(db).cancelRun(f.run.id, "Stopped by user", {
      resultJson: { cancelledByActorType: "user", cancelledByActorId: "board" },
    });
    try {
      const first = winner === "stop" ? stop() : f.recover();
      await entry;
      const second = winner === "stop" ? f.recover() : stop();
      release(); await Promise.all([first, second]);
      expect(await f.successors()).toHaveLength(winner === "stop" ? 0 : 1);
      expect((await f.requests())[0].status).toBe(winner === "stop" ? "cancelled" : "queued");
    } finally { release(); spy.mockRestore(); }
  });

  it("backport: stopping an old source does not block a fresh source and later stage", async () => {
    const f = await fixture(); await f.wake();
    await heartbeatService(db).cancelRun(f.run.id, "Stopped by user", {
      resultJson: { cancelledByActorType: "user", cancelledByActorId: "board" },
    });
    await f.release();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "cancelled", runtimeMode: "legacy", errorCode: "issue_reassigned", startedAt: new Date(), finishedAt: new Date(),
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } }, contextSnapshot: { issueId: f.issueId } }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: source.id, provider: "local", status: "active", leasePolicy: "ephemeral" }).returning();
    await db.update(issues).set({ statusVersion: sql`${issues.statusVersion} + 1` }).where(eq(issues.id, f.issueId));
    await f.wake();
    await environmentService(db).releaseLease(lease.id, "released", { cleanupStatus: "success" });
    await f.recover();
    expect(await f.successors()).toHaveLength(1);
    expect((await f.requests()).map(row => row.status).sort()).toEqual(["cancelled", "queued"]);
  });
});
