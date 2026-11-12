import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { readWorkerSupervision, WORKER_CHECK_IN_TIMEOUT_MS } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { createPostgresWatchdogAdapter } from "../modules/active-run-watchdog/adapters/postgres.js";
import { createBuildRunOutputSilence } from "../modules/active-run-watchdog/application/use-cases.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "./adapter-execution-control.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { createHeartbeatRetries } from "./heartbeat/retries.js";
import { legacyExecutionNeedsReconciliationWithEvidence, terminalizeLegacyExecution } from "./legacy-execution-recovery.js";
import { executionControlSchedule } from "./execution-control-work.js";
import { startWorkerSupervision, checkInWorker, settleWorkerSupervision, reconcileWorkerCheckIns, supervisedWorkerStopPending } from "./worker-supervision.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("worker check-in supervision", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const now = new Date(Date.now() + 3_600_000);
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("worker-check-in-"); db = createDb(temp.connectionString); }, 30_000);
  afterEach(async () => { adapterExecutionControls.clear(); await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await (db as any).$client.end({ timeout: 5 }); await temp?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Check-in test", issuePrefix: `C${companyId.slice(0, 8)}`, defaultResponsibleUserId: "board", requireBoardApprovalForNewAgents: false });
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", adapterType: "codex_local", status: "running", lifecycleState: "ready", adapterConfig: { engine: "cli", timeoutSec: 180 }, runtimeConfig: { workerSupervision: { mode: "check_in" }, heartbeat: { enabled: false, wakeOnDemand: true } } }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Long quiet work", status: "in_progress", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, scopeKind: "issue", runtimeMode: "legacy", status: "running", startedAt: now, processStartedAt: now, contextSnapshot: { issueId } }).returning();
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId, executionLockedAt: now }).where(eq(issues.id, issueId));
    const state = (await startWorkerSupervision(db, run, agent, { engine: "cli" }, { now }))!;
    return { companyId, agentId, issueId, runId, agent, run, state };
  }
  async function current(id: string) { return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!; }
  const ping = (f: Awaited<ReturnType<typeof fixture>>, sequence: number, seconds: number) => checkInWorker(db, { companyId: f.companyId, agentId: f.agentId, runId: f.runId, request: { version: 1, generation: f.state.generation, sequence } }, at(seconds));

  it("resets a180-second missed-check-in threshold and never terminalizes or releases ownership", async () => {
    const f = await fixture(); expect(f.state.timeoutMs).toBe(WORKER_CHECK_IN_TIMEOUT_MS);
    expect(f.state.deadlineAt).toBe(at(180).toISOString());
    await ping(f, 1, 90);
    expect(await executionControlSchedule(db).finalization()).toBe(at(270).getTime());
    expect((await reconcileWorkerCheckIns(db, at(269))).missed).toBe(0);
    expect((await reconcileWorkerCheckIns(db, at(270))).missed).toBe(1);
    expect((await reconcileWorkerCheckIns(db, at(900))).missed).toBe(0);
    const run = await current(f.runId); expect(run.status).toBe("running"); expect(run.workerCheckInDeadlineAt).toBeNull();
    expect(readWorkerSupervision(run.workerSupervision, run.id)).toMatchObject({ state: "suspected_disconnected", sequence: 1, missedAt: at(270).toISOString() });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!.executionRunId).toBe(f.runId);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.eventType, "worker.check_in_missed"))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "heartbeat.check_in_missed"))).toHaveLength(1);
  });

  it("allows healthy quiet work far beyond180seconds and the15-minute output threshold", async () => {
    const f = await fixture();
    for (let n = 1; n <= 20; n++) { await ping(f, n, n * 120); expect((await reconcileWorkerCheckIns(db, at(n * 120))).missed).toBe(0); }
    const run = await current(f.runId); expect(run.status).toBe("running"); expect(run.lastOutputAt).toBeNull();
    const reader = createPostgresWatchdogAdapter(db);
    expect(await reader.findCandidateSilentRuns({ suspicionBefore: at(2400) })).toEqual([]);
    const summary = await createBuildRunOutputSilence({ reader, suspicionThresholdMs: 300_000, criticalThresholdMs: 900_000 })({ ...run, lastOutputSeq: 0 }, at(2400));
    expect(summary.level).toBe("not_applicable"); expect(readWorkerSupervision(run.workerSupervision, run.id)?.sequence).toBe(20);
  });

  it("does not renew on replay, stale sequences, foreign generations or client clock fields", async () => {
    const f = await fixture(); const first = await ping(f, 1, 10);
    expect(await ping(f, 1, 170)).toMatchObject({ duplicate: true, deadlineAt: first.deadlineAt });
    for (const request of [
      { version: 1, generation: f.state.generation, sequence: 0 },
      { version: 1, generation: f.state.generation, sequence: 3 },
      { version: 1, generation: randomUUID(), sequence: 2 },
      { version: 1, generation: f.state.generation, sequence: 2, timestamp: at(100000).toISOString() },
    ]) await expect(checkInWorker(db, { companyId: f.companyId, agentId: f.agentId, runId: f.runId, request }, at(170))).rejects.toThrow();
    expect((await current(f.runId)).workerCheckInDeadlineAt).toEqual(at(190));
  });

  it("serializes check-in/deadline races and permits recovery only on the same current execution", async () => {
    const f = await fixture();
    await Promise.all([reconcileWorkerCheckIns(db, at(180)), ping(f, 1, 180)]);
    const run = await current(f.runId); expect(run.status).toBe("running"); expect(run.workerCheckInDeadlineAt).toEqual(at(360));
    expect(readWorkerSupervision(run.workerSupervision, run.id)).toMatchObject({ state: "healthy", sequence: 1 });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });

  it("preserves the original generation/deadline on restart and stops scheduling after settlement", async () => {
    const f = await fixture();
    expect(await startWorkerSupervision(db, await current(f.runId), f.agent, { engine: "cli" }, { now: at(170) })).toEqual(f.state);
    await reconcileWorkerCheckIns(db, at(180));
    expect(await ping(f, 1, 181)).toMatchObject({ state: "healthy", missedAt: at(180).toISOString() });
    await settleWorkerSupervision(db, f.runId, f.companyId, f.state.generation, at(182));
    expect((await current(f.runId)).workerCheckInDeadlineAt).toBeNull();
    expect(await executionControlSchedule(db).finalization()).toBeNull();
    await expect(ping(f, 2, 183)).rejects.toThrow("no longer owns");
  });

  it("preserves expiry evidence even when a late check-in beats the reconciler", async () => {
    const f = await fixture();
    expect(await ping(f, 1, 181)).toMatchObject({ state: "healthy", missedAt: at(180).toISOString() });
    await settleWorkerSupervision(db, f.runId, f.companyId, f.state.generation, at(182));
    expect(await supervisedWorkerStopPending(db, await current(f.runId))).toBe(true);
  });

  it("does not let settlement erase an overdue deadline before reconciliation", async () => {
    const f = await fixture();
    await settleWorkerSupervision(db, f.runId, f.companyId, f.state.generation, at(181));
    expect(readWorkerSupervision((await current(f.runId)).workerSupervision, f.runId)).toMatchObject({
      state: "controller_settled", missedAt: at(180).toISOString() });
    expect(await supervisedWorkerStopPending(db, await current(f.runId))).toBe(true);
  });

  it.each(["stop", "reassigned", "agent_paused", "company_paused", "terminal"])("rejects a late healthy claim after %s", async kind => {
    const f = await fixture();
    if (kind === "stop") await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    if (kind === "agent_paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    if (kind === "company_paused") await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
    if (kind === "terminal") await db.update(heartbeatRuns).set({ status: "failed", finishedAt: at(1) }).where(eq(heartbeatRuns.id, f.runId));
    await expect(ping(f, 1, 10)).rejects.toThrow(); expect((await current(f.runId)).workerCheckInDeadlineAt).toEqual(at(180));
  });

  it("keeps missed-check-in recovery pending until exact remote termination and controller settlement", async () => {
    const f = await fixture(); await reconcileWorkerCheckIns(db, at(180));
    await settleWorkerSupervision(db, f.runId, f.companyId, f.state.generation, at(181));
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: at(181) }).where(eq(heartbeatRuns.id, f.runId));
    const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.runId, provider: "ssh", providerLeaseId: "synthetic-ssh-scope" };
    await db.insert(environmentLeases).values({ ...identity, status: "released", releasedAt: at(181), cleanupStatus: null });
    expect(await supervisedWorkerStopPending(db, await current(f.runId))).toBe(true);
    await db.update(environmentLeases).set({ cleanupStatus: "success", metadata: { remoteExecutionTermination: { ...remoteTerminationReceipt(identity, { providerLeaseId: identity.providerLeaseId, state: "stopped" }), runId: randomUUID() } } }).where(eq(environmentLeases.id, identity.id));
    expect(await supervisedWorkerStopPending(db, await current(f.runId))).toBe(true);
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: remoteTerminationReceipt(identity, { providerLeaseId: identity.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, identity.id));
    const control = createAdapterExecutionControl(); adapterExecutionControls.set(f.runId, control);
    expect(await supervisedWorkerStopPending(db, await current(f.runId))).toBe(true);
    adapterExecutionControls.delete(f.runId); control.finish();
    expect(await supervisedWorkerStopPending(db, await current(f.runId))).toBe(false);
  });

  it("holds real completion/recovery and bounded retry persistence after missing health", async () => {
    const f = await fixture(); await reconcileWorkerCheckIns(db, at(180));
    await settleWorkerSupervision(db, f.runId, f.companyId, f.state.generation, at(181));
    const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.runId,
      provider: "ssh", providerLeaseId: "synthetic-stop-receipt-contract" };
    await db.insert(environmentLeases).values({ ...identity, status: "released", releasedAt: at(181), cleanupStatus: null });
    const terminal = await terminalizeLegacyExecution({ db, run: await current(f.runId), status: "succeeded",
      patch: { finishedAt: at(182) }, reconcileIfNeeded: true });
    expect(terminal?.status).toBe("succeeded");
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, await current(f.runId))).toBe(true);
    const handoff = vi.fn(async () => true);
    const retries = createHeartbeatRetries(db, { hasCaseHandoffForRun: handoff } as any);
    const blocked = await retries.scheduleBoundedRetryForRun(await current(f.runId), f.agent,
      { retryReason: "checkpoint_continuation", delayMs: 0, now: at(183) });
    expect(blocked).toMatchObject({ outcome: "not_scheduled", reason: expect.stringContaining("verified stop") });
    expect(handoff).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    // Synthetic canonical contract only: this does not claim that plain SSH can produce this receipt.
    await db.update(environmentLeases).set({ cleanupStatus: "success", metadata: {
      remoteExecutionTermination: remoteTerminationReceipt(identity, { providerLeaseId: identity.providerLeaseId, state: "stopped" })
    } }).where(eq(environmentLeases.id, identity.id));
    expect((await retries.scheduleBoundedRetryForRun(await current(f.runId), f.agent)).reason).toContain("case handoff");
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it.each(["native", "acp", "sandbox"])("refuses unqualified %s contracts before supervision can grant anything", async kind => {
    const f = await fixture();
    await expect(startWorkerSupervision(db, { ...f.run, runtimeMode: kind === "native" ? "native" : "legacy" }, f.agent,
      { engine: kind === "acp" ? "acp" : "cli" }, { now, transport: kind === "sandbox" ? "sandbox" : "local" })).rejects.toThrow("local or SSH");
  });

  it.each(["valid", "board", "missing_run", "other_run", "other_agent", "foreign_company", "extra_fields"])("HTTP check-in boundary: %s", async kind => {
    const f = await fixture();
    const actor: any = kind === "board" ? { type: "board", source: "local_implicit", userId: "board", isInstanceAdmin: true } : { type: "agent", agentId: kind === "other_agent" ? randomUUID() : f.agentId, companyId: kind === "foreign_company" ? randomUUID() : f.companyId, runId: kind === "missing_run" ? null : kind === "other_run" ? randomUUID() : f.runId, source: "agent_jwt" };
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = actor; next(); }); app.use("/api", agentRoutes(db, {})); app.use(errorHandler);
    const response = await request(app).post(`/api/heartbeat-runs/${f.runId}/check-in`).send({ version: 1, generation: f.state.generation, sequence: 1, ...(kind === "extra_fields" ? { timeoutMs: 1 } : {}) });
    if (kind === "valid") expect(response.status, JSON.stringify(response.body)).toBe(200);
    else expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
    expect(readWorkerSupervision((await current(f.runId)).workerSupervision, f.runId)?.sequence).toBe(kind === "valid" ? 1 : 0);
  });
});
