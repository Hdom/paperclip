import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { instanceMaintenance, instanceMaintenanceEvents, instanceMaintenanceOperations, heartbeatRuns, environmentLeases, environments, issueRecoveryActions, type Db } from "@paperclipai/db";
import { conflict, HttpError } from "../errors.js";
import { currentControllerProcessStamp } from "./controller-process-identity.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { remoteTerminationReceiptSql, remoteTerminationScopeMatches } from "./remote-execution-termination.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { maintenanceContinuationReview } from "./maintenance-continuation-review.js";

import { readMaintenance, startMaintenance, MAINTENANCE_PROTOCOL,
  priorRequest, maintenanceBlockers as maintenanceBlockersCore, reconcileMaintenance as reconcileMaintenanceCore } from "./maintenance-state-core.js";
export { readMaintenance, startMaintenance, MAINTENANCE_PROTOCOL } from "./maintenance-state-core.js";
export const PUBLIC_MAINTENANCE_MESSAGE = "Maintenance temporarily holds new agent work.";
export function isMaintenanceRefusal(error: unknown) {
  return error instanceof HttpError && ["instance_maintenance","maintenance_state_unavailable","maintenance_recovery_source_changed","maintenance_recovery_revoked"]
    .includes(String((error.details as {code?:unknown}|undefined)?.code ?? ""));
}
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Pick<Db, "select" | "execute">;
export type MaintenanceSource = { companyId: string; issueId: string; runId: string; actionId: string };
export type MaintenanceRecoveryAuthority = MaintenanceSource & {
  leaseId: string; leaseGeneration: string; descriptorFingerprint: string;
  maintenanceGeneration: number; maintenanceOwnerId: string; operation: "preserve-and-recover-exact-source"; requestId: string;
};
type Permit = { id: string; generation: number; open: boolean; kind: string; executionRunId?: string;
  settlementRunId?: string; companyId?: string; agentId?: string; authority?: MaintenanceRecoveryAuthority };
const permits = new AsyncLocalStorage<Permit>();
const executionKinds = new Set(["execution", "native_execution", "environment_command", "environment_provision"]);
const settlementKinds = new Set(["environment_cleanup", "workspace_finalization", "workspace_transfer"]);

/** Call inside the SAME transaction as a final admission/claim mutation. */
export async function assertMaintenanceAdmission(tx: Reader) {
  const state = await readMaintenance(tx, "share");
  if (state.state !== "released") throw conflict(PUBLIC_MAINTENANCE_MESSAGE, { code: "instance_maintenance", generation: state.generation });
}

export async function maintenanceClosed(db: Reader) {
  try { return (await readMaintenance(db)).state !== "released"; } catch { return true; }
}

function matchingSource(authority: MaintenanceRecoveryAuthority, source: MaintenanceSource) {
  return authority.companyId === source.companyId && authority.issueId === source.issueId
    && authority.runId === source.runId && authority.actionId === source.actionId;
}

async function verifyRecoveryAuthority(db: Reader, authority: MaintenanceRecoveryAuthority) {
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, authority.runId), eq(heartbeatRuns.companyId, authority.companyId)));
  const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.id, authority.actionId),
    eq(issueRecoveryActions.companyId, authority.companyId), eq(issueRecoveryActions.sourceIssueId, authority.issueId)));
  const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, authority.leaseId),
    eq(environmentLeases.companyId, authority.companyId), eq(environmentLeases.heartbeatRunId, authority.runId)));
  const descriptor = run?.resultJson?.workspaceRestoreRecovery;
  const scope = lease?.metadata?.remoteExecutionScope as { generation?: unknown } | undefined;
  if (!run || !action || !lease || action.evidence.runId !== run.id ||
    (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) !== authority.issueId || lease.issueId !== authority.issueId ||
    scope?.generation !== authority.leaseGeneration || nativeSha256(descriptor) !== authority.descriptorFingerprint ||
    nativeSha256(action.evidence.workspaceRestoreRecovery) !== authority.descriptorFingerprint ||
    authority.operation !== "preserve-and-recover-exact-source") throw conflict("The maintenance recovery source changed.", {code:"maintenance_recovery_source_changed"});
}

/** Source-owning transactions use this before ANY adoption/hold mutation. An
 * inherited async context is not authority after its owned callback settles. */
export async function assertMaintenanceRecovery(tx: Reader, source?: MaintenanceSource) {
  const state = await readMaintenance(tx, "share");
  const permit = permits.getStore();
  if (permit?.authority) {
    if (!permit.open || state.state !== "held" || state.generation !== permit.generation || state.ownerId !== permit.authority.maintenanceOwnerId || !source || !matchingSource(permit.authority, source)) throw conflict("Maintenance recovery authority changed.", {code:"maintenance_recovery_revoked"});
    const [operation] = await tx.select().from(instanceMaintenanceOperations).where(eq(instanceMaintenanceOperations.id, permit.id));
    if (operation?.state !== "active" || nativeSha256(operation.authority) !== nativeSha256(permit.authority))
      throw conflict("Maintenance recovery permission was revoked.", {code:"maintenance_recovery_revoked"});
    await verifyRecoveryAuthority(tx, permit.authority);
  }
  if (state.state === "released") return;
  if (permit?.open && permit.authority && source && state.state === "held"
    && state.generation === permit.generation && matchingSource(permit.authority, source)) return;
  throw conflict(PUBLIC_MAINTENANCE_MESSAGE, { code: "instance_maintenance" });
}

/** Register under the gate BEFORE invoking a side effect. No transaction is
 * held during I/O. The durable row outlives DB/socket/process loss; only a fully
 * joined callback settles it. A missing finish receipt is never a time lease. */
export async function withMaintenanceOperation<T>(db: Db, kind: string, callback: () => Promise<T>,
  authority?: MaintenanceRecoveryAuthority, executionRunId?: string): Promise<{ admitted: false } | { admitted: true; value: T }> {
  const inherited = permits.getStore();
  if (!authority && !executionRunId && kind === "environment_cleanup" && inherited?.open && inherited.kind === kind) {
    await db.transaction(tx => assertSettlementPermit(tx as unknown as Reader, inherited));
    return { admitted: true, value: await callback() };
  }
  if (executionRunId && !authority && inherited?.open && inherited.executionRunId === executionRunId) {
    await db.transaction(tx => assertMaintenanceProviderAdmission(tx as unknown as Reader, executionRunId));
    return { admitted: true, value: await callback() };
  }
  if (executionRunId && !authority && inherited?.open && inherited.settlementRunId === executionRunId
    && settlementKinds.has(kind) && settlementKinds.has(inherited.kind)) {
    await db.transaction(tx => assertSettlementPermit(tx as unknown as Reader, inherited));
    return { admitted: true, value: await callback() };
  }
  const permit: Permit | null = await db.transaction(async tx => {
    const state = await readMaintenance(tx as unknown as Reader, "share");
    if (authority) {
      if (state.state !== "held" || state.generation !== authority.maintenanceGeneration || state.ownerId !== authority.maintenanceOwnerId) return null;
      // One physical recovery intent per source run and maintenance epoch,
      // including browser reloads and a different retry request UUID. This is
      // not an expiring lock or permission to rearm failed/canceled work.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`maintenance-source/${state.generation}/${authority.runId}`},0))`);
      const [priorSource]=await tx.select().from(instanceMaintenanceOperations).where(and(
        eq(instanceMaintenanceOperations.generation,state.generation),eq(instanceMaintenanceOperations.kind,"source_recovery"),
        sql`${instanceMaintenanceOperations.authority}->>'companyId' = ${authority.companyId}`,
        sql`${instanceMaintenanceOperations.authority}->>'runId' = ${authority.runId}`));
      if(priorSource)throw conflict("An original recovery request already owns this source. Inspect its receipt; no second operation was started.",
        {code:"maintenance_recovery_request_exists",requestId:priorSource.authority?.requestId});
      await verifyRecoveryAuthority(tx as unknown as Reader, authority);
    } else if (state.state !== "released") return null;
    const executionKind = executionKinds.has(kind);
    const [run] = executionRunId && executionKind ? await tx.select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, executionRunId)) : [];
    if (executionRunId && executionKind && (!run || !["queued", "running"].includes(run.status))) return null;
    const id = randomUUID();
    const scope = executionRunId ? executionKind ? { executionRunId, companyId: run!.companyId, agentId: run!.agentId }
      : { settlementRunId: executionRunId } : {};
    const inserted = await tx.insert(instanceMaintenanceOperations).values({ id, generation: state.generation, kind,
      owner: { ...currentControllerProcessStamp(), ...scope }, authority: authority ?? null }).onConflictDoNothing().returning({id:instanceMaintenanceOperations.id});
    if (!inserted.length) throw conflict("Recovery request already exists. Inspect its original receipt before retrying.");
    return { id, generation: state.generation, kind, open: true, authority, ...scope } satisfies Permit;
  });
  if (!permit) return { admitted: false };
  try { return { admitted: true, value: await permits.run(permit, callback) }; }
  finally {
    permit.open = false;
    await db.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.instanceMaintenance);
      await tx.update(instanceMaintenanceOperations).set({ state: "settled", settledAt: new Date() })
        .where(and(eq(instanceMaintenanceOperations.id, permit.id), eq(instanceMaintenanceOperations.state, "active")));
    });
  }
}

/** Final provider boundary for a run admitted before acquisition. It may finish
 * while acquiring, never while held, and remains counted until actually joined. */
export async function assertMaintenanceProviderAdmission(tx: Reader, runId: string, companyId?: string, agentId?: string, settlement = false) {
  const row = await readMaintenance(tx, "share"), permit = permits.getStore();
  if (!permit?.open || permit.authority || !executionKinds.has(permit.kind) || permit.executionRunId !== runId || row.state === "held" ||
    !(permit.generation === row.generation || row.state === "acquiring" && permit.generation + 1 === row.generation))
    throw conflict(PUBLIC_MAINTENANCE_MESSAGE, { code: "instance_maintenance" });
  const [operation] = await tx.select().from(instanceMaintenanceOperations).where(eq(instanceMaintenanceOperations.id, permit.id));
  if (operation?.state !== "active" || operation.owner.executionRunId !== runId || operation.generation !== permit.generation)
    throw conflict("Execution maintenance ownership changed.");
  const [run] = await tx.select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
    .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  if (!run || !settlement && !["queued", "running"].includes(run.status) || run.companyId !== permit.companyId || run.agentId !== permit.agentId ||
    companyId !== undefined && companyId !== run.companyId || agentId !== undefined && agentId !== run.agentId)
    throw conflict("Execution maintenance run identity changed.");
}

async function assertSettlementPermit(tx: Reader, permit: Permit) {
  const row = await readMaintenance(tx, "share");
  const [operation] = await tx.select().from(instanceMaintenanceOperations).where(eq(instanceMaintenanceOperations.id, permit.id));
  if (!permit.open || permit.authority || !settlementKinds.has(permit.kind) || row.state === "held" || operation?.state !== "active" ||
    operation.kind !== permit.kind || operation.generation !== permit.generation ||
    !(permit.generation === row.generation || row.state === "acquiring" && permit.generation + 1 === row.generation))
    throw conflict(PUBLIC_MAINTENANCE_MESSAGE, { code: "instance_maintenance" });
}

/** Settlement of this exact already-admitted execution may finish during
 * acquisition. Historical/background settlement never inherits run authority. */
export async function withMaintenanceSettlement<T>(db: Db, kind: string, runId: string | null | undefined, callback: () => Promise<T>) {
  const parent = permits.getStore();
  if (runId && parent?.open && !parent.authority && parent.executionRunId === runId && executionKinds.has(parent.kind)) {
    await db.transaction(tx => assertMaintenanceProviderAdmission(tx as unknown as Reader, runId, undefined, undefined, settlementKinds.has(kind)));
    return { admitted: true as const, value: await callback() };
  }
  return withMaintenanceOperation(db, kind, callback, undefined, runId ?? undefined);
}

/** Internal lifetime handle: opening a provider channel is not settlement.
 * Its caller settles only after a numeric process exit AND joined route close.
 * Unknown transport/open failure leaves a durable physical-stop obligation. */
export type MaintenanceChannelBinding = {
  lease: {id:string;companyId:string;environmentId:string|null;heartbeatRunId?:string|null;
    provider?:string|null;providerLeaseId?:string|null;metadata?:Record<string,unknown>|null;
    releasedAt?:Date|string|null;status:string};
  environment: {id:string;driver:string;status:string;config:Record<string,unknown>;envVars?:Record<string,unknown>|null};
};
function channelLeaseFingerprint(lease: MaintenanceChannelBinding["lease"]) {
  return nativeSha256({id:lease.id,companyId:lease.companyId,environmentId:lease.environmentId,
    heartbeatRunId:lease.heartbeatRunId??null,provider:lease.provider??null,providerLeaseId:lease.providerLeaseId??null,
    // Provider metadata is opaque execution authority. Pin unknown fields by
    // default; expiry renewal is separately validated without pinning its time.
    metadata:lease.metadata??{},
    releasedAt:lease.releasedAt??null,status:lease.status});
}
function channelEnvironmentFingerprint(environment: MaintenanceChannelBinding["environment"]) {
  return nativeSha256({id:environment.id,driver:environment.driver,status:environment.status,config:environment.config,envVars:environment.envVars??{}});
}
function channelLeaseCurrent(lease: typeof environmentLeases.$inferSelect) {
  return lease.status === "active" && lease.releasedAt === null && (!lease.expiresAt || lease.expiresAt.getTime()>Date.now())
    && remoteTerminationScopeMatches(lease.metadata, Object.hasOwn(lease.metadata ?? {},"remoteExecutionScope") ? {resourceScope:lease.metadata!.remoteExecutionScope} : {});
}
export async function registerMaintenanceChannel(db: Db, input: MaintenanceChannelBinding) {
  const parent = permits.getStore();
  const expectedLease=channelLeaseFingerprint(input.lease),expectedEnvironment=channelEnvironmentFingerprint(input.environment);
  const registered = await db.transaction(async tx => {
    const state = await readMaintenance(tx as unknown as Reader, "share");
    if (parent?.authority) throw conflict("Source recovery cannot open a provider channel.");
    if (parent?.executionRunId) await assertMaintenanceProviderAdmission(tx as unknown as Reader,parent.executionRunId,input.lease.companyId);
    else if (state.state !== "released") throw conflict(PUBLIC_MAINTENANCE_MESSAGE);
    const [lease] = await tx.select().from(environmentLeases).where(eq(environmentLeases.id,input.lease.id));
    const [environment] = await tx.select().from(environments).where(eq(environments.id,input.environment.id));
    if (!lease || !environment || !channelLeaseCurrent(lease) || environment.status!=="active" ||
      lease.environmentId!==environment.id || channelLeaseFingerprint(lease)!==expectedLease || channelEnvironmentFingerprint(environment)!==expectedEnvironment ||
      lease.heartbeatRunId && !parent?.executionRunId || parent?.executionRunId && lease.heartbeatRunId !== parent.executionRunId)
      throw conflict("Provider channel lease ownership changed.");
    const id=randomUUID();
    await tx.insert(instanceMaintenanceOperations).values({id,generation:state.generation,kind:"provider_channel",
      owner:{...currentControllerProcessStamp(),leaseId:lease.id,companyId:lease.companyId,environmentId:environment.id,
        leaseFingerprint:expectedLease,environmentFingerprint:expectedEnvironment,runId:lease.heartbeatRunId,parentOperationId:parent?.id ?? null}});
    return {id,generation:state.generation,runId:lease.heartbeatRunId};
  });
  let open=true;
  return {
    id:registered.id,
    async assertWritable() {
      await db.transaction(async tx=>{
        const state=await readMaintenance(tx as unknown as Reader,"share");
        const [op]=await tx.select().from(instanceMaintenanceOperations).where(eq(instanceMaintenanceOperations.id,registered.id));
        const [lease]=await tx.select().from(environmentLeases).where(eq(environmentLeases.id,input.lease.id));
        const [environment]=await tx.select().from(environments).where(eq(environments.id,input.environment.id));
        if(!open || op?.state!=="active" || op.generation!==registered.generation || state.state==="held" ||
          !(state.generation===registered.generation || state.state==="acquiring"&&state.generation===registered.generation+1) ||
          !lease || !environment || !channelLeaseCurrent(lease) || environment.status!=="active" ||
          channelLeaseFingerprint(lease)!==expectedLease || channelEnvironmentFingerprint(environment)!==expectedEnvironment)
          throw conflict("Provider channel admission changed.");
        if(parent?.executionRunId) {
          if(!parent.open)throw conflict("Provider execution owner settled.");
          await permits.run(parent,()=>assertMaintenanceProviderAdmission(tx as unknown as Reader,parent.executionRunId!,input.lease.companyId));
        } else if(state.state!=="released")throw conflict(PUBLIC_MAINTENANCE_MESSAGE);
      });
    },
    async settleVerifiedExitAndClose() {
      if(!open)return;
      await db.transaction(async tx=>{
        await tx.update(instanceMaintenanceOperations).set({state:"settled",settledAt:new Date()})
          .where(and(eq(instanceMaintenanceOperations.id,registered.id),eq(instanceMaintenanceOperations.state,"active")));
        await notifyDeliveryWork(tx,DELIVERY_QUEUES.instanceMaintenance);
      });
      open=false;
    },
  };
}

/** Existing physical source ownership checks still run. This wrapper adds
 * maintenance ownership without extending their filesystem or lease authority. */
export async function withMaintenanceRecovery<T>(db: Db, source: MaintenanceSource, callback: () => Promise<T>) {
  const parent = permits.getStore();
  if (parent?.authority) {
    await assertMaintenanceRecovery(db, source);
    return { admitted: true as const, value: await callback() };
  }
  return withMaintenanceOperation(db, "automatic_recovery", callback);
}

export async function revokeMaintenanceRecovery(db: Db, input: { generation: number; ownerId: string; operationId: string; actorId: string; requestId: string }) {
  return db.transaction(async tx => {
    const row = await readMaintenance(tx as unknown as Reader, "update");
    if (row.state !== "held" || row.generation !== input.generation || row.ownerId !== input.ownerId) throw conflict("Maintenance changed.");
    const [operation] = await tx.select().from(instanceMaintenanceOperations).where(eq(instanceMaintenanceOperations.id, input.operationId)).for("update");
    if (!operation?.authority || operation.generation !== row.generation || operation.state !== "active") throw conflict("Recovery operation changed.");
    await tx.update(instanceMaintenanceOperations).set({ authority: { ...operation.authority, revoked: true } }).where(eq(instanceMaintenanceOperations.id, operation.id));
    await tx.insert(instanceMaintenanceEvents).values({ generation: row.generation, action: "recovery_revoked", actorId: input.actorId,
      requestId: input.requestId, details: { operationId: operation.id } });
    return { operationId: operation.id, cancellationRequested: true, settled: false };
  });
}

export async function maintenanceBlockers(db: Reader) {
  return maintenanceBlockersCore(db, adapterExecutionControls.size);
}
export async function reconcileMaintenance(db: Db) {
  return reconcileMaintenanceCore(db, adapterExecutionControls.size);
}

export async function releaseMaintenance(db: Db, input: { actorId: string; requestId: string; generation: number; ownerId: string; reviewFingerprint?: string }) {
  return db.transaction(async tx => {
    const row = await readMaintenance(tx as unknown as Reader, "update");
    const fingerprint = nativeSha256(input);
    const prior = await priorRequest(tx, input.requestId, input.actorId, "release", fingerprint);
    if (prior) return { ...row, replayedGeneration: prior.generation };
    if (row.state !== "held" || row.generation !== input.generation || row.ownerId !== input.ownerId)
      throw conflict("Maintenance changed or has not settled. Refresh before continuing.");
    const blockers = await maintenanceBlockers(tx as unknown as Reader);
    if (Object.values(blockers).some(n => n !== 0)) throw conflict("Maintenance still has unsettled work.");
    // Do not let releasing source recovery implicitly release dependent work.
    const review = await maintenanceContinuationReview(tx as unknown as Reader, row.continuationPolicy, true);
    if (review.blockedReason) throw conflict(review.blockedReason,{code:"maintenance_readiness_decision_required"});
    if (review.savedIntentCount && input.reviewFingerprint !== review.fingerprint)
      throw conflict("Saved work needs a current reviewed continuation fingerprint before maintenance can end.", { code: "maintenance_saved_work_review_required" });
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.deferredExecutionReceipts);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceRecovery);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeWorkspaceFinalization,"*");
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.environmentCleanup);
    const [updated] = await tx.update(instanceMaintenance).set({ state: "released", updatedAt: new Date() })
      .where(eq(instanceMaintenance.singletonKey, "default")).returning();
    await tx.insert(instanceMaintenanceEvents).values({ generation: row.generation, action: "release", actorId: input.actorId,
      requestId: input.requestId, details: { ownerId: input.ownerId, blockers, requestFingerprint: fingerprint, continuationReview:review } });
    return updated;
  });
}
