import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { retiredReusableLeasePredecessors } from "./environment-lease-handoff.js";

type Lease = typeof environmentLeases.$inferSelect;

type LeaseIdentity = {
  id: string; companyId: string; heartbeatRunId: string | null;
  provider: string | null; providerLeaseId: string | null;
  metadata?: Record<string, unknown> | null;
};

/** Optional normalized resource ownership. Existing providers/leases with
 * neither field keep their contract; losing either side never downgrades proof.
 * The provider owns the opaque identity schema. Core binds it without parsing
 * SSH protocol fields, and SQL consumers share the exact same policy below. */
export function remoteTerminationScopeMatches(metadata: Record<string, unknown> | null | undefined, receipt: {resourceScope?: unknown} | null) {
  const hasScope = Object.hasOwn(metadata ?? {}, "remoteExecutionScope");
  const hasReceiptScope = Object.hasOwn(receipt ?? {}, "resourceScope");
  const required = Object.hasOwn(metadata ?? {}, "remoteExecutionScopeRequired");
  if (required && metadata!.remoteExecutionScopeRequired !== true) return false;
  if (hasScope !== hasReceiptScope || required && !hasScope) return false;
  if (!hasScope) return true;
  const scope = metadata!.remoteExecutionScope as Record<string, unknown> | null;
  return Boolean(scope && typeof scope === "object" && !Array.isArray(scope) && typeof scope.schema === "string" &&
    Object.hasOwn(scope, "schema") && Object.hasOwn(scope, "generation") && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(scope.schema) && typeof scope.generation === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(scope.generation) &&
    isDeepStrictEqual(scope, receipt!.resourceScope));
}

export function remoteTerminationScopeSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("Fixed SQL alias required");
  const metadata = `coalesce(${alias}.metadata, '{}'::jsonb)`;
  const receipt = `coalesce(${alias}.metadata->'remoteExecutionTermination', '{}'::jsonb)`;
  const scope = `${metadata}->'remoteExecutionScope'`;
  return `((NOT (${metadata} ? 'remoteExecutionScopeRequired') OR ${metadata}->'remoteExecutionScopeRequired' = 'true'::jsonb)
    AND ((NOT (${metadata} ? 'remoteExecutionScope') AND NOT (${receipt} ? 'resourceScope')
      AND NOT (${metadata} ? 'remoteExecutionScopeRequired'))
    OR (${metadata} ? 'remoteExecutionScope' AND ${receipt} ? 'resourceScope'
      AND jsonb_typeof(${scope}) = 'object' AND jsonb_typeof(${scope}->'schema') = 'string'
      AND ${scope}->>'schema' ~ '^[a-zA-Z0-9_.:/-]{1,128}$' AND jsonb_typeof(${scope}->'generation') = 'string'
      AND ${scope}->>'generation' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      AND ${scope} = ${receipt}->'resourceScope'))) `;
}

/** Bind a provider receipt to the exact host-owned lease and run. Old plugins
 * return void; that remains supported but grants no continuation authority. */
export function remoteTerminationReceipt(lease: LeaseIdentity, value: unknown) {
  const receipt = value as { providerLeaseId?: unknown; state?: unknown; resourceScope?: unknown } | null;
  if (!lease.heartbeatRunId || !lease.provider || lease.provider === "local" ||
      !lease.providerLeaseId || receipt?.providerLeaseId !== lease.providerLeaseId ||
      !["stopped", "destroyed"].includes(String(receipt?.state)) || !remoteTerminationScopeMatches(lease.metadata, receipt)) return undefined;
  return {
    schema: "paperclip.remote-termination.v1", companyId: lease.companyId,
    runId: lease.heartbeatRunId, leaseId: lease.id, provider: lease.provider,
    providerLeaseId: lease.providerLeaseId, state: receipt!.state,
    confirmedAt: new Date().toISOString(),
    ...(Object.hasOwn(lease.metadata ?? {}, "remoteExecutionScope") ? { resourceScope: lease.metadata!.remoteExecutionScope } : {}),
  };
}

export function hasRemoteTerminationReceipt(lease: LeaseIdentity & {
  releasedAt: unknown; cleanupStatus: string | null; status: string;
  metadata: Record<string, unknown> | null;
}): boolean {
  const receipt = lease.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined;
  return Boolean(lease.releasedAt && lease.cleanupStatus === "success" &&
    ["released", "expired", "failed"].includes(lease.status) && receipt &&
    receipt.schema === "paperclip.remote-termination.v1" &&
    receipt.companyId === lease.companyId && receipt.runId === lease.heartbeatRunId &&
    receipt.leaseId === lease.id && receipt.provider === lease.provider &&
    remoteTerminationReceipt(lease, receipt));
}

/** Workspace recovery saved this run's files, re-stopped its sandbox, and then
 * queued the stopped sandbox for destroy. The destroy is resource cleanup: the
 * stop receipt it carried forward still proves no provider can run there. */
export function hasRecoveredCleanupStopReceipt(lease: LeaseIdentity & {
  releasedAt: unknown; status: string; metadata: Record<string, unknown> | null;
}): boolean {
  const cleanup = lease.metadata?.workspaceRecoveryCleanup as Record<string, unknown> | undefined;
  if (!cleanup || cleanup.runId !== lease.heartbeatRunId || !lease.releasedAt ||
      !["pending_cleanup", "released", "expired", "failed"].includes(lease.status)) return false;
  return hasRemoteTerminationReceipt({ ...lease, status: "released", cleanupStatus: "success",
    metadata: { ...lease.metadata, remoteExecutionTermination: cleanup.stopReceipt } });
}

export function remoteLeaseCleanupScope(lease: Pick<LeaseIdentity, "provider" | "providerLeaseId">) {
  return lease.provider && lease.provider !== "local" && lease.providerLeaseId
    ? JSON.stringify([lease.provider, lease.providerLeaseId]) : undefined;
}

export async function resolveRemoteTerminationLease(db: Db, lease: Lease): Promise<Lease> {
  if (hasRemoteTerminationReceipt(lease) || lease.status !== "expired" ||
      lease.leasePolicy !== "reuse_by_environment" || !lease.provider || !lease.providerLeaseId) return lease;
  const history = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.provider, lease.provider), eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
  ));
  const current = history.find(row => row.id === lease.id);
  if (!current || current.companyId !== lease.companyId || current.heartbeatRunId !== lease.heartbeatRunId) return lease;
  const tips = history.filter(row => !Object.hasOwn(row.metadata ?? {}, "reusableLeaseSuccessor"));
  if (tips.length !== 1) return current;
  const tip = tips[0]!;
  const receipt = tip.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined;
  if (!hasRemoteTerminationReceipt(tip) || receipt?.state !== "destroyed") return current;
  const predecessors = retiredReusableLeasePredecessors(tip, history.filter(row => row.id !== tip.id));
  if (!predecessors?.some(row => row.id === current.id)) return current;
  const termination = remoteTerminationReceipt(current, { providerLeaseId: current.providerLeaseId, state: "destroyed" });
  if (!termination) return current;
  return { ...current, metadata: { ...current.metadata, remoteExecutionTermination: {
    ...termination, confirmedAt: receipt.confirmedAt,
  } } };
}

export async function stoppedRemoteCleanupScopes(db: Db, companyId: string, runId: string) {
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
  ));
  if (leases.length === 0) return null;
  const resolved = await Promise.all(leases.map(lease => resolveRemoteTerminationLease(db, lease)));
  if (!resolved.every(hasRemoteTerminationReceipt)) return null;
  return [...new Set(resolved.map(lease => remoteLeaseCleanupScope(lease)!))];
}

export async function remoteExecutionHasStopped(db: Db, companyId: string, runId: string) {
  return await stoppedRemoteCleanupScopes(db, companyId, runId) !== null;
}
