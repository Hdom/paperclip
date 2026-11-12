import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, environmentLeases, environments, heartbeatRuns, nativeRunFinalizations } from "@paperclipai/db/schema/index";
import type { Db } from "@paperclipai/db/client";
import { hasRemoteTerminationReceipt, remoteTerminationReceipt } from "./remote-execution-termination.js";

/** Offline maintenance only. No HTTP route or agent-facing command imports this
 * module. Root is the attesting authority; provider JSON is not a signature.
 * The desktop producer must independently observe the authenticated host API.
 */
export type SshHostStopPreparation = {
  operationId: string; preparedAt: string; companyId: string; environmentId: string;
  leaseIds: string[]; requestIds: string[]; snapshot: string;
};
export type SshHostStopObservation = {
  schema: "paperclip.ssh-host-stop.v1"; operationId: string;
  node: string; vmid: number; configDigestBefore: string; configDigestAfter: string;
  rootfsBefore: string; rootfsAfter: string; mappedSshHost: string;
  upid: string; taskUser: string; taskType: "vzstop"; taskId: string;
  taskStatus: "stopped"; exitStatus: "OK"; taskStartedAt: string; taskEndedAt: string;
  observedAt: string; guestStatus: "stopped"; guestPid: number | null;
};
const terminal = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requireRoot() {
  if (process.getuid?.() !== 0) throw new Error("Root-only offline maintenance");
}
function reject(): never { throw new Error("SSH host-stop evidence or maintenance state changed"); }

export function validateSshHostStopObservation(prepared: SshHostStopPreparation, proof: SshHostStopObservation, host: string, now = Date.now()) {
  const times = [prepared.preparedAt, proof.taskStartedAt, proof.taskEndedAt, proof.observedAt].map(Date.parse);
  if (times.some(t => !Number.isFinite(t)) || now < times[3]! || now - times[3]! > 60_000 ||
      now - times[0]! > 15 * 60_000 || times[0]! > times[1]! + 1000 || times[1]! > times[2]! || times[2]! > times[3]!) reject();
  const parts = proof.upid.split(":");
  if (proof.schema !== "paperclip.ssh-host-stop.v1" || proof.operationId !== prepared.operationId ||
      !/^[a-zA-Z0-9_-]+$/.test(proof.node) || !Number.isInteger(proof.vmid) || proof.vmid <= 0 ||
      proof.mappedSshHost !== host || proof.configDigestBefore !== proof.configDigestAfter ||
      !/^[a-f0-9]{40}$/.test(proof.configDigestBefore) || !proof.rootfsBefore || proof.rootfsBefore !== proof.rootfsAfter ||
      proof.taskStatus !== "stopped" || proof.exitStatus !== "OK" || proof.taskType !== "vzstop" ||
      proof.taskId !== String(proof.vmid) || proof.guestStatus !== "stopped" || (proof.guestPid !== null && proof.guestPid !== 0) ||
      parts.length !== 9 || parts[0] !== "UPID" || parts[1] !== proof.node ||
      !parts.slice(2, 5).every(p => /^[A-Fa-f0-9]+$/.test(p)) || parts[5] !== "vzstop" ||
      parts[6] !== String(proof.vmid) || parts[7] !== proof.taskUser || !proof.taskUser || parts[8] !== "" ||
      Math.abs(parseInt(parts[4]!, 16) * 1000 - times[1]!) >= 1000) reject();
}

async function snapshot(db: Db, input: Pick<SshHostStopPreparation, "companyId" | "environmentId" | "leaseIds" | "requestIds">) {
  if (!input.leaseIds.length || input.leaseIds.length > 25 || new Set(input.leaseIds).size !== input.leaseIds.length ||
      !input.requestIds.length || input.requestIds.length > 25 || new Set(input.requestIds).size !== input.requestIds.length) reject();
  const [env] = await db.select().from(environments).where(eq(environments.id, input.environmentId));
  if (env?.driver !== "ssh" || typeof env.config.host !== "string" || typeof env.config.username !== "string" ||
      typeof env.config.remoteWorkspacePath !== "string" || !env.config.remoteWorkspacePath.startsWith("/") ||
      !Number.isInteger(env.config.port) || Number(env.config.port) < 1 || Number(env.config.port) > 65535) reject();
  const providerLeaseId = `ssh://${env.config.username}@${env.config.host}:${env.config.port}${env.config.remoteWorkspacePath}`;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), inArray(environmentLeases.id, input.leaseIds),
  )).orderBy(environmentLeases.id);
  if (leases.length !== input.leaseIds.length || leases.some(l => l.environmentId !== env.id || l.provider !== "ssh" ||
      !l.heartbeatRunId || !l.releasedAt || !["released", "expired", "failed"].includes(l.status) ||
      (l.cleanupStatus !== null && l.cleanupStatus !== "success") || l.providerLeaseId !== providerLeaseId ||
      l.metadata?.host !== env.config.host || l.metadata?.username !== env.config.username ||
      l.metadata?.port !== env.config.port || l.metadata?.remoteWorkspacePath !== env.config.remoteWorkspacePath)) reject();
  const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
    inArray(heartbeatRuns.id, leases.map(l => l.heartbeatRunId!)))).orderBy(heartbeatRuns.id);
  if (runs.length !== new Set(leases.map(l => l.heartbeatRunId)).size || runs.some(r => !terminal.includes(r.status) || !r.finishedAt ||
      (r.controllerLeaseExpiresAt && r.controllerLeaseExpiresAt > new Date()) || (r.controllerBootId && !r.controllerLeaseExpiresAt))) reject();
  const coordinators = await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId),
    inArray(nativeRunFinalizations.runId, runs.map(r => r.id))));
  if (coordinators.some(c => c.leaseOwner || c.failureDetail?.successorRunId)) reject();
  const requests = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId),
    inArray(agentWakeupRequests.id, input.requestIds))).orderBy(agentWakeupRequests.id);
  if (requests.length !== input.requestIds.length || requests.some(r => r.status !== "deferred_issue_execution" || r.runId || r.claimedAt ||
      r.requestedByActorType !== "user" || !r.requestedByActorId || !runs.some(run => run.agentId === r.agentId &&
        (run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId) === r.payload?.issueId))) reject();
  // Snapshot includes exact immutable identities, configuration generation,
  // pending input and historical state. Receipt changes are handled separately.
  const identity = { environment: { id: env.id, driver: env.driver, status: env.status, config: env.config, updatedAt: env.updatedAt },
    leases: leases.map(({ metadata, cleanupStatus, updatedAt, ...l }) => ({ ...l,
      metadata: Object.fromEntries(Object.entries(metadata ?? {}).filter(([k]) => !["remoteExecutionTermination", "sshHostStop"].includes(k))) })),
    runs, requests, coordinators };
  return { env, leases, runs, snapshot: digest(identity) };
}

/** Prepare while the instance is stopped and masked, before the host stop. The
 * caller stores this in a root-owned, non-writable maintenance directory. */
export async function prepareSshHostStop(db: Db, input: Omit<SshHostStopPreparation, "preparedAt" | "snapshot">, assertFenced: () => void) {
  requireRoot(); assertFenced();
  const state = await snapshot(db, input);
  return { ...input, preparedAt: new Date().toISOString(), snapshot: state.snapshot };
}

/** Only records physical stop evidence. It neither changes task state nor
 * certifies action outcomes, consumes requests, resets retries or emits a wake.
 * Existing explicit-user admission remains the sole reconciliation owner. */
export async function recordSshHostStop(db: Db, prepared: SshHostStopPreparation, proof: SshHostStopObservation, assertFenced: () => void) {
  requireRoot(); assertFenced();
  const proofHash = digest(proof);
  return db.transaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '3s'`);
    await tx.execute(sql`set local statement_timeout = '10s'`);
    // Offline maintenance locks out all acquisitions and run/request changes,
    // including a second importer. No read-then-write authority gap.
    await tx.execute(sql`lock table environments, environment_leases, heartbeat_runs, native_run_finalizations, agent_wakeup_requests in share row exclusive mode`);
    assertFenced();
    const state = await snapshot(tx as unknown as Db, prepared);
    if (state.snapshot !== prepared.snapshot) reject();
    const replay = state.leases.every(l => hasRemoteTerminationReceipt(l) &&
      (l.metadata?.sshHostStop as Record<string, unknown> | undefined)?.proofHash === proofHash);
    if (replay) {
      const [audit] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.companyId, prepared.companyId), eq(activityLog.entityId, prepared.environmentId),
        eq(activityLog.action, "environment.ssh_host_stop_verified"),
        sql`${activityLog.details}->>'operationId' = ${prepared.operationId}`, sql`${activityLog.details}->>'proofHash' = ${proofHash}`,
      )).limit(1);
      if (!audit) reject();
      return { applied: false, replay: true, leaseIds: prepared.leaseIds };
    }
    if (state.leases.some(l => l.metadata?.sshHostStop || l.metadata?.remoteExecutionTermination)) reject();
    validateSshHostStopObservation(prepared, proof, String(state.env.config.host));
    const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.status, ["running", "queued", "scheduled_retry"])).limit(1);
    const [unreleased] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(isNull(environmentLeases.releasedAt)).limit(1);
    const [newer] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.environmentId, prepared.environmentId), or(
        sql`${environmentLeases.acquiredAt} >= ${prepared.preparedAt}::timestamptz`,
        sql`${environmentLeases.createdAt} >= ${prepared.preparedAt}::timestamptz`,
        sql`${environmentLeases.lastUsedAt} >= ${prepared.preparedAt}::timestamptz`,
      ),
    )).limit(1);
    if (active || unreleased || newer || state.runs.some(r => r.finishedAt! > new Date(proof.taskStartedAt))) reject();
    for (const lease of state.leases) {
      const receipt = remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" });
      if (!receipt) reject();
      await tx.update(environmentLeases).set({ cleanupStatus: "success", updatedAt: new Date(), metadata: {
        ...lease.metadata, remoteExecutionTermination: { ...receipt, confirmedAt: proof.observedAt },
        sshHostStop: { operationId: prepared.operationId, proofHash, preparedAt: prepared.preparedAt, proof },
      } }).where(and(eq(environmentLeases.companyId, prepared.companyId), eq(environmentLeases.id, lease.id)));
    }
    await tx.insert(activityLog).values({ companyId: prepared.companyId, actorType: "system", actorId: "root:ssh-host-stop-maintenance",
      action: "environment.ssh_host_stop_verified", entityType: "environment", entityId: prepared.environmentId,
      details: { operationId: prepared.operationId, proofHash, preparedAt: prepared.preparedAt, proof,
        leaseIds: prepared.leaseIds, preservedRequestIds: prepared.requestIds, actionOutcomes: "unchanged" } });
    return { applied: true, replay: false, leaseIds: prepared.leaseIds };
  });
}
