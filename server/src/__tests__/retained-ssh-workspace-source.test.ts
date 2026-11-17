import { attestRetainedSshEndpointFromHistoricalEnvironment } from "../services/retained-ssh-endpoint-attestation.js";
import { retireDeferredBlockerStallWake } from "../modules/wake-queue/adapters/retire-deferred-stall.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, createDb, applyPendingMigrations, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { inspectRetainedSshWorkspaceSource, retainedSshHostKeyPolicySha256 } from "../services/retained-ssh-workspace-source.js";
import { inspectWorkspaceRecoverySource } from "../services/workspace-recovery-source.js";
import { nativeSha256 } from "../services/native-runtime/canonical.js";

let historicalWrite: ReturnType<typeof createDb>, historicalRead: ReturnType<typeof createDb>;
const historicalName = "paperclip_qualify_" + randomUUID().replaceAll("-", "").slice(0,12);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("retained-ssh-source-"); db = createDb(database.connectionString);
  await db.execute(sql`create database ${sql.identifier(historicalName)}`);
  const url = new URL(database.connectionString); url.pathname = "/" + historicalName;
  await applyPendingMigrations(url.href); historicalWrite = createDb(url.href);
  url.searchParams.set("options", "-c default_transaction_read_only=on"); historicalRead = createDb(url.href);
}, 90000);
afterAll(async () => { await historicalRead?.$client.end({timeout:1}); await historicalWrite?.$client.end({timeout:1}); await database?.cleanup(); });
afterEach(() => vi.unstubAllEnvs());
async function seed() {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), actionId = randomUUID(),
    workspaceId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID();
  const config = { host: "192.0.2.124", port: 22, username: "worker", remoteWorkspacePath: "/workspaces/fixture",
    knownHosts: "192.0.2.124 ssh-ed25519 synthetic-public-fixture", strictHostKeyChecking: true };
  vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", "1"); vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", "");
  vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS", JSON.stringify([config]));
  await db.insert(companies).values({ id: companyId, name: "Retained source fixture", issuePrefix: "R" + companyId.replaceAll("-", "") });
  await db.insert(agents).values({ id: agentId, companyId, name: "Original Coordinator", role: "engineer", adapterType: "codex_local" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Original blocked task", status: "blocked", assigneeAgentId: agentId });
  await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, name: "Original attempt",
    mode: "isolated_workspace", strategyType: "project_primary", cwd: "/metadata-only-fixture/" + runId, providerType: "local_fs" });
  await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
  await db.insert(environments).values({ id: environmentId, name: "Approved synthetic target " + environmentId, driver: "ssh", config });
  const scope = { schema: "paperclip.ssh-run-scope.v1" as const, companyId, runId, leaseId, generation: randomUUID(), bootId: randomUUID() };
  const providerLeaseId = `ssh://worker@${config.host}:22${config.remoteWorkspacePath}`;
  const source = { provider: "ssh" as const, runId, executionWorkspaceId: workspaceId, leaseId, environmentId, providerLeaseId,
    remoteDir: `${config.remoteWorkspacePath}/.paperclip-runtime/runs/${runId}/workspace`,
    endpoint: { host: config.host, port: 22, username: "worker", remoteCwd: config.remoteWorkspacePath }, generation: scope.generation, bootId: scope.bootId,
    hostKeyPolicySha256: retainedSshHostKeyPolicySha256(environmentId, config, config.remoteWorkspacePath) };
  const recovery = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId], source };
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, runtimeMode: "legacy", status: "failed",
    startedAt: new Date(Date.now() - 120000), finishedAt: new Date(Date.now() - 60000),
    contextSnapshot: { issueId, executionWorkspaceId: workspaceId }, resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery } });
  const metadata = { ...config, remoteCwd: config.remoteWorkspacePath, agentId, remoteExecutionScopeRequired: true, remoteExecutionScope: scope,
    remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId, runId, leaseId, provider: "ssh", providerLeaseId,
      state: "stopped", confirmedAt: new Date().toISOString(), resourceScope: scope } };
  await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, issueId, heartbeatRunId: runId, executionWorkspaceId: workspaceId,
    provider: "ssh", providerLeaseId, status: "failed", releasedAt: new Date(), cleanupStatus: "success", leasePolicy: "ephemeral", metadata });
  await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog", ownerType: "board",
    status: "resolved", cause: "legacy_execution_requires_reconciliation", fingerprint: runId, nextAction: "Preserve exact original output",
    evidence: { runId, workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery,
      automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", runId } } });
  return { input: { companyId, issueId, runId, actionId }, config, agentId, workspaceId, environmentId, leaseId, providerLeaseId, scope, source, recovery, metadata };
}
async function sourceUpdate(f: Awaited<ReturnType<typeof seed>>, source: Record<string, unknown>) {
  const recovery = { ...f.recovery, source };
  await db.update(heartbeatRuns).set({ resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery } }).where(eq(heartbeatRuns.id, f.input.runId));
  await db.update(issueRecoveryActions).set({ evidence: { runId: f.input.runId, workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery,
    automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", runId: f.input.runId } } }).where(eq(issueRecoveryActions.id, f.input.actionId));
}
it("admits only the exact per-run stopped source despite121 historical host-URI leases; generic recovery remains refused", async () => {
  const f = await seed();
  await db.insert(environmentLeases).values(Array.from({ length: 121 }, () => ({ companyId: f.input.companyId, provider: "ssh", providerLeaseId: f.providerLeaseId,
    status: "failed", releasedAt: new Date(), cleanupStatus: "success", leasePolicy: "ephemeral" })));
  await expect(inspectWorkspaceRecoverySource(db, f.input)).rejects.toMatchObject({ code: "allocation_ownership_ambiguous" });
  const admitted = await inspectRetainedSshWorkspaceSource(db, f.input);
  expect(admitted?.source.remoteDir).toBe(f.source.remoteDir);
  expect(admitted?.stop.owner).toEqual(f.scope);
});
it.each(["remote path", "generation", "host policy", "action mismatch", "same run overlap", "same run alias", "stop proof", "loopback", "missing original policy"])("refuses %s without changing source or grants", async mode => {
  const f = await seed();
  if (mode === "remote path") await sourceUpdate(f, { ...f.source, remoteDir: "/home/worker/.codex" });
  if (mode === "generation") await sourceUpdate(f, { ...f.source, generation: randomUUID() });
  if (mode === "host policy") await db.update(environments).set({ config: { ...f.config, knownHosts: f.config.knownHosts + " changed" } }).where(eq(environments.id, f.environmentId));
  if (mode === "action mismatch") await db.update(issueRecoveryActions).set({ evidence: { runId: randomUUID() } }).where(eq(issueRecoveryActions.id, f.input.actionId));
  if (mode === "same run overlap") await db.insert(environmentLeases).values({ companyId: f.input.companyId, heartbeatRunId: f.input.runId, provider: "ssh", providerLeaseId: f.providerLeaseId });
  if (mode === "same run alias") await db.insert(environmentLeases).values({ companyId: f.input.companyId, heartbeatRunId: f.input.runId, provider: "ssh", providerLeaseId: "ssh://worker@alias.example:22" + f.config.remoteWorkspacePath });
  if (mode === "stop proof") await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, f.leaseId));
  if (mode === "missing original policy") { const { hostKeyPolicySha256: _, ...source } = f.source; await sourceUpdate(f, source); }
  if (mode === "loopback") {
    const config = { ...f.config, host: "127.0.0.1" }, providerLeaseId = `ssh://worker@127.0.0.1:22${f.config.remoteWorkspacePath}`;
    vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS", JSON.stringify([config]));
    await db.update(environments).set({ config }).where(eq(environments.id, f.environmentId));
    await db.update(environmentLeases).set({ providerLeaseId, metadata: { ...f.metadata, host: config.host,
      remoteExecutionTermination: { ...f.metadata.remoteExecutionTermination, providerLeaseId } } }).where(eq(environmentLeases.id, f.leaseId));
    await sourceUpdate(f, { ...f.source, providerLeaseId, endpoint: { ...f.source.endpoint, host: config.host },
      hostKeyPolicySha256: retainedSshHostKeyPolicySha256(f.environmentId, config, config.remoteWorkspacePath) });
  }
  const leasesBefore = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.input.companyId));
  const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.input.runId));
  await expect(inspectRetainedSshWorkspaceSource(db, f.input)).rejects.toThrow();
  const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.input.runId));
  expect(nativeSha256(after)).toBe(nativeSha256(before));
  expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.input.companyId))).toEqual(leasesBefore);
});

it.each(["missing", "wrong-source", "wrong-stalled", "exact"])("idempotent notification retirement requires an exact audit: %s", async mode => {
  const f = await seed(), stalledIssueId = randomUUID(), stalledActionId = randomUUID();
  const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.input.companyId, agentId: f.agentId,
    source: "automation", requestedByActorType: "system", requestedByActorId: "issue-blocker-stall",
    status: "cancelled", error: "operator_retired_stall_after_source_preservation_plan",
    payload: { issueId: f.input.issueId, stalledIssueId, recoveryAction: { id: stalledActionId } } }).returning();
  if (mode !== "missing") await db.insert(activityLog).values({ companyId: f.input.companyId, actorType: "user", actorId: "operator",
    action: "issue.deferred_stall_retired", entityType: "issue", entityId: f.input.issueId, runId: f.input.runId,
    details: { wakeId: wake!.id, sourceActionId: mode === "wrong-source" ? randomUUID() : f.input.actionId,
      stalledIssueId, stalledActionId: mode === "wrong-stalled" ? randomUUID() : stalledActionId } });
  const input = { ...f.input, sourceActionId: f.input.actionId, wakeId: wake!.id, stalledIssueId, stalledActionId, actorId: "operator" };
  if (mode === "exact") await expect(retireDeferredBlockerStallWake(db, input)).resolves.toMatchObject({ alreadyRetired: true, dispatchCreated: false });
  else await expect(retireDeferredBlockerStallWake(db, input)).rejects.toThrow(/retirement receipt/);
  expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id)))[0]).toMatchObject({ status: "cancelled", runId: null });
});

it.each(["saved historical proof", "wrong digest", "writable historical pool", "post-run historical edit", "changed current host key"])("legacy endpoint attestation: %s", async mode => {
  const f = await seed();
  const { hostKeyPolicySha256, ...legacySource } = f.source;
  await sourceUpdate(f, legacySource);
  await db.update(environments).set({ updatedAt: new Date(0) }).where(eq(environments.id, f.environmentId));
  await historicalWrite.insert(environments).values({ id: f.environmentId, name: "Historical synthetic target " + f.environmentId,
    driver: "ssh", config: f.config, updatedAt: mode === "post-run historical edit" ? new Date() : new Date(0) });
  if (mode === "changed current host key") await db.update(environments).set({ config: { ...f.config, knownHosts: f.config.knownHosts + " changed" } }).where(eq(environments.id, f.environmentId));
  const input = { ...f.input, historicalDb: mode === "writable historical pool" ? historicalWrite : historicalRead,
    historicalDatabase: historicalName, historicalBackupSha256: "a".repeat(64),
    expectedHostKeyPolicySha256: mode === "wrong digest" ? "b".repeat(64) : hostKeyPolicySha256, actorId: "operator" };
  if (mode === "saved historical proof") {
    await expect(attestRetainedSshEndpointFromHistoricalEnvironment(db, input)).resolves.toMatchObject({ alreadyAttested: false });
    await expect(attestRetainedSshEndpointFromHistoricalEnvironment(db, input)).resolves.toMatchObject({ alreadyAttested: true });
    expect((await inspectRetainedSshWorkspaceSource(db, f.input))?.source.remoteDir).toBe(f.source.remoteDir);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.input.actionId));
    expect(action.evidence.sshRecoveryEndpointAttestation).toMatchObject({ historicalBackupSha256: "a".repeat(64), runId: f.input.runId });
  } else {
    await expect(attestRetainedSshEndpointFromHistoricalEnvironment(db, input)).rejects.toThrow();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.input.actionId));
    expect(action.evidence.sshRecoveryEndpointAttestation).toBeUndefined();
    await expect(inspectRetainedSshWorkspaceSource(db, f.input)).rejects.toThrow();
  }
});
