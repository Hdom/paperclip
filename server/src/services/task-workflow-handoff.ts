import { assertMaintenanceAdmission, maintenanceClosed } from "./instance-maintenance.js";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createControllerSourceSnapshot } from "@paperclipai/adapter-utils/controller-source-materialization";
import { withControllerWorkspaceAuthority, withControllerWorkspaceOperation } from "@paperclipai/adapter-utils/controller-workspace-authority";
import { controllerExecutionProtected } from "@paperclipai/adapter-utils/controller-source-protection";
import { retainedSshHostKeyPolicySha256, parseRetainedSshWorkspaceSource } from "./retained-ssh-workspace-source.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { agents, companies, documents, environmentLeases, environments, executionWorkspaces, heartbeatRuns,
  issueDocuments, issueExecutionDecisions, issueWorkflowHandoffs, issues, type Db } from "@paperclipai/db";
import { tryWithDirectoryMergeLock, captureDirectorySnapshotOffThread, directorySnapshotSha256, disposeDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { isIssuedWorkspaceCopyback, type WorkspaceCopybackReceipt } from "@paperclipai/adapter-utils/remote-managed-runtime";
import { parseSshRunScope } from "@paperclipai/adapter-utils/ssh-run-scope";
import { conflict, unprocessable } from "../errors.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { hasCompetingTaskWorkflowWriter } from "./task-workflow-directory-writers.js";
import { isBoundIsolatedTaskDirectory } from "./isolated-task-directory.js";
import { authorizationService } from "./authorization.js";
import { assertIssueReviewVerdictActorAllowed } from "./issue-review-policy.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-runtime/native-workspace-finalization-ownership.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { notifyDeferredExecutionWork } from "./deferred-execution-notifications.js";
import { buildExecutionStageWakeup } from "./task-workflow-stage-wakeup.js";
import { issueService, executeIssuePostCommitActions, type IssuePostCommitAction } from "./issues.js";
import { WORKFLOW_PATCH_KEYS, WORKFLOW_HANDOFF_SCHEMA, WORKFLOW_RETURN_SCHEMA, taskWorkflowFingerprint,
  taskWorkflowSnapshot, workflowHandoffRevoked, notifyWorkflowHandoff } from "./task-workflow-handoff-state.js";

type Task = typeof issues.$inferSelect;
type Handoff = typeof issueWorkflowHandoffs.$inferSelect;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.object({ dev: z.number(), ino: z.number(), uid: z.number(), mode: z.number() }).strict();
const patchSchema = z.object({ status: z.enum(["in_progress", "in_review", "done"]),
  assigneeAgentId: z.string().uuid().nullable().optional(), assigneeUserId: z.string().nullable().optional(),
  executionState: z.record(z.string(), z.unknown()).nullable().optional(),
  executionPolicy: z.record(z.string(), z.unknown()).nullable().optional(),
  monitorNextCheckAt: z.string().datetime().nullable().optional(), monitorWakeRequestedAt: z.string().datetime().nullable().optional(),
  monitorNotes: z.string().nullable().optional(), monitorScheduledBy: z.string().nullable().optional() }).strict();
const decisionSchema = z.object({ id: z.string().uuid(), stageId: z.string(), stageType: z.enum(["review", "approval"]),
  outcome: z.enum(["approved", "changes_requested"]), body: z.string().min(1).max(12000) }).strict();
const intentSchema = z.object({ schema: z.literal(WORKFLOW_HANDOFF_SCHEMA), requestHash: sha,
  plannedAt: z.string().datetime(), request: z.record(z.string(), z.unknown()), task: z.record(z.string(), z.unknown()), taskSha256: sha,
  documentRevisions: z.array(z.object({ key: z.string(), revisionId: z.string().nullable() })).max(100),
  patch: patchSchema, decision: decisionSchema.nullable(), comment: z.string().max(64000).nullable(),
  commentProvenance: z.object({ authorizationReason: z.string().nullable(), sourceTrust: z.unknown(), onBehalfOfUserId: z.string().nullable() }).strict(),
  cwd: z.string().min(1), rootIdentity: identity, environmentSha256: sha,
  scope: z.record(z.string(), z.unknown()), providerLeaseId: z.string().min(1), source: z.record(z.string(), z.unknown()),
}).strict();
const returnSchema = z.object({ schema: z.literal(WORKFLOW_RETURN_SCHEMA), handoffId: z.string().uuid(),
  companyId: z.string().uuid(), issueId: z.string().uuid(), runId: z.string().uuid(), workspaceId: z.string().uuid(),
  leaseId: z.string().uuid(), scopeSha256: sha, baselineSha256: sha, treeSha256: sha,
  rootIdentity: identity, entryCount: z.number().int().min(0).max(100000), exclude: z.array(z.string()).max(1000) }).strict();
const requestKeys = new Set(["status", "comment", "reviewRequest", "assigneeAgentId", "assigneeUserId",
  "expectedExecutionStageId", "expectedDecisionStatusVersion", "expectedDecisionLastDecisionId", "expectedPlanRevisionId"]);
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const patchHash = (value: Record<string, unknown>) => nativeSha256(json(Object.fromEntries(
  WORKFLOW_PATCH_KEYS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))));
function databasePatch(patch: z.infer<typeof patchSchema>) {
  return { ...patch,
    ...(patch.monitorNextCheckAt !== undefined ? { monitorNextCheckAt: patch.monitorNextCheckAt === null ? null : new Date(patch.monitorNextCheckAt) } : {}),
    ...(patch.monitorWakeRequestedAt !== undefined ? { monitorWakeRequestedAt: patch.monitorWakeRequestedAt === null ? null : new Date(patch.monitorWakeRequestedAt) } : {}),
  };
}
const commitAuthority = new AsyncLocalStorage<{ tx: Db; handoffId: string; taskSha256: string; patchSha256: string;
  issueId: string; companyId: string; agentId: string; runId: string }>();

/** Only the verified workflow owner below enters this context. It is not an agent credential. */
export function workflowHandoffCommitAuthorized(tx: Db, task: Task, input: {
  agentId?: string | null; runId?: string | null; patch: Record<string, unknown>;
}) {
  const authority = commitAuthority.getStore();
  return Boolean(authority && Object.keys(input.patch).every(key => (WORKFLOW_PATCH_KEYS as readonly string[]).includes(key)) && authority.tx === tx && authority.companyId === task.companyId && authority.issueId === task.id
    && authority.agentId === input.agentId && authority.runId === input.runId
    && authority.taskSha256 === taskWorkflowFingerprint(task) && authority.patchSha256 === patchHash(input.patch));
}

async function documentRevisions(db: Db, companyId: string, issueId: string) {
  const rows = await db.select({ key: issueDocuments.key, revisionId: documents.latestRevisionId }).from(issueDocuments)
    .innerJoin(documents, and(eq(documents.companyId, companyId), eq(documents.id, issueDocuments.documentId)))
    .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.issueId, issueId),
      // Host-generated continuation metadata is refreshed after provider exit;
      // it is not a change to the submitted plan/research/work-product revision.
      ne(issueDocuments.key, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY))).orderBy(issueDocuments.key).limit(101);
  if (rows.length > 100) throw conflict("The task has too many document revisions for a bounded workflow handoff.");
  return rows;
}
async function rootIdentity(cwd: string) {
  const stat = await lstat(cwd);
  if (await realpath(cwd) !== cwd || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
      || (stat.mode & 0o077)) throw conflict("The task workspace is not a private physical directory.", { code: "workflow_handoff_workspace_unsafe" });
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
}
function projection(row: Handoff) {
  const intent = intentSchema.safeParse(row.intent);
  return { id: row.id, state: row.state, sourceRunId: row.sourceRunId,
    targetStatus: intent.success ? intent.data.patch.status : null,
    targetAgentId: intent.success ? intent.data.patch.assigneeAgentId ?? row.agentId : null,
    message: row.state === "held" ? "Review handoff is held until the saved work is verified."
      : "Finishing and saving this agent's work before applying the review handoff." };
}

/** Called only after route authorization and workflow planning, before any Stop/reassignment. */
export async function taskWorkflowHandoffEligible(db: Db, companyId: string, runId: string) {
  if (!controllerExecutionProtected()) return false;
  // Detect the protected SSH lane even when its scope/workspace is invalid.
  // Invalid or unsupported evidence must refuse before legacy reassignment,
  // never silently fall through to cancel-before-copyback.
  const [lease] = await db.select({ id: environmentLeases.id }).from(environmentLeases)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, environmentLeases.heartbeatRunId)))
    .innerJoin(agents, and(eq(agents.companyId, companyId), eq(agents.id, heartbeatRuns.agentId)))
    .where(and(eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
      eq(environmentLeases.provider, "ssh"), eq(heartbeatRuns.runtimeMode, "legacy"), eq(agents.adapterType, "codex_local"))).limit(1);
  return Boolean(lease);
}

export async function admitTaskWorkflowHandoff(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string; plannedAt: string;
  request: Record<string, unknown>; patch: Record<string, unknown>;
  decision: (Omit<z.infer<typeof decisionSchema>, "id"> & { id: string }) | null;
  commentProvenance: { authorizationReason: string | null; sourceTrust: unknown; onBehalfOfUserId: string | null };
  validate: (tx: Db, task: Task) => Promise<void>;
}) {
  if (Object.keys(input.request).some(key => !requestKeys.has(key))) throw unprocessable(
    "Submit the review transition separately from other task edits.", { code: "workflow_handoff_compound_mutation_unsupported" });
  const patch = patchSchema.parse(json(input.patch));
  const requestHash = nativeSha256(json(input.request));
  const publications: Parameters<typeof publishActivity>[0][] = [];
  const result = await db.transaction(async raw => {
    const tx = raw as unknown as Db;
    const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("update");
    const [prior] = await tx.select().from(issueWorkflowHandoffs).where(and(eq(issueWorkflowHandoffs.companyId, input.companyId), eq(issueWorkflowHandoffs.sourceRunId, input.runId))).for("update");
    if (!task || !run || task.executionRunId !== run.id || task.checkoutRunId && task.checkoutRunId !== run.id
      || task.assigneeAgentId !== input.agentId || task.assigneeUserId || run.agentId !== input.agentId
      || run.runtimeMode !== "legacy" || run.status !== "running" || run.finishedAt || workflowHandoffRevoked(run)
      || (run.issueId ?? run.contextSnapshot?.issueId) !== task.id || !task.executionWorkspaceId
      || run.contextSnapshot?.executionWorkspaceId !== task.executionWorkspaceId) throw conflict("The admitted task owner changed.", { code: "workflow_handoff_source_changed" });
    if (prior) {
      const saved = intentSchema.safeParse(prior.intent);
      if (!saved.success || saved.data.requestHash !== requestHash || prior.issueId !== input.issueId || prior.agentId !== input.agentId)
        throw conflict("This run already has a different review handoff. Finish the accepted turn before proposing another.", { code: "workflow_handoff_conflict" });
      const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
        eq(environmentLeases.id, prior.leaseId))).for("share", { noWait: true });
      if (prior.state !== "pending" || saved.data.taskSha256 !== taskWorkflowFingerprint(task)
        || !isDeepStrictEqual(await documentRevisions(tx, input.companyId, task.id), saved.data.documentRevisions)
        || !lease || lease.status !== "active" || lease.releasedAt || lease.heartbeatRunId !== run.id
        || lease.executionWorkspaceId !== prior.workspaceId || lease.providerLeaseId !== saved.data.providerLeaseId
        || lease.expiresAt && lease.expiresAt.getTime() <= Date.now()
        || !isDeepStrictEqual(lease.metadata?.remoteExecutionScope, saved.data.scope))
        throw conflict("The accepted handoff source or reviewed revision changed.", { code: "workflow_handoff_source_changed" });
      return { task, handoff: projection(prior) };
    }
    const [successor] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
      ne(heartbeatRuns.id, run.id), gte(heartbeatRuns.createdAt, run.createdAt), or(eq(heartbeatRuns.issueId, task.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`))).limit(1);
    if (successor) throw conflict("Another task attempt already exists.", { code: "workflow_handoff_successor_exists" });
    const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, task.executionWorkspaceId))).for("share", { noWait: true });
    const leases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.status, "active"))).for("share", { noWait: true });
    if (!workspace?.cwd || leases.length !== 1 || !leases[0].environmentId) throw conflict("The exact workflow source lease is unavailable.", { code: "workflow_handoff_source_changed" });
    const lease = leases[0];
    let scope: ReturnType<typeof parseSshRunScope>;
    try { scope = parseSshRunScope(lease.metadata?.remoteExecutionScope); }
    catch { throw unprocessable("This run needs a current verified SSH workspace scope before handing off.", { code: "workflow_handoff_scope_required" }); }
    if (!await isBoundIsolatedTaskDirectory({ companyId: input.companyId, issueId: task.id, workspaceId: workspace.id, workspace }))
      throw unprocessable("This workspace cannot safely complete a verified SSH handoff yet. Select a supported private task workspace before continuing; the current run and assignment have not been stopped.",
        { code: "workflow_handoff_workspace_unsupported" });
    const [environment] = await tx.select().from(environments).where(eq(environments.id, lease.environmentId!)).for("share", { noWait: true });
    if (!environment || environment.driver !== "ssh" || lease.provider !== "ssh" || lease.executionWorkspaceId !== workspace.id
      || lease.issueId !== task.id || !lease.providerLeaseId || lease.metadata?.remoteExecutionScopeRequired !== true
      || scope.companyId !== input.companyId || scope.runId !== run.id || scope.leaseId !== lease.id || lease.releasedAt
      || lease.expiresAt && lease.expiresAt.getTime() <= Date.now())
      throw conflict("The exact scoped SSH source is unavailable.", { code: "workflow_handoff_source_changed" });
    // Execute the SAME locked service validations, rolling back every preview write.
    class PreviewComplete extends Error {}
    try { await (raw as any).transaction(async (preview: Db) => { await input.validate(preview, task); throw new PreviewComplete(); }); }
    catch (error) { if (!(error instanceof PreviewComplete)) throw error; }
    const intent = intentSchema.parse({ schema: WORKFLOW_HANDOFF_SCHEMA, requestHash, plannedAt: input.plannedAt, request: json(input.request),
      task: taskWorkflowSnapshot(task), taskSha256: taskWorkflowFingerprint(task), documentRevisions: await documentRevisions(tx, input.companyId, task.id),
      patch, decision: input.decision, comment: typeof input.request.comment === "string" ? input.request.comment : null, commentProvenance: input.commentProvenance,
      cwd: workspace.cwd, rootIdentity: await rootIdentity(workspace.cwd), environmentSha256: nativeSha256(environment.config),
      scope, providerLeaseId: lease.providerLeaseId,
      source: parseRetainedSshWorkspaceSource({ provider: "ssh", runId: run.id, executionWorkspaceId: workspace.id,
        leaseId: lease.id, environmentId: environment.id, providerLeaseId: lease.providerLeaseId,
        remoteDir: path.posix.join(String(lease.metadata?.remoteCwd), ".paperclip-runtime", "runs", run.id, "workspace"),
        endpoint: { host: lease.metadata?.host, port: lease.metadata?.port, username: lease.metadata?.username, remoteCwd: lease.metadata?.remoteCwd },
        generation: scope.generation, bootId: scope.bootId,
        hostKeyPolicySha256: retainedSshHostKeyPolicySha256(environment.id, environment.config as Record<string, unknown>, String(lease.metadata?.remoteCwd)) }) });
    await notifyWorkflowHandoff(tx);
    const [row] = await tx.insert(issueWorkflowHandoffs).values({ companyId: input.companyId, issueId: task.id,
      sourceRunId: run.id, agentId: input.agentId, workspaceId: workspace.id, leaseId: lease.id, intent }).returning();
    const activity = await persistActivity(tx, { companyId: input.companyId, actorType: "agent", actorId: input.agentId,
      agentId: input.agentId, runId: run.id, action: "issue.workflow_handoff_requested", entityType: "issue", entityId: task.id,
      details: { handoffId: row.id, targetStatus: patch.status, targetAgentId: patch.assigneeAgentId ?? input.agentId, pending: true } });
    publications.push(activity.publication);
    return { task, handoff: projection(row) };
  });
  for (const value of publications) publishActivity(value);
  return result;
}

/** This callback cannot be invoked by agent output/config; the transport issues the opaque receipt. */
export async function recordTaskWorkflowReturn(db: Db, input: { companyId: string; runId: string }, verify: () => Promise<WorkspaceCopybackReceipt>) {
  const [pending] = await db.select().from(issueWorkflowHandoffs).where(and(eq(issueWorkflowHandoffs.companyId, input.companyId),
    eq(issueWorkflowHandoffs.sourceRunId, input.runId), eq(issueWorkflowHandoffs.state, "pending"))).limit(1);
  if (!pending) return;
  const owned = await withNativeWorkspaceFinalizationOwnership({ db, ...input, liveLegacyPublication: true }, async owner => {
    await owner.assertHeld();
    // Validation uses the live adapter's outer DB connection. Do not hold another
    // transaction/connection while entering that capability (including pool size 1).
    const receipt = await verify();
    await owner.assertHeld();
    await db.transaction(async raw => {
      const tx = raw as unknown as Db;
      const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, pending.issueId))).for("share", { noWait: true });
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("share", { noWait: true });
      const [handoff] = await tx.select().from(issueWorkflowHandoffs).where(and(eq(issueWorkflowHandoffs.companyId, input.companyId), eq(issueWorkflowHandoffs.id, pending.id))).for("update");
      const intent = intentSchema.parse(handoff?.intent);
      if (handoff.state !== "pending" || !task || !run || run.status !== "running" || workflowHandoffRevoked(run)
        || intent.taskSha256 !== taskWorkflowFingerprint(task)) throw conflict("The workflow owner changed before copy-back.", { code: "workflow_handoff_source_changed" });
      if (!isIssuedWorkspaceCopyback(receipt) || receipt.runId !== run.id || receipt.localDir !== intent.cwd
        || !isDeepStrictEqual(receipt.rootIdentity, intent.rootIdentity) || !isDeepStrictEqual(receipt.scope, intent.scope)
        || receipt.scope.leaseId !== handoff.leaseId) throw conflict("The workflow return is not the genuine admitted copy-back.");
      const proof = returnSchema.parse({ schema: WORKFLOW_RETURN_SCHEMA, handoffId: handoff.id, companyId: input.companyId,
        issueId: handoff.issueId, runId: run.id, workspaceId: handoff.workspaceId, leaseId: handoff.leaseId,
        scopeSha256: nativeSha256(receipt.scope), baselineSha256: receipt.baselineSha256, treeSha256: receipt.treeSha256,
        rootIdentity: receipt.rootIdentity, entryCount: receipt.entryCount, exclude: [...receipt.exclude] });
      await notifyWorkflowHandoff(tx);
      await tx.update(issueWorkflowHandoffs).set({ returnProof: proof, updatedAt: new Date() }).where(eq(issueWorkflowHandoffs.id, handoff.id));
    });
    await owner.assertHeld();
  });
  if (!owned.acquired) throw conflict("The workflow copy-back owner is busy.");
}

/** Owner-only commit after provider return and exact physical cleanup. No agent JWT is replayed. */
export async function commitTaskWorkflowHandoff(db: Db, companyId: string, runId: string) {
  if (await maintenanceClosed(db)) return false;
  const publications: Parameters<typeof publishActivity>[0][] = [];
  const actions: IssuePostCommitAction[] = [];
  const transact = async () => {
    let transactionWork: Promise<boolean> | undefined;
    try { return await db.transaction(raw => {
      // A lost DB connection can reject before its filesystem callback joins.
      // Keep the directory fence until every checked read/staging cleanup ends.
      transactionWork = (async () => {
    const tx = raw as unknown as Db;
    await assertMaintenanceAdmission(tx);
    const [candidate] = await tx.select().from(issueWorkflowHandoffs).where(and(eq(issueWorkflowHandoffs.companyId, companyId), eq(issueWorkflowHandoffs.sourceRunId, runId))).limit(1);
    if (!candidate || candidate.state !== "pending") return false;
    const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, candidate.issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId))).for("update");
    const [handoff] = await tx.select().from(issueWorkflowHandoffs).where(and(eq(issueWorkflowHandoffs.companyId, companyId), eq(issueWorkflowHandoffs.id, candidate.id))).for("update");
    if (!handoff || handoff.state !== "pending") return false;
    const hold = async (code: string, state = "held") => {
      await tx.update(issueWorkflowHandoffs).set({ state, failureCode: code, updatedAt: new Date() }).where(eq(issueWorkflowHandoffs.id, handoff.id));
      const activity = await persistActivity(tx, { companyId, actorType: "system", actorId: "workflow-owner", action: "issue.workflow_handoff_held",
        entityType: "issue", entityId: handoff.issueId, runId, details: { handoffId: handoff.id, code, state } });
      publications.push(activity.publication); return false;
    };
    const parsed = intentSchema.safeParse(handoff.intent);
    if (!parsed.success) return hold("workflow_handoff_saved_identity_invalid");
    const intent = parsed.data;
    if (!run || !task || workflowHandoffRevoked(run)) return hold("workflow_handoff_revoked");
    if (taskWorkflowFingerprint(task) !== intent.taskSha256) return hold("workflow_handoff_task_changed");
    if (run.status === "running" || run.status === "queued") return false;
    if (run.status !== "succeeded" || run.resultJson?.workspaceRestoreFailure) return hold("workflow_handoff_source_failed");
    if (run.controllerLeaseExpiresAt || run.runnerProfileJson?.nativeWorkspaceFinalizationOwner || adapterExecutionControls.has(runId)) return false;
    const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, companyId), eq(environmentLeases.id, handoff.leaseId))).for("share", { noWait: true });
    if (!lease || lease.heartbeatRunId !== run.id || lease.executionWorkspaceId !== handoff.workspaceId
      || lease.providerLeaseId !== intent.providerLeaseId || !isDeepStrictEqual(lease.metadata?.remoteExecutionScope, intent.scope)) return hold("workflow_handoff_lease_changed");
    if (!hasRemoteTerminationReceipt(lease)) return false;
    const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).for("share", { noWait: true });
    const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, handoff.agentId))).for("share", { noWait: true });
    const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.id, handoff.workspaceId))).for("share", { noWait: true });
    const [environment] = await tx.select().from(environments).where(eq(environments.id, lease.environmentId!)).for("share", { noWait: true });
    if (company?.status !== "active" || !agent || agent.lifecycleState !== "ready" || agent.lifecycleHolds?.length || ["paused", "terminated"].includes(agent.status)) return false;
    const samePhysicalRoot = await rootIdentity(intent.cwd).then(value => isDeepStrictEqual(value, intent.rootIdentity), () => false);
    if (!workspace || workspace.cwd !== intent.cwd || !environment || nativeSha256(environment.config) !== intent.environmentSha256
      || !samePhysicalRoot || !await isBoundIsolatedTaskDirectory({ companyId, issueId: task.id, workspaceId: workspace.id, workspace }))
      return hold("workflow_handoff_workspace_changed");
    if (await hasCompetingTaskWorkflowWriter(tx, { companyId, sourceRunId: run.id, workspaceId: workspace.id, cwd: intent.cwd })) {
      await tx.update(issueWorkflowHandoffs).set({ failureCode: "workflow_handoff_competing_writer", updatedAt: new Date() }).where(eq(issueWorkflowHandoffs.id, handoff.id));
      return false;
    }
    if (!isDeepStrictEqual(await documentRevisions(tx, companyId, task.id), intent.documentRevisions)) return hold("workflow_handoff_document_changed");
    const [successor] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
      ne(heartbeatRuns.id, run.id), gte(heartbeatRuns.createdAt, run.createdAt), or(eq(heartbeatRuns.issueId, task.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`))).limit(1);
    if (successor) return hold("workflow_handoff_successor_exists");
    const proof = returnSchema.safeParse(handoff.returnProof);
    if (!proof.success || proof.data.handoffId !== handoff.id || proof.data.companyId !== companyId || proof.data.issueId !== task.id
      || proof.data.runId !== run.id || proof.data.leaseId !== lease.id || proof.data.workspaceId !== workspace.id
      || proof.data.scopeSha256 !== nativeSha256(intent.scope) || !isDeepStrictEqual(proof.data.rootIdentity, intent.rootIdentity)) return hold("workflow_handoff_copyback_unproven");
    // A terminal return grants read-only verification of this one frozen root.
    // It cannot upload, merge, replay a canceled credential, or publish files.
    const target = `workflow-handoff:${handoff.id}`;
    const unchanged = async () => {
      await tx.execute(sql`select 1`);
      if (!isDeepStrictEqual(await rootIdentity(intent.cwd), intent.rootIdentity)) throw conflict("The returned workspace changed.");
    };
    const matches = await withControllerWorkspaceAuthority({ root: intent.cwd, target, signal: new AbortController().signal,
      validate: unchanged, publish: async () => { throw conflict("Workflow verification cannot publish workspace files."); } },
      () => withControllerWorkspaceOperation(intent.cwd, target, "read", async () => {
        const checked = await createControllerSourceSnapshot(intent.cwd,
          { excludeNames: new Set(proof.data.exclude.filter(name => !name.includes("/"))), rejectLinks: true, preserveFileModes: true });
        try {
          const snapshot = await captureDirectorySnapshotOffThread(checked.directory, { exclude: proof.data.exclude, diskBacked: true });
          try { return snapshot.entries.size === proof.data.entryCount && directorySnapshotSha256(snapshot) === proof.data.treeSha256; }
          finally { await disposeDirectorySnapshot(snapshot); }
        } finally { await checked?.cleanup(); }
      }));
    if (!matches) return hold("workflow_handoff_returned_bytes_changed");
    const permission = await authorizationService(tx).decide({ actor: { type: "agent", agentId: handoff.agentId, companyId }, action: "issue:mutate",
      resource: { type: "issue", companyId, issueId: task.id, status: task.status, assigneeAgentId: task.assigneeAgentId, assigneeUserId: task.assigneeUserId } });
    if (!permission.allowed) return hold("workflow_handoff_authority_changed");
    const policy = normalizeIssueExecutionPolicy(task.executionPolicy);
    const transition = applyIssueExecutionPolicyTransition({ now: new Date(intent.plannedAt), issue: task, policy, previousPolicy: policy,
      requestedStatus: String(intent.request.status), requestedAssigneePatch: { assigneeAgentId: intent.request.assigneeAgentId as string | null | undefined,
        assigneeUserId: intent.request.assigneeUserId as string | null | undefined }, actor: { agentId: handoff.agentId },
      commentBody: intent.comment, reviewRequest: intent.request.reviewRequest as any });
    const patch: Record<string, unknown> = { status: intent.request.status, ...transition.patch };
    if (intent.decision && patch.executionState) patch.executionState = { ...(patch.executionState as object), lastDecisionId: intent.decision.id };
    if (patchHash(patch) !== patchHash(intent.patch) || !isDeepStrictEqual(transition.decision ?? null,
      intent.decision ? Object.fromEntries(Object.entries(intent.decision).filter(([key]) => key !== "id")) : null)) return hold("workflow_handoff_policy_changed");
    if (intent.decision && task.reviewPolicy && task.reviewPolicy !== "anyone") await assertIssueReviewVerdictActorAllowed(tx, {
      issue: task, actor: { type: "agent", id: handoff.agentId }, reviewPolicy: task.reviewPolicy });
    const service = issueService(tx);
    const updated = await commitAuthority.run({ tx, handoffId: handoff.id, taskSha256: intent.taskSha256,
      patchSha256: patchHash(intent.patch), issueId: task.id, companyId, agentId: handoff.agentId, runId }, () => service.update(task.id,
      { ...databasePatch(intent.patch), companyGuard: companyId, actorAgentId: handoff.agentId, actorRunId: run.id } as any, tx, publications, actions));
    if (!updated) throw conflict("The workflow task disappeared.");
    if (intent.comment) await service.addComment(task.id, intent.comment, { agentId: handoff.agentId, runId: run.id,
      onBehalfOfUserId: intent.commentProvenance.onBehalfOfUserId }, { authorizationReason: intent.commentProvenance.authorizationReason,
        sourceTrust: intent.commentProvenance.sourceTrust as any }, tx);
    if (intent.decision) await tx.insert(issueExecutionDecisions).values({ ...intent.decision, companyId, issueId: task.id,
      actorAgentId: handoff.agentId, createdByRunId: run.id });
    const stage = buildExecutionStageWakeup({ issueId: task.id, previousState: parseIssueExecutionState(task.executionState),
      nextState: parseIssueExecutionState(updated.executionState), interruptedRunId: null, requestedByActorType: "agent", requestedByActorId: handoff.agentId });
    let successorWakeId: string | null = null;
    if (stage) {
      const { agentWakeupRequests } = await import("@paperclipai/db");
      const id = randomUUID(); successorWakeId = id;
      await notifyDeferredExecutionWork(tx, { companyId, requestId: id });
      await tx.insert(agentWakeupRequests).values({ id, companyId, agentId: stage.agentId, status: "deferred_issue_execution",
        source: stage.wakeup.source, triggerDetail: stage.wakeup.triggerDetail, reason: stage.wakeup.reason,
        requestedByActorType: stage.wakeup.requestedByActorType, requestedByActorId: stage.wakeup.requestedByActorId,
        idempotencyKey: `workflow-handoff:${handoff.id}`,
        payload: { ...stage.wakeup.payload, workflowHandoffId: handoff.id, _paperclipWakeContext: stage.wakeup.contextSnapshot } });
    }
    await tx.update(issueWorkflowHandoffs).set({ state: "committed", committedAt: new Date(), updatedAt: new Date(), failureCode: null,
      returnProof: { ...proof.data, committedTaskSha256: taskWorkflowFingerprint(updated), successorWakeId } }).where(eq(issueWorkflowHandoffs.id, handoff.id));
    const activity = await persistActivity(tx, { companyId, actorType: "system", actorId: "workflow-owner", action: "issue.workflow_handoff_committed",
      entityType: "issue", entityId: task.id, runId, details: { handoffId: handoff.id, sourceAgentId: handoff.agentId,
        targetAgentId: updated.assigneeAgentId, targetStatus: updated.status, decisionId: intent.decision?.id ?? null,
        copybackSha256: proof.data.treeSha256, leaseId: lease.id } });
    publications.push(activity.publication); return true;
      })();
      return transactionWork;
    }); } finally { await transactionWork?.catch(() => {}); }
  };
  const [candidate] = await db.select().from(issueWorkflowHandoffs).where(and(eq(issueWorkflowHandoffs.companyId, companyId),
    eq(issueWorkflowHandoffs.sourceRunId, runId), eq(issueWorkflowHandoffs.state, "pending"))).limit(1);
  const saved = intentSchema.safeParse(candidate?.intent);
  const proof = returnSchema.safeParse(candidate?.returnProof);
  // Acquire before DB row locks, matching real copy-back publication ordering.
  // Missing/changed roots go through locked fail-closed bookkeeping; no read
  // authority is constructed and no hash is taken without a genuine receipt.
  const rootMatches = saved.success && await rootIdentity(saved.data.cwd).then(value => isDeepStrictEqual(value, saved.data.rootIdentity), () => false);
  const committed = saved.success && proof.success && rootMatches
    ? await tryWithDirectoryMergeLock(saved.data.cwd, transact) ?? false : await transact();
  for (const publication of publications) publishActivity(publication);
  await executeIssuePostCommitActions(db, actions);
  return committed;
}
