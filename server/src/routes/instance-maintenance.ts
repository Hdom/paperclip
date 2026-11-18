import { Router, type Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import { issues, heartbeatRuns, instanceMaintenanceOperations, instanceMaintenanceEvents, type Db } from "@paperclipai/db";
import { maintenanceStartSchema, maintenanceReleaseSchema, maintenanceRecoverySchema, type MaintenanceStatus } from "@paperclipai/shared";
import { forbidden, conflict } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertBoard, getActorInfo } from "./authz.js";
import { maintenanceBlockers, readMaintenance, startMaintenance, releaseMaintenance, reconcileMaintenance,
  PUBLIC_MAINTENANCE_MESSAGE, withMaintenanceOperation } from "../services/instance-maintenance.js";
import { inspectRetainedSshWorkspaceSource, parseRetainedSshWorkspaceSource } from "../services/retained-ssh-workspace-source.js";
import { authorizationService, authorizationDeniedDetails } from "../services/authorization.js";
import { nativeSha256 } from "../services/native-runtime/canonical.js";
import { requestWorkspaceRecovery, recoverRetainedWorkspace } from "../services/workspace-recovery.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { maintenanceContinuationReview } from "../services/maintenance-continuation-review.js";

function isAdmin(req: Request) { return req.actor.type === "board" && (req.actor.isInstanceAdmin || req.actor.source === "local_implicit"); }
function admin(req: Request) { assertBoard(req); if (!isAdmin(req)) throw forbidden("Instance admin access required"); }

export function instanceMaintenanceRoutes(db: Db) {
  const router = Router();
  router.get("/instance/maintenance", async (req, res) => {
    assertBoard(req);
    const row = await readMaintenance(db);
    const value: MaintenanceStatus = { state: row.state as MaintenanceStatus["state"], generation: row.generation,
      canManage: Boolean(isAdmin(req)), message: row.state === "released" ? "Maintenance is off." : PUBLIC_MAINTENANCE_MESSAGE,
      checkedAt: new Date().toISOString() };
    if (isAdmin(req) && req.query.view !== "task") {
      const wakes = await db.execute(sql`select w.company_id, w.payload->>'issueId' as issue_id, w.id, w.status,
        i.identifier, source.action_id, source.source_run_id from agent_wakeup_requests w
        left join issues i on i.company_id=w.company_id and i.id::text=w.payload->>'issueId'
        left join lateral (select a.id as action_id, r.id as source_run_id
          from issue_recovery_actions a join heartbeat_runs r on r.company_id=a.company_id and r.id::text=a.evidence->>'runId'
          where a.company_id=i.company_id and a.source_issue_id=i.id
            and r.result_json#>>'{workspaceRestoreRecovery,schema}'='paperclip.workspace-restore-recovery.v1'
            and r.result_json#>>'{workspaceRestoreRecovery,source,provider}'='ssh'
            and r.status in ('failed','cancelled','interrupted','succeeded','timed_out')
          order by r.finished_at desc, a.id limit 1) source on true
        where w.status in ('queued', 'deferred_issue_execution') and w.run_id is null
        order by w.id limit 101`);
      const [active] = await db.execute(sql`select count(*)::int as n from instance_maintenance_operations where kind='source_recovery' and state='active'`);
      value.admin = { ownerId: row.ownerId, operatorNote: row.operatorNote, actorId: row.actorId,
        startedAt: row.startedAt?.toISOString() ?? null, blockers: await maintenanceBlockers(db),
        activeRecoveries: Number(active.n),
        releaseReview: await maintenanceContinuationReview(db, row.continuationPolicy),
        savedWork: wakes.map(w => ({ companyId: String(w.company_id), issueId: w.issue_id ? String(w.issue_id) : null, requestId: String(w.id), status: String(w.status),
          ...(w.identifier ? { identifier: String(w.identifier) } : {}),
          ...(w.action_id && w.source_run_id ? { recovery: { actionId: String(w.action_id), runId: String(w.source_run_id) } } : {}) })) };
    }
    res.json(value);
  });
  router.get("/instance/maintenance/requests/:requestId",async(req,res)=>{
    admin(req);
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(req.params.requestId))throw conflict("Invalid maintenance request identity.");
    const [operation]=await db.select().from(instanceMaintenanceOperations).where(and(eq(instanceMaintenanceOperations.kind,"source_recovery"),sql`${instanceMaintenanceOperations.authority}->>'requestId' = ${req.params.requestId}`));
    const [event]=await db.select().from(instanceMaintenanceEvents).where(eq(instanceMaintenanceEvents.requestId,req.params.requestId));
    // Settled means the original callback joined, never implicit copy-back or
    // permission to dispatch. Source evidence must still be inspected normally.
    res.json(operation ? {found:true,requestId:req.params.requestId,kind:operation.kind,state:operation.state,generation:operation.generation,
      continuationReleased:false} : event ? {found:true,requestId:req.params.requestId,kind:event.action,state:"recorded",generation:event.generation}
      : {found:false,requestId:req.params.requestId});
  });
  router.post("/instance/maintenance", validate(maintenanceStartSchema), async (req, res) => {
    admin(req);
    await startMaintenance(db, { ...req.body, actorId: getActorInfo(req).actorId });
    await reconcileMaintenance(db);
    res.status(202).json({ accepted: true });
  });
  router.post("/instance/maintenance/release", validate(maintenanceReleaseSchema), async (req, res) => {
    admin(req);
    await releaseMaintenance(db, { ...req.body, actorId: getActorInfo(req).actorId });
    res.json({ accepted: true });
  });
  // This exact-source operation does not enable the global recovery sweep or
  // call onRecovered/cleanup/promotion. Original task permissions still apply.
  router.post("/instance/maintenance/recover-source", validate(maintenanceRecoverySchema), async (req, res) => {
    admin(req);
    const { companyId, issueId, runId, actionId, generation, ownerId, requestId } = req.body;
    const state = await readMaintenance(db);
    if (state.state !== "held" || state.generation !== generation || state.ownerId !== ownerId) throw conflict("Maintenance changed.");
    const source = { companyId, issueId, runId, actionId };
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    if (!issue) throw conflict("The recovery task changed.");
    const decision = await authorizationService(db).decide({ actor: req.actor, action: "issue:mutate", resource: {
      type: "issue", companyId, issueId, projectId: issue.projectId, parentIssueId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, status: issue.status } });
    if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
    const [priorSource]=await db.select().from(instanceMaintenanceOperations).where(and(
      eq(instanceMaintenanceOperations.generation,generation),eq(instanceMaintenanceOperations.kind,"source_recovery"),
      sql`${instanceMaintenanceOperations.authority}->>'companyId' = ${companyId}`,
      sql`${instanceMaintenanceOperations.authority}->>'runId' = ${runId}`));
    if(priorSource)throw conflict("An original recovery request already owns this source. Inspect its receipt; no second operation was started.",
      {code:"maintenance_recovery_request_exists",requestId:priorSource.authority?.requestId});
    const descriptor = run?.resultJson?.workspaceRestoreRecovery as { source?: unknown } | undefined;
    const saved = parseRetainedSshWorkspaceSource(descriptor?.source);
    const authority = { ...source, leaseId: saved.leaseId, leaseGeneration: saved.generation,
      descriptorFingerprint: nativeSha256(descriptor), maintenanceGeneration: generation, maintenanceOwnerId: ownerId,
      operation: "preserve-and-recover-exact-source" as const, requestId };
    const operation = await withMaintenanceOperation(db, "source_recovery", async () => {
      if (!await inspectRetainedSshWorkspaceSource(db, source)) throw conflict("An exact retained SSH recovery source is required.");
      await requestWorkspaceRecovery({ db, ...source, idempotencyKey: requestId, actorId: getActorInfo(req).actorId });
      await recoverRetainedWorkspace({ db, ...source, environmentRuntime: environmentRuntimeService(db) });
    }, authority);
    if (!operation.admitted) throw conflict("Maintenance recovery admission changed.");
    res.json({ accepted: true, executionAdmission: "closed", continuationReleased: false });
  });
  return router;
}
