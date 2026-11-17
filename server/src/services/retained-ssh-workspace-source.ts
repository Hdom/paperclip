import { createHash } from "node:crypto";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { environmentLeases, environments, executionWorkspaces, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { parseSshRunScope, type SshRunScopeStop } from "@paperclipai/adapter-utils/ssh-run-scope";
import { parseEnvironmentDriverConfig } from "./environment-config.js";
import { resolveEnvironmentExecutionTarget } from "./environment-execution-target.js";
import { assertControllerSafeExecutionTarget } from "./controller-execution-protection.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { SystemRecoveryFailure } from "./system-recovery-state.js";
import { nativeSha256 } from "./native-runtime/canonical.js";

export function parseRetainedSshWorkspaceSource(value: unknown) {
  const parsed = sourceSchema.safeParse(value); if (!parsed.success) throw fail(); return parsed.data;
}

export type RetainedSshSourceIdentity = { companyId: string; issueId: string; runId: string; actionId: string };
const fail = () => new SystemRecoveryFailure("source_binding_invalid", "service_required");
const endpoint = z.object({ host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(255), remoteCwd: z.string().min(1).max(4096) }).strict();
const sourceSchema = z.object({ provider: z.literal("ssh"), runId: z.string().uuid(), executionWorkspaceId: z.string().uuid(),
  leaseId: z.string().uuid(), environmentId: z.string().uuid(), providerLeaseId: z.string().min(1).max(8192),
  remoteDir: z.string().min(1).max(8192), endpoint, generation: z.string().uuid(), bootId: z.string().uuid(),
  hostKeyPolicySha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();

/** Public host policy digest; never includes private keys or secret bindings. */
export function retainedSshHostKeyPolicySha256(environmentId: string, raw: Record<string, unknown>, remoteCwd: string) {
  const parsed = parseEnvironmentDriverConfig({ driver: "ssh", config: {
    host: raw.host, port: raw.port, username: raw.username, remoteWorkspacePath: raw.remoteWorkspacePath,
    knownHosts: raw.knownHosts, strictHostKeyChecking: raw.strictHostKeyChecking, privateKey: null,
  } });
  if (parsed.driver !== "ssh" || !parsed.config.strictHostKeyChecking || !parsed.config.knownHosts) throw fail();
  const config = parsed.config;
  return createHash("sha256").update(JSON.stringify({ schema: "paperclip.ssh-endpoint-policy.v1", environmentId,
    host: config.host, port: config.port, username: config.username, remoteWorkspacePath: config.remoteWorkspacePath,
    remoteCwd, knownHosts: config.knownHosts, strictHostKeyChecking: config.strictHostKeyChecking })).digest("hex");
}

export function hasRetainedSshWorkspaceSource(value: unknown): boolean {
  const recovery = value as { schema?: unknown; source?: { provider?: unknown } } | null;
  return recovery?.schema === "paperclip.workspace-restore-recovery.v1" && recovery.source?.provider === "ssh";
}

/** Source identity is the original per-run scope/tree, not the shared SSH host URI.
 * This only admits immutable preservation; it confers no live merge or replay authority.
 */
export async function inspectRetainedSshWorkspaceSource(db: Db, input: RetainedSshSourceIdentity) {
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!run || !hasRetainedSshWorkspaceSource(run.resultJson?.workspaceRestoreRecovery)) return null;
  const recovery = run.resultJson!.workspaceRestoreRecovery as { source: unknown; leaseIds: unknown };
  const parsed = sourceSchema.safeParse(recovery.source);
  if (!parsed.success) throw fail();
  const source = parsed.data;
  const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.actionId)));
  if (!action || action.evidence.runId !== run.id || !hasRetainedSshWorkspaceSource(action.evidence.workspaceRestoreRecovery) || nativeSha256(action.evidence.workspaceRestoreRecovery) !== nativeSha256(run.resultJson!.workspaceRestoreRecovery) ||
      source.runId !== input.runId || (run.issueId ?? run.contextSnapshot?.issueId) !== input.issueId ||
      run.runtimeMode !== "legacy" || !["failed", "interrupted", "timed_out", "cancelled", "succeeded"].includes(run.status) || !run.finishedAt ||
      !Array.isArray(recovery.leaseIds) || recovery.leaseIds.length !== 1 || recovery.leaseIds[0] !== source.leaseId ||
      run.contextSnapshot?.executionWorkspaceId !== source.executionWorkspaceId) throw fail();
  if (adapterExecutionControls.has(run.id) || run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt.getTime() > Date.now())
    throw new SystemRecoveryFailure("agent_stop_unconfirmed", "recheck_evidence");
  const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.id, source.leaseId), eq(environmentLeases.heartbeatRunId, input.runId)));
  if (!lease || lease.provider !== "ssh" || lease.providerLeaseId !== source.providerLeaseId || lease.environmentId !== source.environmentId ||
      lease.issueId !== input.issueId || lease.executionWorkspaceId !== source.executionWorkspaceId || lease.metadata?.remoteExecutionScopeRequired !== true ||
      lease.metadata?.agentId !== undefined && lease.metadata.agentId !== run.agentId) throw fail();
  if (!hasRemoteTerminationReceipt(lease) || (lease.metadata?.remoteExecutionTermination as { state?: unknown })?.state !== "stopped")
    throw new SystemRecoveryFailure("agent_stop_unconfirmed", "recheck_evidence");
  const [overlap] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, "ssh"),
    eq(environmentLeases.heartbeatRunId, run.id))).limit(1);
  if (overlap) throw new SystemRecoveryFailure("allocation_ownership_ambiguous", "service_required");
  let scope;
  try { scope = parseSshRunScope(lease.metadata?.remoteExecutionScope); } catch { throw fail(); }
  if (scope.companyId !== input.companyId || scope.runId !== run.id || scope.leaseId !== lease.id ||
      scope.generation !== source.generation || scope.bootId !== source.bootId ||
      path.posix.normalize(source.endpoint.remoteCwd) !== source.endpoint.remoteCwd || !source.endpoint.remoteCwd.startsWith("/") ||
      source.remoteDir !== path.posix.join(source.endpoint.remoteCwd, ".paperclip-runtime", "runs", run.id, "workspace")) throw fail();
  const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, source.executionWorkspaceId)));
  const [environment] = await db.select().from(environments).where(eq(environments.id, source.environmentId));
  if (!workspace || workspace.sourceIssueId !== input.issueId || !environment || environment.driver !== "ssh") throw fail();
  const config = environment.config as Record<string, unknown>;
  const policy = retainedSshHostKeyPolicySha256(environment.id, config, source.endpoint.remoteCwd);
  const attestation = action.evidence.sshRecoveryEndpointAttestation as Record<string, unknown> | undefined;
  if (source.hostKeyPolicySha256 ? source.hostKeyPolicySha256 !== policy : !attestation ||
      attestation.schema !== "paperclip.ssh-recovery-endpoint-attestation.v1" || attestation.companyId !== input.companyId ||
      attestation.issueId !== input.issueId || attestation.runId !== run.id || attestation.actionId !== input.actionId ||
      attestation.leaseId !== lease.id || attestation.sourceReceiptSha256 !== nativeSha256(run.resultJson!.workspaceRestoreRecovery) ||
      typeof attestation.historicalBackupSha256 !== "string" || !/^[a-f0-9]{64}$/.test(attestation.historicalBackupSha256) ||
      attestation.hostKeyPolicySha256 !== policy || attestation.provenance !== "verified_pre_run_database_clone") throw fail();
  const target = await resolveEnvironmentExecutionTarget({ db, companyId: input.companyId, adapterType: "codex_local",
    environment: environment as unknown as Environment, leaseId: lease.id, leaseMetadata: lease.metadata,
    lease: lease as EnvironmentLease });
  if (!target || target.kind !== "remote" || target.transport !== "ssh" ||
      Object.entries(source.endpoint).some(([key, value]) => target.spec[key as keyof typeof target.spec] !== value) ||
      target.spec.remoteWorkspacePath !== lease.metadata?.remoteWorkspacePath ||
      source.providerLeaseId !== `ssh://${target.spec.username}@${target.spec.host}:${target.spec.port}${target.spec.remoteCwd}` ||
      nativeSha256(target.spec.runScope) !== nativeSha256(scope)) throw fail();
  assertControllerSafeExecutionTarget(target);
  const stop: SshRunScopeStop = { owner: scope, phase: "stopped", waitProof: "ECHILD_WALL", admissionClosed: true };
  return { run, action, lease, environment, source, target, stop, hostKeyPolicySha256: policy };
}
