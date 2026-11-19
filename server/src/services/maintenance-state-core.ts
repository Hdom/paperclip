/** Canonical persisted maintenance state and readiness. No controller startup,
 * provider loading, signing or agent invocation. Offline callers must separately
 * prove physical controller containment; a zero local map is not stop evidence.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { instanceMaintenance, instanceMaintenanceEvents, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { remoteTerminationReceiptSql } from "./remote-termination-sql.js";
import { noRetainedExecutionPredicate } from "./pre-dispatch-execution-evidence.js";
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Pick<Db,"select"|"execute">;
export const MAINTENANCE_PROTOCOL = 1;
export async function readMaintenance(db: Reader, lock?: "share" | "update") {
  const query = db.select().from(instanceMaintenance).where(eq(instanceMaintenance.singletonKey, "default"));
  const [row] = await (lock ? query.for(lock) : query);
  if (!row || row.protocolVersion !== MAINTENANCE_PROTOCOL || !["released", "acquiring", "held"].includes(row.state)
    || !["review_all", "requires_readiness_decision"].includes(row.continuationPolicy))
    throw conflict("Maintenance state cannot be verified. New work remains closed.", { code: "maintenance_state_unavailable" });
  return row;
}

export async function maintenanceBlockers(db: Reader, liveOperationCount = 0) {
  const rows = await db.execute(sql`select
    (select count(*)::int from instance_maintenance_operations where state = 'active') as operations,
    (select count(*)::int from heartbeat_runs where status = 'running'
      or (status in ('queued', 'scheduled_retry') and not ${noRetainedExecutionPredicate()})
      or runner_profile_json->>'nativeWorkspaceFinalizationOwner' is not null
      or controller_lease_expires_at is not null) as runs,
    (select count(*)::int from environment_leases where status in ('active', 'pending_cleanup')
      or coalesce(metadata->>'pendingCleanupInFlight', 'false') <> 'false'
      or (provider is not null and provider <> 'local' and provider_lease_id is not null
        and not ${sql.raw(remoteTerminationReceiptSql("environment_leases"))})) as leases,
    (select count(*)::int from native_run_finalizations where lease_owner is not null
      or phase not in ('committed', 'terminal_failure', 'applied')) as finalizations,
    (select count(*)::int from workspace_operations where status in ('running', 'pending')) as workspaces`);
  const blockers = rows[0] as unknown as { operations: number; runs: number; leases: number; finalizations: number; workspaces: number };
  return { ...blockers, operations: blockers.operations + liveOperationCount };
}

export async function reconcileMaintenance(db: Db, liveOperationCount = 0) {
  return db.transaction(async tx => {
    const row = await readMaintenance(tx as unknown as Reader, "update");
    if (row.state !== "acquiring") return row;
    const blockers = await maintenanceBlockers(tx as unknown as Reader, liveOperationCount);
    if (Object.values(blockers).some(n => n !== 0)) return row;
    const [updated] = await tx.update(instanceMaintenance).set({ state: "held", updatedAt: new Date() })
      .where(eq(instanceMaintenance.singletonKey, "default")).returning();
    await tx.insert(instanceMaintenanceEvents).values({ generation: row.generation, action: "held", actorId: "system",
      requestId: randomUUID(), details: { ownerId: row.ownerId, blockers } });
    return updated;
  });
}

export async function priorRequest(tx: Transaction, requestId: string, actorId: string, action: string, fingerprint: string) {
  const [prior] = await tx.select().from(instanceMaintenanceEvents).where(eq(instanceMaintenanceEvents.requestId, requestId));
  if (prior && (prior.actorId !== actorId || prior.action !== action || prior.details.requestFingerprint !== fingerprint)) throw conflict("Maintenance request identity changed.");
  return prior;
}

export async function startMaintenance(db: Db, input: { actorId: string; requestId: string; expectedGeneration: number; operatorNote: string;
  continuationPolicy?: "review_all" | "requires_readiness_decision" }) {
  const result = await db.transaction(async tx => {
    const row = await readMaintenance(tx as unknown as Reader, "update");
    const fingerprint = nativeSha256(input);
    const prior = await priorRequest(tx, input.requestId, input.actorId, "start", fingerprint);
    if (prior) return { ...row, replayedGeneration: prior.generation };
    if (row.state !== "released" || row.generation !== input.expectedGeneration) throw conflict("Maintenance changed. Refresh before continuing.");
    const generation = row.generation + 1, ownerId = randomUUID();
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.instanceMaintenance);
    const [updated] = await tx.update(instanceMaintenance).set({ state: "acquiring", generation, ownerId,
      operatorNote: input.operatorNote, continuationPolicy: input.continuationPolicy ?? "review_all", actorId: input.actorId, requestId: input.requestId, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(instanceMaintenance.singletonKey, "default")).returning();
    await tx.insert(instanceMaintenanceEvents).values({ generation, action: "start", actorId: input.actorId,
      requestId: input.requestId, details: { ownerId, operatorNote: input.operatorNote, continuationPolicy:input.continuationPolicy ?? "review_all", expectedGeneration: input.expectedGeneration, requestFingerprint: fingerprint } });
    return updated;
  });
  return result;
}
