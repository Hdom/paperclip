import { adapterExecutionControls } from "./adapter-execution-control.js";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, lte, ne, or } from "drizzle-orm";
import { activityLog, agents, companies, environmentLeases, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { readWorkerSupervision, workerCheckInSchema, workerSupervisionConfigSchema,
  WORKER_CHECK_IN_TIMEOUT_MS, type WorkerSupervisionState } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { writeExecutionControl } from "./execution-control-notifications.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { hasNativeLocalProcessStop, recordedLocalExecutionStopped } from "./native-local-process-stop.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;
const queue = DELIVERY_QUEUES.executionFinalization;
const taskId = (run: Pick<Run, "issueId" | "contextSnapshot">) => run.issueId ??
  (typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null);
async function lockTask(tx: Db, run: Pick<Run, "companyId" | "issueId" | "contextSnapshot">) {
  const id = taskId(run);
  // Run attribution/event writes can also reference the task. Use Stop's order
  // even when this transition only changes liveness fields on the run itself.
  if (id) await tx.select({ id: issues.id }).from(issues).where(and(
    eq(issues.id, id), eq(issues.companyId, run.companyId))).for("update");
}


async function recordMissedCheckIn(tx: Db, run: Run, state: WorkerSupervisionState) {
    await appendHeartbeatRunEvent(tx, { companyId: run.companyId, runId: run.id, agentId: run.agentId,
      eventType: "worker.check_in_missed", stream: "system", level: "warn",
      message: "Worker missed its check-in; execution may still be running. No retry or replacement is authorized.",
      payload: { generation: state.generation, sequence: state.sequence, timeoutMs: state.timeoutMs } });
    await tx.insert(activityLog).values({ companyId: run.companyId, actorType: "system", actorId: "system",
      agentId: run.agentId, runId: run.id, action: "heartbeat.check_in_missed", entityType: "heartbeat_run",
      entityId: run.id, details: { generation: state.generation, sequence: state.sequence } });
}

/** Called by the admitted executor, never by a wake payload or provider output. */
export async function startWorkerSupervision(db: Db, run: Run, agent: Agent,
  config: Record<string, unknown>, options: { now?: Date; transport?: "local" | "ssh" | "sandbox" } = {}): Promise<WorkerSupervisionState | null> {
  const now = options.now ?? new Date();
  const raw = agent.runtimeConfig?.workerSupervision;
  if (raw === undefined && run.workerSupervision == null) return null;
  if (run.runtimeMode !== "legacy" || agent.adapterType !== "codex_local" || config.engine !== "cli"
    || (options.transport !== undefined && !["local", "ssh"].includes(options.transport)))
    throw conflict("Check-in supervision requires explicitly selected legacy Codex CLI execution on local or SSH");
  if (raw !== undefined) workerSupervisionConfigSchema.parse(raw);
  return writeExecutionControl(db, queue, async tx => {
    await lockTask(tx, run);
    const [current] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, agent.companyId),
      eq(heartbeatRuns.agentId, agent.id))).for("update");
    if (!current || current.status !== "running" || current.runtimeMode !== "legacy"
      || current.resultJson?.startupCancellation || current.resultJson?.executionCancellation || current.resultJson?.cancellation
      || current.controllerBootId !== run.controllerBootId)
      throw conflict("Worker execution ownership changed before supervision started");
    if (current.workerSupervision != null) {
      const saved = readWorkerSupervision(current.workerSupervision, current.id);
      if (!saved || saved.controllerSettledAt) throw conflict("Worker supervision cannot be reset or restarted");
      return saved; // Restart/adoption cannot grant a new grace window.
    }
    const state: WorkerSupervisionState = {
      version: 1, mode: "check_in", runId: run.id, generation: randomUUID(),
      timeoutMs: WORKER_CHECK_IN_TIMEOUT_MS, sequence: 0, state: "healthy",
      startedAt: now.toISOString(), lastCheckInAt: null,
      deadlineAt: new Date(now.getTime() + WORKER_CHECK_IN_TIMEOUT_MS).toISOString(),
      missedAt: null, controllerSettledAt: null,
    };
    await tx.update(heartbeatRuns).set({ workerSupervision: state,
      workerCheckInDeadlineAt: new Date(state.deadlineAt!), updatedAt: now }).where(eq(heartbeatRuns.id, run.id));
    return state;
  }, { companyId: run.companyId, agentId: run.agentId, runId: run.id, issueId: taskId(run) ?? undefined });
}

/** An authenticated liveness report. It grants neither execution nor stop authority. */
export async function checkInWorker(db: Db, input: {
  companyId: string; agentId: string; runId: string;
  request: unknown;
}, now = new Date()) {
  const request = workerCheckInSchema.parse(input.request);
  const [observed] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId))).limit(1);
  if (!observed) throw notFound("Heartbeat run not found");
  const issueId = observed.issueId ?? (typeof observed.contextSnapshot?.issueId === "string" ? observed.contextSnapshot.issueId : null);
  return writeExecutionControl(db, queue, async tx => {
    // Match Stop/checkout lock order. Never re-adopt an old task claim.
    const [issue] = issueId ? await tx.select().from(issues).where(and(
      eq(issues.id, issueId), eq(issues.companyId, input.companyId))).for("update") : [];
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId))).for("update");
    const state = run && readWorkerSupervision(run.workerSupervision, run.id);
    if (!run || run.status !== "running" || !state || state.controllerSettledAt
      || run.resultJson?.startupCancellation || run.resultJson?.executionCancellation
      || run.resultJson?.cancellation)
      throw conflict("Worker check-in no longer owns active execution");
    if (issueId && (!issue || issue.executionRunId !== run.id
      || (issue.checkoutRunId !== null && issue.checkoutRunId !== run.id)
      || issue.assigneeAgentId !== input.agentId || issue.assigneeUserId))
      throw conflict("Worker task execution ownership changed");
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, input.agentId),
      eq(agents.companyId, input.companyId))).limit(1);
    const [company] = await tx.select({ status: companies.status }).from(companies)
      .where(eq(companies.id, input.companyId)).limit(1);
    if (!agent || !["idle", "active", "running"].includes(agent.status)
      || agent.lifecycleState !== "ready" || company?.status !== "active")
      throw forbidden("Worker is no longer admitted for healthy check-ins");
    if (request.generation !== state.generation) throw conflict("Worker check-in generation changed");
    if (request.sequence === state.sequence) return { accepted: true, ...state, duplicate: true };
    if (request.sequence !== state.sequence + 1) throw conflict("Worker check-in sequence is stale or out of order");
    const expired = state.deadlineAt !== null && new Date(state.deadlineAt) <= now;
    const recovered = state.state === "suspected_disconnected" || expired;
    if (expired && state.state === "healthy") await recordMissedCheckIn(tx, run, state);
    const next: WorkerSupervisionState = { ...state, sequence: request.sequence, state: "healthy",
      missedAt: state.missedAt ?? (expired ? state.deadlineAt : null),
      lastCheckInAt: now.toISOString(), deadlineAt: new Date(now.getTime() + state.timeoutMs).toISOString() };
    await tx.update(heartbeatRuns).set({ workerSupervision: next,
      workerCheckInDeadlineAt: new Date(next.deadlineAt!), updatedAt: now }).where(eq(heartbeatRuns.id, run.id));
    await tx.insert(activityLog).values({ companyId: run.companyId, actorType: "agent", actorId: run.agentId,
      agentId: run.agentId, runId: run.id, action: "heartbeat.worker_check_in", entityType: "heartbeat_run",
      entityId: run.id, details: { generation: state.generation, sequence: next.sequence } });
    if (recovered) await appendHeartbeatRunEvent(tx, { companyId: run.companyId, runId: run.id,
      agentId: run.agentId, eventType: "worker.check_in_recovered", stream: "system", level: "info",
      message: "Worker check-ins resumed on the same execution; stop uncertainty remains independent",
      payload: { generation: state.generation, sequence: next.sequence } });
    return { accepted: true, ...next, duplicate: false };
  }, { companyId: input.companyId, agentId: input.agentId, runId: input.runId, issueId: taskId(observed) ?? undefined });
}

/** Provider/controller settlement is deliberately not called a termination receipt. */
export async function settleWorkerSupervision(db: Db, runId: string, companyId: string, generation: string, now = new Date()) {
  const [observed] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).limit(1);
  if (!observed) return;
  return writeExecutionControl(db, queue, async tx => {
    await lockTask(tx, observed);
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.companyId, companyId))).for("update");
    const state = run && readWorkerSupervision(run.workerSupervision, runId);
    if (!state || state.generation !== generation || state.controllerSettledAt) return;
    if (state.state === "healthy" && state.deadlineAt && new Date(state.deadlineAt) <= now)
      await recordMissedCheckIn(tx, run!, state);
    await tx.update(heartbeatRuns).set({ workerCheckInDeadlineAt: null,
      workerSupervision: { ...state, state: "controller_settled", deadlineAt: null,
        controllerSettledAt: now.toISOString(),
        missedAt: state.missedAt ?? (state.deadlineAt && new Date(state.deadlineAt) <= now ? state.deadlineAt : null) }, updatedAt: now }).where(eq(heartbeatRuns.id, runId));
  }, { companyId, agentId: observed.agentId, runId, issueId: taskId(observed) ?? undefined });
}

/** One concrete deadline per active obligation; no timer/empty-work polling here. */
export async function reconcileWorkerCheckIns(db: Db, now = new Date()) {
  const due = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, issueId: heartbeatRuns.issueId, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
    .where(and(isNotNull(heartbeatRuns.workerCheckInDeadlineAt), or(lte(heartbeatRuns.workerCheckInDeadlineAt, now),
      ne(heartbeatRuns.status, "running")))).limit(100);
  let missed = 0;
  for (const item of due) await writeExecutionControl(db, queue, async tx => {
    await lockTask(tx, item);
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, item.id),
      eq(heartbeatRuns.companyId, item.companyId))).for("update");
    if (!run?.workerCheckInDeadlineAt) return;
    const state = readWorkerSupervision(run.workerSupervision, run.id);
    if (run.status !== "running" || !state || state.controllerSettledAt) {
      await tx.update(heartbeatRuns).set({ workerCheckInDeadlineAt: null }).where(eq(heartbeatRuns.id, run.id));
      return;
    }
    if (run.workerCheckInDeadlineAt > now || state.state !== "healthy") return;
    await tx.update(heartbeatRuns).set({ workerCheckInDeadlineAt: null,
      workerSupervision: { ...state, state: "suspected_disconnected", deadlineAt: null,
        missedAt: state.missedAt ?? now.toISOString() }, updatedAt: now }).where(eq(heartbeatRuns.id, run.id));
    await recordMissedCheckIn(tx, run, state);
    missed++;
  }, { companyId: item.companyId, runId: item.id, issueId: taskId(item) ?? undefined });
  return { checked: due.length, missed };
}

/** Missing check-ins/controller ownership are not physical stop evidence. */
export async function supervisedWorkerStopPending(db: Db, run: Run): Promise<boolean> {
  const state = readWorkerSupervision(run.workerSupervision, run.id);
  if (!state) return run.workerSupervision != null;
  // Unsuccessful settlement can mean only that the SSH client stopped.
  // A still-live remote worker must not gain a retry before its first deadline.
  if (!state.missedAt && state.controllerSettledAt && run.status === "succeeded") return false;
  if (adapterExecutionControls.has(run.id)) return true;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
  if (leases.some(lease => lease.provider !== "local")) return !leases.every(hasRemoteTerminationReceipt);
  return !(run.processPid || run.processGroupId
    ? await recordedLocalExecutionStopped(db, run)
    : await hasNativeLocalProcessStop(db, run.companyId, run.id));
}
