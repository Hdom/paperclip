import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { prepareSshHostStop, recordSshHostStop, validateSshHostStopObservation, type SshHostStopObservation } from "./ssh-host-stop-receipt.js";
import { heartbeatService } from "./heartbeat.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { isPreDispatchRepairCancellationVerified } from "./pre-dispatch-repair-cancellation.js";

async function asRoot<T>(fn: () => Promise<T>) {
  const mock = vi.spyOn(process, "getuid").mockReturnValue(0);
  try { return await fn(); } finally { mock.mockRestore(); }
}
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("root-only audited SSH host stop", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("ssh-host-stop-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Host stop", issuePrefix: `H${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", adapterType: "codex_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Keep checkpoint", status: "todo", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `SSH ${environmentId}`, driver: "ssh", config: { host: "192.0.2.124", port: 22, username: "worker", remoteWorkspacePath: "/workspaces/pilot" } });
    const leaseIds: string[] = [], runIds: string[] = [], requestIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const runId = randomUUID(), leaseId = randomUUID(), requestId = randomUUID();
      runIds.push(runId); leaseIds.push(leaseId); requestIds.push(requestId);
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, runtimeMode: "legacy", status: "succeeded",
        contextSnapshot: { issueId }, startedAt: new Date(Date.now() - 60000), finishedAt: new Date(Date.now() - 30000) });
      await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId, issueId, provider: "ssh",
        providerLeaseId: "ssh://worker@192.0.2.124:22/workspaces/pilot", status: "released", acquiredAt: new Date(Date.now() - 60000),
        releasedAt: new Date(Date.now() - 30000), metadata: { host: "192.0.2.124", username: "worker", port: 22, remoteWorkspacePath: "/workspaces/pilot", retainedCheckpoint: "unchanged" } });
      await db.insert(agentWakeupRequests).values({ id: requestId, companyId, agentId, source: "on_demand", requestedByActorType: "user",
        requestedByActorId: "board", status: "deferred_issue_execution", payload: { issueId, commentId: randomUUID() } });
    }
    const fenced = vi.fn(() => {});
    const prepared = await asRoot(() => prepareSshHostStop(db, { operationId: randomUUID(), companyId, environmentId, leaseIds, requestIds }, fenced));
    const started = Math.floor(Date.now() / 1000);
    const proof: SshHostStopObservation = { schema: "paperclip.ssh-host-stop.v1", operationId: prepared.operationId, node: "pve", vmid: 124,
      configDigestBefore: "a".repeat(40), configDigestAfter: "a".repeat(40), rootfsBefore: "local-zfs:subvol-124-disk-0,size=30G",
      rootfsAfter: "local-zfs:subvol-124-disk-0,size=30G", mappedSshHost: "192.0.2.124", taskUser: "operator@pam!desktop",
      upid: `UPID:pve:00000100:00000200:${started.toString(16).toUpperCase()}:vzstop:124:operator@pam!desktop:`,
      taskType: "vzstop", taskId: "124", taskStatus: "stopped", exitStatus: "OK", taskStartedAt: new Date(started * 1000).toISOString(),
      taskEndedAt: new Date().toISOString(), observedAt: new Date().toISOString(), guestStatus: "stopped", guestPid: 0 };
    return { companyId, agentId, issueId, environmentId, runIds, leaseIds, requestIds, prepared, proof, fenced };
  }
  async function leases(f: Awaited<ReturnType<typeof seed>>) {
    return db.select().from(environmentLeases).where(eq(environmentLeases.environmentId, f.environmentId)).orderBy(environmentLeases.id);
  }
  it("records exact canonical receipts once and preserves pending input, checkpoint metadata and run history", async () => {
    const f = await seed(), beforeRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const beforeRequests = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const result = await asRoot(() => recordSshHostStop(db, f.prepared, f.proof, f.fenced));
    expect(result).toMatchObject({ applied: true, replay: false });
    expect((await leases(f)).every(hasRemoteTerminationReceipt)).toBe(true);
    expect((await leases(f)).every(l => l.metadata?.retainedCheckpoint === "unchanged")).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toEqual(beforeRuns);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(beforeRequests);
    expect(await asRoot(() => recordSshHostStop(db, f.prepared, f.proof, f.fenced))).toMatchObject({ applied: false, replay: true });
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(1);
    expect(f.fenced).toHaveBeenCalledTimes(5);
  });
  it("lets existing admission reconcile a never-dispatched repair and consume duplicate saved input only once", async () => {
    const f = await seed(), repairId = randomUUID(), repairWake = randomUUID(), commentId = randomUUID();
    const finishedAt = new Date(Date.now() - 1000), dueAt = new Date(Date.now() - 2000), fingerprint = `repair:${repairId}`;
    const message = "Scheduled disposition repair suppressed because the source state changed or gained a durable path";
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "board", body: "Continue the retained checkpoint." });
    for (const id of f.requestIds) await db.update(agentWakeupRequests).set({ reason: "issue_commented", updatedAt: new Date(0),
      payload: { issueId: f.issueId, commentId, executionWait: { reason: "execution_recovery" },
        _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: commentId, wakeCommentIds: [commentId] } },
    }).where(eq(agentWakeupRequests.id, id));
    await db.insert(agentWakeupRequests).values({ id: repairWake, companyId: f.companyId, agentId: f.agentId, source: "automation", triggerDetail: "system",
      reason: "issue_disposition_repair", runId: repairId, status: "cancelled", finishedAt, requestedByActorType: "system",
      idempotencyKey: `issue_disposition_repair:${f.issueId}:${fingerprint}:1`,
      payload: { issueId: f.issueId, dispositionRepairFingerprint: fingerprint, dispositionRepairAttempt: 1 } });
    await db.insert(heartbeatRuns).values({ id: repairId, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, scopeKind: "issue", runtimeMode: "legacy",
      status: "cancelled", finishedAt, wakeupRequestId: repairWake, errorCode: "issue_disposition_repair_superseded", error: message,
      scheduledRetryAt: dueAt, scheduledRetryReason: "issue_disposition_repair", scheduledRetryAttempt: 1, retryOfRunId: f.runIds[0],
      contextSnapshot: { issueId: f.issueId, retryOfRunId: f.runIds[0], retryReason: "issue_disposition_repair", dispositionRepairFingerprint: fingerprint, dispositionRepairAttempt: 1 } });
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: repairId, agentId: f.agentId, eventType: "lifecycle", stream: "system", level: "warn", message,
      payload: { expectedFingerprint: fingerprint, scheduledRetryReason: "issue_disposition_repair", scheduledRetryAttempt: 1, scheduledRetryAt: dueAt.toISOString() } });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation",
      fingerprint: repairId, status: "resolved", outcome: "blocked", returnOwnerAgentId: f.agentId, nextAction: "Await verified cleanup",
      evidence: { runId: repairId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    const [repair] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, repairId));
    expect(await isPreDispatchRepairCancellationVerified(db, repair)).toBe(false);
    const prepared = await asRoot(() => prepareSshHostStop(db, { operationId: f.prepared.operationId, companyId: f.companyId, environmentId: f.environmentId,
      leaseIds: f.leaseIds, requestIds: f.requestIds }, f.fenced));
    const started = Math.floor(Date.now() / 1000);
    const proof = { ...f.proof, taskStartedAt: new Date(started * 1000).toISOString(), taskEndedAt: new Date().toISOString(), observedAt: new Date().toISOString(),
      upid: `UPID:pve:00000100:00000200:${started.toString(16).toUpperCase()}:vzstop:124:operator@pam!desktop:` };
    await asRoot(() => recordSshHostStop(db, prepared, proof, f.fenced));
    expect(await isPreDispatchRepairCancellationVerified(db, repair)).toBe(true);
    // Occupy the single agent slot, keeping the real admission queued so no
    // provider is invoked by this integration test.
    const [occupied] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    try {
      const heartbeat = heartbeatService(db);
      await Promise.all([heartbeat.resumeExecutionWaitComments(), heartbeatService(db).resumeExecutionWaitComments()]);
      await heartbeat.resumeExecutionWaitComments();
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      expect(successors).toHaveLength(1);
      expect(successors[0].contextSnapshot).toMatchObject({ wakeCommentIds: [commentId], forceFreshSession: true, explicitUserContinuation: { previousRunId: repairId } });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, repairId)))[0]).toEqual(repair);
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      expect(action.evidence.explicitUserContinuation).toMatchObject({ previousRunId: repairId });
      expect(action.evidence).not.toHaveProperty("executionReconciliation");
      expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.reason, "issue_recovery_action_restored")))).toHaveLength(0);
    } finally {
      await db.delete(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, occupied.id));
    }
  }, 30000);
  it("serializes concurrent imports without duplicate audit or dispatch", async () => {
    const f = await seed();
    const results = await asRoot(() => Promise.all([recordSshHostStop(db, f.prepared, f.proof, f.fenced), recordSshHostStop(db, f.prepared, f.proof, f.fenced)]));
    expect(results.filter(r => r.applied)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(2);
  });
  it("rolls every receipt back if the audit write fails, then safely retries", async () => {
    const f = await seed();
    await db.execute(sql.raw("CREATE FUNCTION ssh_stop_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$"));
    await db.execute(sql.raw(`CREATE TRIGGER ssh_stop_test_audit_failure BEFORE INSERT ON activity_log FOR EACH ROW WHEN (NEW.company_id = '${f.companyId}'::uuid) EXECUTE FUNCTION ssh_stop_test_audit_failure()`));
    try {
      await expect(asRoot(() => recordSshHostStop(db, f.prepared, f.proof, f.fenced))).rejects.toMatchObject({ cause: expect.objectContaining({ message: "injected audit failure" }) });
      expect((await leases(f)).some(hasRemoteTerminationReceipt)).toBe(false);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER ssh_stop_test_audit_failure ON activity_log"));
      await db.execute(sql.raw("DROP FUNCTION ssh_stop_test_audit_failure()"));
    }
    expect(await asRoot(() => recordSshHostStop(db, f.prepared, f.proof, f.fenced))).toMatchObject({ applied: true });
  });
  it.each(["stale", "future", "old_task", "wrong_operation", "wrong_host", "wrong_guest", "wrong_user", "failed_task", "running_guest", "reused_pid", "config_changed", "volume_changed"])("rejects %s proof without granting cleanup", async kind => {
    const f = await seed(), proof = { ...f.proof };
    if (kind === "stale") proof.observedAt = new Date(Date.now() - 61000).toISOString();
    if (kind === "future") proof.observedAt = new Date(Date.now() + 60000).toISOString();
    if (kind === "old_task") proof.taskStartedAt = new Date(Date.now() - 60000).toISOString();
    if (kind === "wrong_operation") proof.operationId = randomUUID();
    if (kind === "wrong_host") proof.mappedSshHost = "192.0.2.125";
    if (kind === "wrong_guest") proof.vmid = 125;
    if (kind === "wrong_user") proof.taskUser = "other@pam";
    if (kind === "failed_task") Object.assign(proof, { exitStatus: "ERROR" });
    if (kind === "running_guest") Object.assign(proof, { guestStatus: "running" });
    if (kind === "reused_pid") proof.guestPid = 1234;
    if (kind === "config_changed") proof.configDigestAfter = "b".repeat(40);
    if (kind === "volume_changed") proof.rootfsAfter += "-other";
    await expect(asRoot(() => recordSshHostStop(db, f.prepared, proof, f.fenced))).rejects.toThrow();
    expect((await leases(f)).some(hasRemoteTerminationReceipt)).toBe(false);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(0);
  });
  it.each(["lease_changed", "request_claimed", "owner_changed", "configuration_changed", "new_lease", "backdated_lease", "controller_running", "active_run", "unreleased_lease"])("fails closed when %s after preparation", async kind => {
    const f = await seed(); let extraRun: string | undefined, extraLease: string | undefined;
    if (kind === "lease_changed") await db.update(environmentLeases).set({ providerLeaseId: "ssh://other" }).where(eq(environmentLeases.id, f.leaseIds[0]!));
    if (kind === "request_claimed") await db.update(agentWakeupRequests).set({ claimedAt: new Date() }).where(eq(agentWakeupRequests.id, f.requestIds[0]!));
    if (kind === "owner_changed") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: randomUUID() } }).where(eq(heartbeatRuns.id, f.runIds[0]!));
    if (kind === "configuration_changed") await db.update(environments).set({ config: { host: "192.0.2.125" } }).where(eq(environments.id, f.environmentId));
    if (kind === "controller_running") f.fenced.mockImplementation(() => { throw new Error("not fenced"); });
    if (kind === "active_run") { extraRun = randomUUID(); await db.insert(heartbeatRuns).values({ id: extraRun, companyId: f.companyId, agentId: f.agentId, status: "running" }); }
    if (["new_lease", "backdated_lease", "unreleased_lease"].includes(kind)) { extraLease = randomUUID(); await db.insert(environmentLeases).values({ id: extraLease, companyId: f.companyId, environmentId: f.environmentId, provider: "ssh", status: kind === "unreleased_lease" ? "active" : "released", releasedAt: kind === "unreleased_lease" ? null : new Date(), acquiredAt: kind === "backdated_lease" ? new Date(0) : new Date() }); }
    try {
      await expect(asRoot(() => recordSshHostStop(db, f.prepared, f.proof, f.fenced))).rejects.toThrow();
      expect((await leases(f)).some(hasRemoteTerminationReceipt)).toBe(false);
    } finally {
      if (extraRun) await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, extraRun));
      if (extraLease) await db.delete(environmentLeases).where(eq(environmentLeases.id, extraLease));
    }
  });
  it("rejects non-root callers before reading or changing the database", async () => {
    const mock = vi.spyOn(process, "getuid").mockReturnValue(1000);
    try { await expect(prepareSshHostStop(db, {} as never, () => {})).rejects.toThrow("Root-only"); }
    finally { mock.mockRestore(); }
  });
  it.skipIf(!process.env.PAPERCLIP_SSH_STOP_BUNDLE)("qualifies the exact root CLI bundle, file boundaries, prepare/apply and replay in an isolated container", async () => {
    const f = await seed(), fixture = mkdtempSync(join(tmpdir(), "ssh-stop-cli-")), name = `ssh-stop-cli-${randomUUID()}`;
    const directory = "/var/lib/paperclip-maintenance/ssh-host-stop";
    writeFileSync(join(fixture, "systemctl"), '#!/bin/sh\nif [ -f /tmp/controller-active ]; then echo "ActiveState=active"; else printf "ActiveState=inactive\\nSubState=dead\\nMainPID=0\\nUnitFileState=masked-runtime\\n"; fi\n', { mode: 0o755 });
    const docker = (args: string[], input?: string) => execFileSync("docker", args, { input, encoding: "utf8", timeout: 20000, stdio: ["pipe", "pipe", "pipe"] });
    const cli = (command: string, file: string, user = "0", extra: string[] = []) => {
      try { return { code: 0, output: docker(["exec", "--user", user, "--env", "DATABASE_URL", ...extra, name, "node", "/tool/ssh-host-stop.mjs", command, file]) }; }
      catch (error) { const e = error as { status: number; stderr: string }; return { code: e.status, output: String(e.stderr) }; }
    };
    const write = (path: string, value: unknown) => docker(["exec", "-i", name, "node", "-e", "require('fs').writeFileSync(process.argv[1],require('fs').readFileSync(0),{mode:0o600})", path], JSON.stringify(value));
    const oldUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.connectionString;
    let created = false;
    try {
      docker(["run", "-d", "--name", name, "--network=host", "--read-only", "--tmpfs", "/var/lib:mode=0755,size=16m", "--tmpfs", "/tmp:mode=1777,size=16m",
        "--mount", `type=bind,src=${resolve(process.env.PAPERCLIP_SSH_STOP_BUNDLE!)},dst=/tool/ssh-host-stop.mjs,readonly`,
        "--mount", `type=bind,src=${fixture}/systemctl,dst=/usr/bin/systemctl,readonly`, "node:24.16.0-trixie", "sleep", "180"]);
      created = true;
      expect(cli("prepare", `${directory}/input.json`, "1000:1000")).toMatchObject({ code: 1, output: "Root-only offline maintenance\n" });
      docker(["exec", name, "touch", "/tmp/controller-active"]);
      expect(cli("prepare", `${directory}/input.json`)).toMatchObject({ code: 1, output: "Controller must be stopped and masked\n" });
      docker(["exec", name, "rm", "/tmp/controller-active"]);
      docker(["exec", name, "mkdir", "-p", directory]);
      const descriptor = { companyId: f.companyId, environmentId: f.environmentId, leaseIds: f.leaseIds, requestIds: f.requestIds };
      write(`${directory}/input.json`, descriptor);
      docker(["exec", name, "chmod", "0640", `${directory}/input.json`]);
      expect(cli("prepare", `${directory}/input.json`)).toMatchObject({ code: 1, output: "Unsafe maintenance file\n" });
      docker(["exec", name, "chmod", "0600", `${directory}/input.json`]);
      docker(["exec", name, "ln", "-s", "input.json", `${directory}/symlink.json`]);
      expect(cli("prepare", `${directory}/symlink.json`)).toMatchObject({ code: 1, output: "Unsafe maintenance file\n" });
      docker(["exec", name, "ln", `${directory}/input.json`, `${directory}/hardlink.json`]);
      expect(cli("prepare", `${directory}/hardlink.json`)).toMatchObject({ code: 1, output: "Unsafe maintenance file\n" });
      docker(["exec", name, "rm", `${directory}/hardlink.json`]);
      expect(cli("prepare", `${directory}/../input.json`)).toMatchObject({ code: 1, output: "Use the root maintenance directory\n" });
      docker(["exec", name, "chmod", "0777", directory]);
      expect(cli("prepare", `${directory}/input.json`)).toMatchObject({ code: 1, output: "Unsafe maintenance directory\n" });
      docker(["exec", name, "chmod", "0700", directory]);
      const result = cli("prepare", `${directory}/input.json`);
      expect(result.code, result.output).toBe(0);
      const prepared = JSON.parse(result.output), started = Math.floor(Date.now() / 1000);
      const proof = { ...f.proof, operationId: prepared.operationId, taskStartedAt: new Date(started * 1000).toISOString(), taskEndedAt: new Date().toISOString(), observedAt: new Date().toISOString(),
        upid: `UPID:pve:00000100:00000200:${started.toString(16).toUpperCase()}:vzstop:124:operator@pam!desktop:` };
      write(`${directory}/proof.json`, proof);
      const applied = cli("apply", `${directory}/proof.json`);
      expect(applied.code, applied.output).toBe(0);
      expect(JSON.parse(applied.output)).toMatchObject({ applied: true, replay: false });
      expect(JSON.parse(cli("apply", `${directory}/proof.json`).output)).toMatchObject({ applied: false, replay: true });
      expect((await leases(f)).every(hasRemoteTerminationReceipt)).toBe(true);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(1);
    } finally {
      if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl;
      if (created) docker(["rm", "-f", name]);
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 60000);
});
