import { sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";

/** Whole persisted row, with timestamps represented as epochs rather than
 * session-timezone-dependent JSON strings. Includes payload and cancellation.
 */
export function stallWakeSha256(w: SQL = sql`${agentWakeupRequests}`) {
  return sql<string>`encode(sha256(convert_to((to_jsonb(${w})
    - 'created_at' - 'updated_at' - 'requested_at' - 'claimed_at' - 'finished_at'
    || jsonb_build_object('created_at', extract(epoch from ${w}.created_at),
      'updated_at', extract(epoch from ${w}.updated_at), 'requested_at', extract(epoch from ${w}.requested_at),
      'claimed_at', extract(epoch from ${w}.claimed_at), 'finished_at', extract(epoch from ${w}.finished_at)))::text, 'UTF8')), 'hex')`;
}

/** Only nonsecret stop/owner identity, never lease configuration or credentials. */
export function stallSourceLeaseProof(l: SQL) {
  return sql<Record<string, unknown>>`jsonb_build_object('id', ${l}.id, 'companyId', ${l}.company_id,
    'runId', ${l}.heartbeat_run_id, 'issueId', ${l}.issue_id, 'agentId', ${l}.metadata->'agentId',
    'scopeRequired', ${l}.metadata->'remoteExecutionScopeRequired', 'workspaceId', ${l}.execution_workspace_id, 'environmentId', ${l}.environment_id,
    'provider', ${l}.provider, 'providerLeaseId', ${l}.provider_lease_id, 'status', ${l}.status,
    'cleanupStatus', ${l}.cleanup_status, 'releasedAt', extract(epoch from ${l}.released_at),
    'scope', ${l}.metadata->'remoteExecutionScope', 'termination', ${l}.metadata->'remoteExecutionTermination')`;
}

/** An owner-written receipt is bound to the unchanged cancellation, actual
 * public pause audit and immutable source snapshot ledger. No marker in an
 * agent payload or error string can manufacture this disposition.
 */
export function reconciledStallCancellation(w: SQL = sql`${agentWakeupRequests}`) {
  return sql`(${w}.status = 'cancelled' and ${w}.run_id is null and ${w}.claimed_at is null
    and ${w}.error = 'Agent lifecycle stop requested'
    and exists (select 1 from activity_log d
      join activity_log pause on pause.id::text = d.details->>'pauseActivityId'
      join workspace_operations snapshot on snapshot.id::text = d.details->>'snapshotOperationId'
      join issue_recovery_actions source on source.id::text = d.details->>'sourceActionId'
      join heartbeat_runs retained on retained.id = d.run_id and retained.company_id = d.company_id
      join environment_leases lease on lease.id::text = retained.result_json#>>'{workspaceRestoreRecovery,source,leaseId}'
        and lease.company_id = d.company_id and lease.heartbeat_run_id = retained.id
      where d.company_id = ${w}.company_id and d.actor_type = 'user'
        and d.action = 'issue.stall_cancellation_reconciled' and d.entity_type = 'issue'
        and d.entity_id = ${w}.payload->>'issueId' and d.details->>'wakeId' = ${w}.id::text
        and d.details->>'cancellationSha256' = ${stallWakeSha256(w)}
        and d.details->>'stalledIssueId' = ${w}.payload->>'stalledIssueId'
        and d.details->>'stalledActionId' = ${w}.payload#>>'{recoveryAction,id}'
        and pause.company_id = d.company_id and pause.actor_type = 'user'
        and pause.action = 'company.updated' and pause.entity_type = 'company'
        and pause.entity_id = d.company_id::text and pause.details->>'status' = 'paused'
        and pause.created_at <= ${w}.finished_at and pause.created_at >= ${w}.created_at
        and snapshot.company_id = d.company_id and snapshot.issue_id::text = d.entity_id
        and snapshot.heartbeat_run_id = d.run_id and snapshot.phase = 'workspace_recovery_snapshot'
        and snapshot.status = 'succeeded' and snapshot.metadata->>'recoveryActionId' = source.id::text
        and snapshot.metadata#>>'{archive,sha256}' = d.details->>'snapshotSha256'
        and snapshot.metadata->'archive' = d.details->'archiveDescriptor'
        and source.company_id = d.company_id and source.source_issue_id::text = d.entity_id
        and source.evidence->>'runId' = d.run_id::text
        and retained.result_json->'workspaceRestoreRecovery' = d.details->'sourceDescriptor'
        and source.evidence->'workspaceRestoreRecovery' = d.details->'sourceDescriptor'
        and snapshot.metadata->'sourceProof' = d.details->'sourceProof'
        and (source.evidence->'sshRecoveryEndpointAttestation') is not distinct from nullif(d.details->'endpointAttestation', 'null'::jsonb)
        and ${stallSourceLeaseProof(sql`lease`)} = d.details->'leaseProof'))`;
}

/** Called again inside the queue's issue-row admission lock. A sweep may have
 * selected a candidate before the owner committed reconciliation.
 */
export async function isReconciledBlockerStall(db: Db, companyId: string, issueId: string,
  context: Record<string, unknown> | null | undefined) {
  const stall = context?.blockerStall as { stalledIssueId?: unknown; recoveryAction?: { id?: unknown } } | undefined;
  if (typeof stall?.stalledIssueId !== "string" || typeof stall.recoveryAction?.id !== "string") return false;
  const rows = await db.execute(sql`select 1 from ${agentWakeupRequests} where
    ${agentWakeupRequests.companyId} = ${companyId} and ${agentWakeupRequests.payload}->>'issueId' = ${issueId}
    and ${agentWakeupRequests.requestedByActorType} = 'system'
    and ${agentWakeupRequests.requestedByActorId} = 'issue-blocker-stall'
    and ${agentWakeupRequests.payload}->>'stalledIssueId' = ${stall.stalledIssueId}
    and ${agentWakeupRequests.payload}#>>'{recoveryAction,id}' = ${stall.recoveryAction.id}
    and ${reconciledStallCancellation()} limit 1`);
  return rows.length > 0;
}
