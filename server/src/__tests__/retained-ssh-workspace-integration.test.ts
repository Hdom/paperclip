import { maintenanceContinuationReview } from "../services/maintenance-continuation-review.js";
import { instanceMaintenanceRoutes } from "../routes/instance-maintenance.js";
import { instanceMaintenanceOperations } from "@paperclipai/db";
import { startMaintenance, reconcileMaintenance, readMaintenance, releaseMaintenance, withMaintenanceOperation, revokeMaintenanceRecovery } from "../services/instance-maintenance.js";
import { nativeSha256 } from "../services/native-runtime/canonical.js";
import { withScopedTaskWorkspaceAuthority } from "../services/scoped-task-workspace-authority.js";
import { recordTaskWorkflowReturn } from "../services/task-workflow-handoff.js";
import { withDedicatedDbConnection } from "@paperclipai/db";
import { commitTaskWorkflowHandoff } from "../services/task-workflow-handoff.js";
import { withDirectoryMergeLock, tryWithDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerTaskWorkflowHandoffWork } from "../services/task-workflow-handoff-work.js";
import { issueWorkflowHandoffs } from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { actorMiddleware } from "../middleware/auth.js";
import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";
import { startAgentLifecycle } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { reconcileCancelledBlockerStallWake } from "../modules/wake-queue/adapters/reconcile-cancelled-stall.js";
import { stallWakeSha256 } from "../modules/wake-queue/adapters/stall-disposition.js";
import { wakeWaitersOfStalledIssues, issueBlockerStalledWakeKey } from "../services/recovery/blocker-stall-wakeups.js";
import { activityLog } from "@paperclipai/db";
import { requestTaskRetry } from "../services/task-retry.js";
import { materializeIsolatedTaskDirectory } from "../services/isolated-task-directory.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { hasControllerWorkspaceAuthority } from "@paperclipai/adapter-utils/controller-workspace-authority";
import { controllerSshWorkspaceTarget } from "@paperclipai/adapter-utils/controller-ssh-workspace";
import { registerServerAdapter, getServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { companySkillService } from "../services/company-skills.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { prepareRemoteManagedRuntime } from "@paperclipai/adapter-utils/remote-managed-runtime";
import { hasRemoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { authUsers, companyMemberships, companySkills } from "@paperclipai/db";
import { extractControllerWorkspaceArchive } from "@paperclipai/adapter-utils/controller-workspace-archive";
import { secretService } from "../services/secrets.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp, mkdir, rm, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issueRelations, issues, workspaceOperations } from "@paperclipai/db";
import { probeSshRunScope, prepareSshRunScope, stopSshRunScope, runSshCommand, shellQuote, type SshConnectionConfig } from "@paperclipai/adapter-utils/ssh";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { retainedSshHostKeyPolicySha256 } from "../services/retained-ssh-workspace-source.js";
import { preserveRetainedSshWorkspace, retainedSshPreservationReceipt } from "../services/retained-ssh-workspace-preservation.js";
import { withNativeWorkspaceFinalizationOwnership } from "../services/native-runtime/native-workspace-finalization-ownership.js";
import { retireDeferredBlockerStallWake, assertNoPendingDeferredBlockerStall } from "../modules/wake-queue/adapters/retire-deferred-stall.js";
import { requestWorkspaceRecovery, recoverRetainedWorkspace } from "../services/workspace-recovery.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { readSystemRecovery } from "../services/system-recovery-state.js";
import * as storageModule from "../storage/index.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";

// Required qualification runs this file through scripts/tests/qualify-isolated-ssh.py.
// Do not weaken the production host/known-key guard to run it on loopback.
const fixturePath = process.env.PAPERCLIP_TEST_ISOLATED_SSH_FIXTURE;
(fixturePath ? describe : describe.skip)("protected retained SSH assembled recovery", () => {
let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let root: string, connection: SshConnectionConfig, bootId: string;
beforeAll(async () => {
  const config = JSON.parse(await readFile(fixturePath!, "utf8"));
  connection = { host: config.host, port: config.port, username: config.username, remoteWorkspacePath: config.remoteWorkspacePath,
    privateKey: await readFile(config.privateKeyPath, "utf8"), knownHosts: (await readFile(config.knownHostsPath, "utf8")).trim(), strictHostKeyChecking: true };
  let probe;
  for (let i=0; i<20; i++) { try { probe = await probeSshRunScope(connection); break; } catch(error) { if(i===19)throw new Error("Synthetic SSH probe refused: "+String((error as {stderr?:unknown}).stderr??"no transport details").slice(0,1000)); await new Promise(resolve=>setTimeout(resolve,100)); } }
  bootId=probe!.bootId;
  root=await mkdtemp(path.join(os.tmpdir(), "retained-ssh-assembled-"));
  vi.stubEnv("PAPERCLIP_HOME",root); vi.stubEnv("PAPERCLIP_INSTANCE_ID","default");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY","63".repeat(32));
  vi.stubEnv("PAPERCLIP_CONTROLLER_ASSET_SNAPSHOT_ROOT",path.join(root,"staging"));
  vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS",JSON.stringify([path.join(root,"staging")]));
  vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS",JSON.stringify([path.join(root,"legacy")]));
  await mkdir(path.join(root,"synthetic-keys"),{mode:0o700});
  vi.stubEnv("PAPERCLIP_CONTROLLER_PROTECTED_PATHS",JSON.stringify([path.join(root,"synthetic-keys")]));
  vi.spyOn(storageModule,"getStorageService").mockReturnValue(createStorageService(createLocalDiskStorageProvider(path.join(root,"objects"))));
  database=await startEmbeddedPostgresTestDatabase("retained-ssh-assembled-");db=createDb(database.connectionString);
  await db.insert(authUsers).values({id:"operator",name:"Synthetic operator",email:"synthetic-operator@example.test",createdAt:new Date(),updatedAt:new Date()});
},90000);
afterAll(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await database?.cleanup();if(root)await rm(root,{recursive:true,force:true});});
async function seed() {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), actionId = randomUUID(),
    workspaceId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID();
  const config = {...connection,privateKey:null};
  vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", "1"); vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", "");
  vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS", JSON.stringify([config]));
  await db.insert(companies).values({ id: companyId, name: "Retained source fixture", issuePrefix: "R" + companyId.replaceAll("-", "") });
  await db.insert(agents).values({ id: agentId, companyId, name: "Original Coordinator", role: "engineer", adapterType: "codex_local" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Original blocked task", status: "blocked", assigneeAgentId: agentId });
  await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, name: "Original attempt",
    mode: "isolated_workspace", strategyType: "project_primary", cwd: "/metadata-only-fixture/" + runId, providerType: "local_fs" });
  await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
  await db.insert(environments).values({ id: environmentId, name: "Approved synthetic target " + environmentId, driver: "ssh", config });
  const secret=await secretService(db).create(companyId,{name:"synthetic-fixture-ssh",provider:"local_encrypted",value:connection.privateKey!});
  await secretService(db).createBinding({companyId,secretId:secret.id,targetType:"environment",targetId:environmentId,configPath:"privateKeySecretRef"});
  await db.update(environments).set({config:{...config,privateKeySecretRef:{type:"secret_ref",secretId:secret.id,version:"latest"}}}).where(eq(environments.id,environmentId));
  const scope = { schema: "paperclip.ssh-run-scope.v1" as const, companyId, runId, leaseId, generation: randomUUID(), bootId: bootId };
  const providerLeaseId = `ssh://${config.username}@${config.host}:${config.port}${config.remoteWorkspacePath}`;
  const source = { provider: "ssh" as const, runId, executionWorkspaceId: workspaceId, leaseId, environmentId, providerLeaseId,
    remoteDir: `${config.remoteWorkspacePath}/.paperclip-runtime/runs/${runId}/workspace`,
    endpoint: { host: config.host, port: config.port, username: config.username, remoteCwd: config.remoteWorkspacePath }, generation: scope.generation, bootId: scope.bootId,
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

it.each(["Coordinator","Researcher","Planner","Implementer","Reviewer","ResearcherRetry","CoordinatorInitial","ResearcherInitial","PlannerInitial","ImplementerInitial","ReviewerInitial"])("fresh %s heartbeat prepares linked saved skills, returns status before copyback and stops SSH",async scenario=>{
  const unboundRetry=scenario==="ResearcherRetry",unboundInitial=scenario.endsWith("Initial"),role=scenario.replace(/(?:Retry|Initial)$/, "");
  const companyId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),environmentId=randomUUID(),skillId=randomUUID(),key=`company/${companyId}/linked-test`;
  await db.insert(companies).values({id:companyId,name:"Fresh "+role,issuePrefix:"F"+companyId.replaceAll("-",""),requireBoardApprovalForNewAgents:false,defaultResponsibleUserId:"operator"});
  await db.insert(companyMemberships).values({companyId,principalType:"user",principalId:"operator",status:"active",membershipRole:"member"});
  await instanceSettingsService(db).updateExperimental({enableBetaSkills:true,enableIsolatedWorkspaces:true});
  const linked=path.join(root,"external-linked-must-not-recapture",skillId);await mkdir(linked,{recursive:true,mode:0o700});
  await writeFile(path.join(linked,"SKILL.md"),"# Immutable saved skill for "+role+"\n");
  await db.insert(companySkills).values({id:skillId,companyId,key,slug:"linked-test",name:"Linked saved fixture",markdown:"# Saved fixture",sourceType:"local_path",
    sourceLocator:path.join(root,"external-linked-must-not-recapture",skillId),metadata:{sourceKind:"local_path"},trustLevel:"markdown_only",compatibility:"compatible",fileInventory:[{path:"SKILL.md",kind:"skill"}]});
  const version=await companySkillService(db).createVersion(companyId,skillId,{}, {type:"user",userId:"operator"},
    {fileInventory:[{path:"SKILL.md",kind:"skill",content:"# Immutable saved skill for "+role+"\n"}]});
  const secret=await secretService(db).create(companyId,{name:"synthetic-fresh-ssh",provider:"local_encrypted",value:connection.privateKey!});
  await secretService(db).createBinding({companyId,secretId:secret.id,targetType:"environment",targetId:environmentId,configPath:"privateKeySecretRef"});
  await db.insert(environments).values({id:environmentId,name:"Fresh SSH "+role+environmentId,driver:"ssh",config:{...connection,privateKey:null,privateKeySecretRef:{type:"secret_ref",secretId:secret.id,version:"latest"}}});
  await db.insert(agents).values({id:agentId,companyId,name:role,role:"engineer",status:"idle",adapterType:"codex_local",defaultEnvironmentId:environmentId,runtimeConfig:{heartbeat:{wakeOnDemand:true}},
    adapterConfig:{paperclipSkillSync:{desiredSkills:[{key}]}},permissions:{}});
  const providerSecret=await secretService(db).create(companyId,{name:"synthetic-provider-not-valid",provider:"local_encrypted",value:"sk-synthetic-fixture-never-sent-to-a-provider"});
  await secretService(db).createBinding({companyId,secretId:providerSecret.id,targetType:"agent",targetId:agentId,configPath:"env.OPENAI_API_KEY"});
  await db.update(agents).set({adapterConfig:{paperclipSkillSync:{desiredSkills:[{key}]},env:{OPENAI_API_KEY:{type:"secret_ref",secretId:providerSecret.id,version:"latest"}}}}).where(eq(agents.id,agentId));
  await db.insert(issues).values({id:issueId,companyId,title:"Fresh "+role+" qualification",status:"todo",assigneeAgentId:agentId,});
  // Match the approved run's explicit native directory binding. Fresh here
  // means no previous agent run or skill-version map, not a Git worktree.
  if(!unboundRetry&&!unboundInitial){
  const nativeCwd=await materializeIsolatedTaskDirectory({companyId,issueId});
  const [nativeWorkspace]=await db.insert(executionWorkspaces).values({companyId,sourceIssueId:issueId,name:"Explicit native task directory",mode:"isolated_workspace",strategyType:"project_primary",cwd:nativeCwd,providerType:"local_fs"}).returning();
  await executionWorkspaceService(db).bindTaskWorkspace(companyId,issueId,nativeWorkspace.id);
  await db.update(issues).set({executionWorkspacePreference:"reuse_existing",workspaceSelection:{version:1,source:"explicit",selection:{kind:"existing",workspaceId:nativeWorkspace.id}}}).where(eq(issues.id,issueId));
  }
  await instanceSettingsService(db).updateExperimental({enableBetaSkills:true,enableIsolatedWorkspaces:true});
  vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS","1");vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG","");
  vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS",JSON.stringify([{...connection,privateKey:undefined}]));
  vi.stubEnv("PAPERCLIP_API_URL","http://127.0.0.1:3100/api");
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET","synthetic-only-fixture-jwt-signing-secret-64-characters-long-value");
  const original=getServerAdapter("codex_local");let providerCount=0,localCwd="";
  registerServerAdapter({...original,type:"codex_local",execute:async ctx=>{
    providerCount++;
    expect(ctx.executionTarget?.kind).toBe("remote");
    if(ctx.executionTarget?.kind!=="remote"||ctx.executionTarget.transport!=="ssh")throw Error("Expected production-admitted SSH target");
    expect(ctx.executionTarget.spec.runScope?.runId).toBe(ctx.runId);
    const skills=ctx.config.paperclipRuntimeSkills as Array<{key:string;versionId:string;source:string}>;
    const skill=skills.find(entry=>entry.key===key);expect(skill?.versionId).toBe(version.id);
    expect(await readFile(path.join(skill!.source,"SKILL.md"),"utf8")).toContain("Immutable saved skill for "+role);
    expect(ctx.runtimeMcp?.getServers().some(server=>server.connectionId==="paperclip-project-tools")).toBe(true);
    localCwd=String((ctx.context.paperclipWorkspace as {cwd?:string})?.cwd??ctx.config.cwd??"");expect(path.isAbsolute(localCwd)).toBe(true);
    const [bound]=await db.select({cwd:executionWorkspaces.cwd,mode:executionWorkspaces.mode,strategy:executionWorkspaces.strategyType,repo:executionWorkspaces.repoUrl,branch:executionWorkspaces.branchName}).from(issues).innerJoin(executionWorkspaces,eq(issues.executionWorkspaceId,executionWorkspaces.id)).where(eq(issues.id,issueId));
    const expectedTarget=controllerSshWorkspaceTarget(ctx.executionTarget.spec,ctx.runId,path.posix.join(ctx.executionTarget.spec.remoteCwd,".paperclip-runtime/runs",ctx.runId,"workspace"));
    expect(bound).toMatchObject({cwd:localCwd,mode:"isolated_workspace",strategy:"project_primary",repo:null,branch:null});
    expect(hasControllerWorkspaceAuthority(localCwd,expectedTarget)).toBe(true);
    if(unboundRetry||unboundInitial){
      expect(localCwd).toBe(path.join(root,"instances/default/isolated-workspace-attempts",companyId,issueId,ctx.runId));

    }
    const [enteredTask]=await db.select({status:issues.status,executionRunId:issues.executionRunId}).from(issues).where(eq(issues.id,issueId));
    expect(enteredTask).toMatchObject({status:"in_progress",executionRunId:ctx.runId});
    const runtime=await prepareRemoteManagedRuntime({spec:ctx.executionTarget.spec,runId:ctx.runId,adapterKey:"synthetic-fresh-role",workspaceLocalDir:localCwd,assets:[{key:"saved-skill",localDir:skill!.source}]});
    try{
      await runSshCommand(ctx.executionTarget.spec,`printf ${shellQuote(role+" returned work")} > ${shellQuote(runtime.workspaceRemoteDir+"/returned.txt")}`);
      await issueService(db).update(issueId,{status:role==="Coordinator"?"blocked":"done",actorAgentId:agentId,actorRunId:ctx.runId});
    }finally{await runtime.restoreWorkspace();}
    return {exitCode:0,signal:null,timedOut:false,label:"Synthetic provider completed"};
  }});
  const heartbeat=heartbeatService(db);
  try{
    let started;
    if(unboundRetry){
      // Match DNL-31: failed before provider preparation, no task workspace,
      // no selection, and no agent-supplied fresh-mode override.
      const [failed]=await db.insert(heartbeatRuns).values({companyId,agentId,issueId,status:"failed",runtimeMode:"legacy",
        contextSnapshot:{issueId},errorCode:"configuration_incomplete",startedAt:new Date(Date.now()-2000),finishedAt:new Date(Date.now()-1000)}).returning();
      await db.update(issues).set({status:"blocked"}).where(eq(issues.id,issueId));
      const retry=await requestTaskRetry({db,companyId,issueId,actorId:"operator",actorSource:"session",observedRunId:failed.id,idempotencyKey:randomUUID()});
      expect(retry.accepted).toBe(true);
      await heartbeat.resumeTaskRetry(companyId,retry.requestId!);
      const [receipt]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,retry.requestId!));
      expect(receipt.runId).toBeTruthy();started=await heartbeat.getRun(receipt.runId!);
    }else started=await heartbeat.invoke(agentId,"on_demand",{issueId,wakeReason:"issue_assigned"},"manual");
    const diagnostic=started?[]:await db.select({status:agentWakeupRequests.status,reason:agentWakeupRequests.reason,error:agentWakeupRequests.error}).from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,agentId));
    expect(started,JSON.stringify(diagnostic)).not.toBeNull();
    let finished=await heartbeat.getRun(started!.id);
    for(let i=0;i<600&&finished&&["queued","running"].includes(finished.status);i++){await new Promise(resolve=>setTimeout(resolve,100));finished=await heartbeat.getRun(started!.id);}
    expect(finished?.status,finished?.error??undefined).toBe("succeeded");await heartbeat.drainActiveRunExecutions();
    expect(providerCount).toBe(1);expect(await readFile(path.join(localCwd,"returned.txt"),"utf8")).toBe(role+" returned work");
    const leases=await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId,started!.id));
    expect(leases).toHaveLength(1);expect(hasRemoteTerminationReceipt(leases[0])).toBe(true);
    const roleRuns=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,companyId));
    expect(roleRuns).toHaveLength(unboundRetry?2:1);
    expect(roleRuns.filter(run=>run.status!=="failed").map(run=>run.id)).toEqual([started!.id]);
  }finally{registerServerAdapter(original);await heartbeat.drainActiveRunExecutions();}
},90000);

it.each(["complete","revoke_before_completion","lost_reply"] as const)("maintenance exact source recovery preserves real SSH bytes while admissions and original intents stay held: %s",async mode=>{
  const originalDb=db,maintenanceDatabase=await startEmbeddedPostgresTestDatabase("maintenance-real-ssh-");
  db=createDb(maintenanceDatabase.connectionString);
  try {
  const f=await seed(),spec={...connection,remoteCwd:connection.remoteWorkspacePath!,runScope:f.scope};
  await prepareSshRunScope(connection,f.scope);
  await runSshCommand(spec,`mkdir -p ${shellQuote(f.source.remoteDir)} && chmod 700 ${shellQuote(f.source.remoteDir)} && printf 'maintenance retained real bytes' > ${shellQuote(f.source.remoteDir+'/saved.txt')}`);
  await stopSshRunScope(spec,f.scope);
  const [wake]=await db.insert(agentWakeupRequests).values({companyId:f.input.companyId,agentId:f.agentId,source:"automation",status:"deferred_issue_execution",payload:{issueId:f.input.issueId,executionWait:{reason:"execution_recovery",recoveryActionId:f.input.actionId}}}).returning();
  const initial=await readMaintenance(db);
  const held=await startMaintenance(db,{actorId:"operator",requestId:randomUUID(),expectedGeneration:initial.generation,operatorNote:"Synthetic source only",continuationPolicy:"requires_readiness_decision"});
  expect((await reconcileMaintenance(db)).state).toBe("held");
  let savedOperationId="";
  let result:{admitted:boolean};
  if(mode==="lost_reply") {
    await db.insert(authUsers).values({id:"operator",name:"Synthetic operator",email:"synthetic-operator@example.test",createdAt:new Date(),updatedAt:new Date()});
    await db.insert(companyMemberships).values({companyId:f.input.companyId,principalType:"user",principalId:"operator",status:"active",membershipRole:"owner"});
    let drop=true;
    const app=express();app.use(express.json());app.use((req,res,next)=>{
      req.actor={type:"board",userId:"operator",source:"session",isInstanceAdmin:true,companyIds:[f.input.companyId],memberships:[{companyId:f.input.companyId,membershipRole:"owner",status:"active"}]};
      if(req.method==="POST"&&req.path==="/instance/maintenance/recover-source"&&drop){
        const json=res.json.bind(res);res.json=((value:unknown)=>{if(value&&typeof value==="object"&&"accepted" in value){drop=false;res.destroy();return res;}return json(value);}) as typeof res.json;
      }
      next();
    });app.use(instanceMaintenanceRoutes(db));app.use(errorHandler);
    const requestId=randomUUID(),payload={...f.input,requestId,generation:held.generation,ownerId:held.ownerId};
    await expect(request(app).post('/instance/maintenance/recover-source').send(payload)).rejects.toThrow();
    const receipt=await request(app).get(`/instance/maintenance/requests/${requestId}`);
    expect(receipt.status,receipt.text).toBe(200);expect(receipt.body).toMatchObject({found:true,requestId,state:"settled",continuationReleased:false});
    for(const retryId of [requestId,randomUUID()]) {
      const retry=await request(app).post('/instance/maintenance/recover-source').send({...payload,requestId:retryId});
      expect(retry.status,retry.text).toBe(409);
    }
    expect((await db.select().from(instanceMaintenanceOperations).where(eq(instanceMaintenanceOperations.kind,"source_recovery")))).toHaveLength(1);
    const operations=await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId,f.input.runId));
    const snapshots=operations.filter(op=>op.phase==="workspace_recovery_snapshot");expect(snapshots).toHaveLength(1);savedOperationId=snapshots[0].id;
    result={admitted:true};
  } else result=await withMaintenanceOperation(db,"source_recovery",async()=>{
    const preserved=await withNativeWorkspaceFinalizationOwnership({db,companyId:f.input.companyId,runId:f.input.runId,retainedRepairActionId:f.input.actionId},owner=>preserveRetainedSshWorkspace({...f.input,db,assertHeld:owner.assertHeld}));
    if(!preserved.acquired)throw Error("Synthetic source owner unavailable");savedOperationId=preserved.value;
    await requestWorkspaceRecovery({...f.input,db,idempotencyKey:randomUUID(),actorId:"operator"});
    if(mode==="complete")await recoverRetainedWorkspace({...f.input,db,environmentRuntime:environmentRuntimeService(db)});
    else {
      let signal!:()=>void,release!:()=>void;const atCommit=new Promise<void>(resolve=>{signal=resolve;}),continueCommit=new Promise<void>(resolve=>{release=resolve;});
      const transaction=db.transaction.bind(db);
      // Fault injection at the real final-transaction boundary. All authority,
      // SQL, archive, ownership and stop checks still use the actual services.
      const spy=vi.spyOn(db,"transaction").mockImplementation(async(callback,...args)=>{
        if(callback.toString().includes('workspace_finalize')){signal();await continueCommit;}
        return transaction(callback,...args);
      });
      const recovery=recoverRetainedWorkspace({...f.input,db,environmentRuntime:environmentRuntimeService(db)});
      const refused=expect(recovery).rejects.toThrow(/revoked/);
      try {
        await atCommit;
        const [op]=await db.select().from(instanceMaintenanceOperations).where(eq(instanceMaintenanceOperations.state,"active"));
        await revokeMaintenanceRecovery(db,{generation:held.generation,ownerId:held.ownerId!,operationId:op.id,actorId:"operator",requestId:randomUUID()});
      } finally {release();await refused;spy.mockRestore();}
    }
  },{...f.input,leaseId:f.leaseId,leaseGeneration:f.scope.generation,descriptorFingerprint:nativeSha256(f.recovery),maintenanceGeneration:held.generation,maintenanceOwnerId:held.ownerId!,operation:"preserve-and-recover-exact-source",requestId:randomUUID()});
  expect(result.admitted).toBe(true);
  const [operation]=await db.select().from(workspaceOperations).where(eq(workspaceOperations.id,savedOperationId));
  const archive=operation.metadata!.archive as {objectKey:string;sha256:string;byteSize:number};
  const stored=await storageModule.getStorageService().getObject(f.input.companyId,archive.objectKey);const chunks:Buffer[]=[];
  for await(const chunk of stored.stream)chunks.push(Buffer.from(chunk));
  const content=Buffer.concat(chunks);expect(content.length).toBe(archive.byteSize);expect(createHash("sha256").update(content).digest("hex")).toBe(archive.sha256);
  const dest=await mkdtemp(path.join(root,"staging","maintenance-bytes-")),archiveFile=path.join(dest,"snapshot.tar"),tree=path.join(dest,"files");
  await writeFile(archiveFile,content,{mode:0o600});await mkdir(tree,{mode:0o700});await extractControllerWorkspaceArchive(archiveFile,tree);
  expect(await readFile(path.join(tree,"saved.txt"),"utf8")).toBe("maintenance retained real bytes");
  expect((await readMaintenance(db)).state).toBe("held");
  expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id)))[0]).toEqual(wake);
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,f.input.companyId))).map(run=>run.id)).toEqual([f.input.runId]);
  const [action]=await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id,f.input.actionId));
  if(mode!=="revoke_before_completion")expect(readSystemRecovery(action.evidence)).toMatchObject({state:"complete",preservationOperationIds:[savedOperationId]});
  else {
    expect(readSystemRecovery(action.evidence)?.state).not.toBe("complete");
    expect((await getExecutionBlocker(db,f.input.companyId,f.input.issueId))?.workspaceRepairRequired).toBe(true);
    expect((await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId,f.input.runId))).filter(op=>op.phase==="workspace_finalize")).toHaveLength(0);
  }
  await expect(runSshCommand(spec,"true")).rejects.toMatchObject({code:125});
  } finally {await db.$client.end();await maintenanceDatabase.cleanup();db=originalDb;}
},90000);

it.each(["retry_first","notification_first","pause_retry_first","pause_interrupted_notification_first"])("preserves immutable output before exact audited wake retirement, recovery and public Retry: %s",async order=>{
  const paused=order.startsWith("pause_"),deliveryOrder=order.replace(/^pause_/,"").replace(/^interrupted_/,"");
  const f=await seed(), spec={...connection,remoteCwd:connection.remoteWorkspacePath!,runScope:f.scope};
  if(order.includes("interrupted"))await db.update(heartbeatRuns).set({status:"interrupted"}).where(eq(heartbeatRuns.id,f.input.runId));
  await prepareSshRunScope(connection,f.scope);
  await runSshCommand(spec,`mkdir -p ${shellQuote(f.source.remoteDir)} && chmod 700 ${shellQuote(f.source.remoteDir)} && printf 'retained synthetic output' > ${shellQuote(f.source.remoteDir+'/saved.txt')}`);
  await stopSshRunScope(spec,f.scope);
  await expect(runSshCommand(spec,"true")).rejects.toMatchObject({code:125});
  const [child]=await db.insert(issues).values({companyId:f.input.companyId,title:"Stalled child",status:"blocked",parentId:f.input.issueId,assigneeAgentId:f.agentId}).returning();
  await db.insert(issueRelations).values({companyId:f.input.companyId,issueId:child.id,relatedIssueId:f.input.issueId,type:"blocks"});
  const [childAction]=await db.insert(issueRecoveryActions).values({companyId:f.input.companyId,sourceIssueId:child.id,kind:"run_recovery",status:"escalated",ownerType:"board",cause:"execution_recovery_budget_exhausted",fingerprint:randomUUID(),nextAction:"Retry child"}).returning();
  const app=express();app.use(express.json());app.use((req,_res,next)=>{
    req.actor={type:"board",userId:"operator",source:"session",companyIds:[f.input.companyId],
      memberships:[{companyId:f.input.companyId,membershipRole:"owner",status:"active"}]};next();
  });app.use("/api/companies",companyRoutes(db));app.use(errorHandler);
  const patchCompany=async(status:"active"|"paused")=>{
    const result=await request(app).patch(`/api/companies/${f.input.companyId}`).send({status});
    expect(result.status,result.text).toBe(200);
  };
  const actualDriver=createLifecycleDriver(db,{} as never);
  // Real public route, company policy projection and host Stop. Provider setup
  // verification is synthetic; it must not call a real model in qualification.
  const lifecycle=paused?startAgentLifecycle(db,{...actualDriver,runHost:async agent=>
    agent.lifecycleState==="verifying"?"complete":actualDriver.runHost(agent)},()=>true):null;
  const settleLifecycle=async(state:"ready"|"paused")=>{
    for(let n=0;n<20;n++){
      await lifecycle!.sweep();
      const [agent]=await db.select().from(agents).where(eq(agents.id,f.agentId));
      if(agent.lifecycleState===state)return;
    }
    throw Error("Public lifecycle did not settle to "+state);
  };
  let staleDelivery:Promise<unknown>|undefined,releaseStale!:()=>void,heartbeatForStale:ReturnType<typeof heartbeatService>;
  if(paused){
    let selected!:()=>void;const selectedFence=new Promise<void>(resolve=>{selected=resolve;});
    const admissionFence=new Promise<void>(resolve=>{releaseStale=resolve;});
    // The sweep selects the incident before pause/reconciliation, but its
    // actual public queue admission is deliberately delayed until afterward.
    staleDelivery=wakeWaitersOfStalledIssues(db,async(agentId,input)=>{
      selected();await admissionFence;return heartbeatForStale.wakeup(agentId,input);
    },{companyId:f.input.companyId});
    await selectedFence;
  }
  const [wake]=await db.insert(agentWakeupRequests).values({companyId:f.input.companyId,agentId:f.agentId,source:"automation",requestedByActorType:"system",requestedByActorId:"issue-blocker-stall",status:"deferred_issue_execution",
    idempotencyKey:issueBlockerStalledWakeKey({waiterIssueId:f.input.issueId,stalledIssueId:child.id,recoveryActionId:childAction.id}),
    requestedAt:new Date(Date.now()-11*60_000),payload:{issueId:f.input.issueId,stalledIssueId:child.id,recoveryAction:{id:childAction.id},_paperclipWakeContext:{issueId:f.input.issueId,wakeReason:"issue_blocker_stalled",blockerStall:{stalledIssueId:child.id,recoveryAction:{id:childAction.id}}}}}).returning();
  await db.insert(companyMemberships).values({companyId:f.input.companyId,principalType:"user",principalId:"operator",status:"active",membershipRole:"owner"});
  let cancelled:typeof wake|undefined,pauseActivityId="",cancellationSha256="";
  const cancellationIdentity=async()=> (await db.select({sha256:stallWakeSha256()}).from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id)))[0].sha256;
  if(paused){
    await patchCompany("paused");await settleLifecycle("paused");
    [cancelled]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id));
    expect(cancelled).toMatchObject({status:"cancelled",runId:null,error:"Agent lifecycle stop requested"});
    const pauses=await db.select().from(activityLog).where(eq(activityLog.companyId,f.input.companyId));
    pauseActivityId=pauses.find(row=>row.action==="company.updated"&&row.details?.status==="paused")!.id;
    cancellationSha256=await cancellationIdentity();
    const utc=await db.transaction(async tx=>{
      await tx.execute(sql`set local time zone 'UTC'`);
      return (await tx.select({sha256:stallWakeSha256()}).from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id)))[0].sha256;
    });expect(utc).toBe(cancellationSha256);
  }
  const disposition={...f.input,sourceActionId:f.input.actionId,wakeId:wake.id,stalledIssueId:child.id,stalledActionId:childAction.id,actorId:"operator"};
  expect((await getExecutionBlocker(db,f.input.companyId,f.input.issueId))?.workspaceRepairRequired).toBe(true);
  await expect(paused?reconcileCancelledBlockerStallWake(db,{...disposition,pauseActivityId,cancellationSha256,snapshotOperationId:randomUUID()}):retireDeferredBlockerStallWake(db,disposition)).rejects.toThrow(/snapshot/);
  await expect(assertNoPendingDeferredBlockerStall(db,f.input.companyId,f.input.issueId)).rejects.toThrow();
  const storage=storageModule.getStorageService(),put=storage.putFile.bind(storage);
  const lostReply=vi.spyOn(storage,"putFile").mockImplementationOnce(async input=>{await put(input);throw Error("synthetic lost archive upload reply");});
  try{
    await expect(withNativeWorkspaceFinalizationOwnership({db,companyId:f.input.companyId,runId:f.input.runId,retainedRepairActionId:f.input.actionId},
      owner=>preserveRetainedSshWorkspace({...f.input,db,assertHeld:owner.assertHeld}))).rejects.toThrow("synthetic lost archive upload reply");
    await expect(paused?reconcileCancelledBlockerStallWake(db,{...disposition,pauseActivityId,cancellationSha256,snapshotOperationId:randomUUID()}):retireDeferredBlockerStallWake(db,disposition)).rejects.toThrow(/snapshot/);
  }finally{lostReply.mockRestore();}
  const preserved=await withNativeWorkspaceFinalizationOwnership({db,companyId:f.input.companyId,runId:f.input.runId,retainedRepairActionId:f.input.actionId},
    owner=>preserveRetainedSshWorkspace({...f.input,db,assertHeld:owner.assertHeld}));
  expect(preserved.acquired).toBe(true);
  if(!preserved.acquired)throw Error("Source ownership not acquired");
  expect(await retainedSshPreservationReceipt(db,{...f.input,operationIds:[preserved.value]})).toBe(preserved.value);
  const reconcile={...disposition,pauseActivityId,cancellationSha256,snapshotOperationId:preserved.value};
  if(paused){
    for(const change of [{pauseActivityId:randomUUID()},{snapshotOperationId:randomUUID()},{sourceActionId:randomUUID()},
      {cancellationSha256:"0".repeat(64)},{stalledActionId:randomUUID()},{actorId:"unrelated-user"}])
      await expect(reconcileCancelledBlockerStallWake(db,{...reconcile,...change})).rejects.toThrow();
    // Timestamps are part of the fingerprint, independent of DB timezone.
    for(const key of ["updatedAt","finishedAt"] as const){
      await db.update(agentWakeupRequests).set({[key]:new Date(cancelled![key]!.getTime()+1000)}).where(eq(agentWakeupRequests.id,wake.id));
      expect(await cancellationIdentity()).not.toBe(cancellationSha256);
      await expect(reconcileCancelledBlockerStallWake(db,reconcile)).rejects.toThrow(/cancellation changed/);
      await db.update(agentWakeupRequests).set({[key]:cancelled![key]}).where(eq(agentWakeupRequests.id,wake.id));
    }
  }
  // Claimed notifications and an active successor must never be retired.
  await db.update(agentWakeupRequests).set({status:"claimed"}).where(eq(agentWakeupRequests.id,wake.id));
  if(paused)await expect(reconcileCancelledBlockerStallWake(db,reconcile)).rejects.toThrow(/cancellation changed/);
  else await expect(retireDeferredBlockerStallWake(db,disposition)).rejects.toThrow(/pending incident/);
  await db.update(agentWakeupRequests).set({status:paused?"cancelled":"deferred_issue_execution"}).where(eq(agentWakeupRequests.id,wake.id));
  for(const status of paused?["queued","succeeded"]:["queued"]){
    const [successor]=await db.insert(heartbeatRuns).values({companyId:f.input.companyId,agentId:f.agentId,issueId:f.input.issueId,status,runtimeMode:"legacy",contextSnapshot:{issueId:f.input.issueId}}).returning();
    try{await expect(paused?reconcileCancelledBlockerStallWake(db,reconcile):retireDeferredBlockerStallWake(db,disposition)).rejects.toThrow();}
    finally{await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id,successor.id));}
  }
  const [savedOperation]=await db.select().from(workspaceOperations).where(eq(workspaceOperations.id,preserved.value));
  const archive=savedOperation.metadata!.archive as {objectKey:string;sha256:string;byteSize:number};
  const stored=await storageModule.getStorageService().getObject(f.input.companyId,archive.objectKey);
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of stored.stream){bytes+=chunk.length;if(bytes>archive.byteSize)throw Error("Snapshot size changed");chunks.push(Buffer.from(chunk));}
  const content=Buffer.concat(chunks);
  expect(content.length).toBe(archive.byteSize);expect(createHash("sha256").update(content).digest("hex")).toBe(archive.sha256);
  const receiptRoot=await mkdtemp(path.join(root,"staging","snapshot-proof-")),archivePath=path.join(receiptRoot,"saved.tar"),extracted=path.join(receiptRoot,"tree");
  await writeFile(archivePath,content,{mode:0o600});await mkdir(extracted,{mode:0o700});
  await extractControllerWorkspaceArchive(archivePath,extracted);
  expect(await readFile(path.join(extracted,"saved.txt"),"utf8")).toBe("retained synthetic output");
  // Exercise the production completion path with the notification still live.
  await requestWorkspaceRecovery({...f.input,db,idempotencyKey:randomUUID(),actorId:"operator"});
  await recoverRetainedWorkspace({...f.input,db,environmentRuntime:environmentRuntimeService(db)});
  const [pendingAction]=await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id,f.input.actionId));
  expect(readSystemRecovery(pendingAction.evidence)).toMatchObject({state:"exhausted",failure:{code:"effect_unresolved",retryClass:"user_action_required"}});
  expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id)))[0]).toMatchObject({status:paused?"cancelled":"deferred_issue_execution",runId:null});
  expect((await getExecutionBlocker(db,f.input.companyId,f.input.issueId))?.workspaceRepairRequired).toBe(true);
  if(paused){
    await expect(reconcileCancelledBlockerStallWake(db,reconcile)).resolves.toMatchObject({alreadyReconciled:false,dispatchCreated:false});
    await expect(reconcileCancelledBlockerStallWake(db,reconcile)).resolves.toMatchObject({alreadyReconciled:true,dispatchCreated:false});
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id)))[0]).toEqual(cancelled);
    // Suppression/completion must revalidate the evidence the owner actually
    // certified, not just trust a surviving audit or a matching archive hash.
    const [sourceRun]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.input.runId));
    const [sourceAction]=await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id,f.input.actionId));
    const [sourceLease]=await db.select().from(environmentLeases).where(eq(environmentLeases.id,f.leaseId));
    const mutations=[
      {apply:()=>db.update(issueRecoveryActions).set({evidence:{...sourceAction.evidence,workspaceRestoreRecovery:{...f.recovery,source:{...f.source,remoteDir:"/unrelated"}}}}).where(eq(issueRecoveryActions.id,f.input.actionId)),
        restore:()=>db.update(issueRecoveryActions).set({evidence:sourceAction.evidence}).where(eq(issueRecoveryActions.id,f.input.actionId))},
      {apply:()=>db.update(workspaceOperations).set({metadata:{...savedOperation.metadata,archive:{...savedOperation.metadata!.archive as Record<string,unknown>,byteSize:1}}}).where(eq(workspaceOperations.id,preserved.value)),
        restore:()=>db.update(workspaceOperations).set({metadata:savedOperation.metadata}).where(eq(workspaceOperations.id,preserved.value))},
      {apply:()=>db.update(heartbeatRuns).set({resultJson:{...sourceRun.resultJson,workspaceRestoreRecovery:{...f.recovery,source:{...f.source,generation:randomUUID()}}}}).where(eq(heartbeatRuns.id,f.input.runId)),
        restore:()=>db.update(heartbeatRuns).set({resultJson:sourceRun.resultJson}).where(eq(heartbeatRuns.id,f.input.runId))},
      {apply:()=>db.update(environmentLeases).set({cleanupStatus:"pending"}).where(eq(environmentLeases.id,f.leaseId)),
        restore:()=>db.update(environmentLeases).set({cleanupStatus:sourceLease.cleanupStatus}).where(eq(environmentLeases.id,f.leaseId))},
      {apply:()=>db.update(workspaceOperations).set({metadata:{...savedOperation.metadata,sourceProof:{schema:"unverified"}}}).where(eq(workspaceOperations.id,preserved.value)),
        restore:()=>db.update(workspaceOperations).set({metadata:savedOperation.metadata}).where(eq(workspaceOperations.id,preserved.value))},
      {apply:()=>db.update(agentWakeupRequests).set({finishedAt:new Date(cancelled!.finishedAt!.getTime()+1000)}).where(eq(agentWakeupRequests.id,wake.id)),
        restore:()=>db.update(agentWakeupRequests).set({finishedAt:cancelled!.finishedAt}).where(eq(agentWakeupRequests.id,wake.id))},
    ];
    for(const change of mutations){
      await change.apply();
      try{await expect(assertNoPendingDeferredBlockerStall(db,f.input.companyId,f.input.issueId,f.input.runId)).rejects.toThrow(/reconciled/);}
      finally{await change.restore();}
    }
    await expect(assertNoPendingDeferredBlockerStall(db,f.input.companyId,f.input.issueId,f.input.runId)).resolves.toBeUndefined();
    const enqueue=vi.fn();await wakeWaitersOfStalledIssues(db,enqueue,{companyId:f.input.companyId});expect(enqueue).not.toHaveBeenCalled();
  }else{
    await expect(retireDeferredBlockerStallWake(db,disposition)).resolves.toMatchObject({alreadyRetired:false,dispatchCreated:false});
    await expect(retireDeferredBlockerStallWake(db,disposition)).resolves.toMatchObject({alreadyRetired:true,dispatchCreated:false});
  }
  await requestWorkspaceRecovery({...f.input,db,idempotencyKey:randomUUID(),actorId:"operator"});
  await recoverRetainedWorkspace({...f.input,db,environmentRuntime:environmentRuntimeService(db)});
  const [action]=await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id,f.input.actionId));
  expect(readSystemRecovery(action.evidence)).toMatchObject({state:"complete",preservationOperationIds:[preserved.value]});
  expect((await getExecutionBlocker(db,f.input.companyId,f.input.issueId))?.workspaceRepairRequired??false).toBe(false);
  const runs=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,f.input.companyId));
  expect(runs.map(run=>run.id)).toEqual([f.input.runId]);
  expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id)))[0]).toMatchObject({status:"cancelled",runId:null});
  expect(await readFile(path.join(f.source.remoteDir,"saved.txt"),"utf8")).toBe("retained synthetic output");
  const sourceOperations=await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId,f.input.runId));
  expect(sourceOperations.filter(operation=>operation.phase==="workspace_recovery_snapshot")).toHaveLength(1);
  await expect(runSshCommand(spec,"true")).rejects.toMatchObject({code:125});
  // Queue the one explicit source-bound continuation while company dispatch is
  // fenced. Both delivery orders must retain the same archive and one successor.
  await db.update(companies).set({...(paused?{}:{status:"paused"}),defaultResponsibleUserId:"operator"}).where(eq(companies.id,f.input.companyId));
  const providerSecret=await secretService(db).create(f.input.companyId,{name:"synthetic-retry-provider",provider:"local_encrypted",value:"sk-synthetic-retry-never-sent-to-provider"});
  await secretService(db).createBinding({companyId:f.input.companyId,secretId:providerSecret.id,targetType:"agent",targetId:f.agentId,configPath:"env.OPENAI_API_KEY"});
  await db.update(agents).set({...(paused?{}:{status:"idle"}),defaultEnvironmentId:f.environmentId,runtimeConfig:{heartbeat:{wakeOnDemand:true}},
    adapterConfig:{env:{OPENAI_API_KEY:{type:"secret_ref",secretId:providerSecret.id,version:"latest"}}}}).where(eq(agents.id,f.agentId));
  vi.stubEnv("PAPERCLIP_API_URL","http://127.0.0.1:3100/api");vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET","synthetic-only-fixture-jwt-signing-secret-64-characters-long-value");
  await instanceSettingsService(db).updateExperimental({enableBetaSkills:true,enableIsolatedWorkspaces:true});
  const original=getServerAdapter("codex_local"),heartbeat=heartbeatService(db);heartbeatForStale=heartbeat;let continued=0;
  let releaseContinuation!:()=>void;
  const continuationFence=new Promise<void>(resolve=>{releaseContinuation=resolve;});
  registerServerAdapter({...original,type:"codex_local",execute:async ctx=>{
    continued++;
    const recovered=ctx.context.recoveredWorkspaceFiles as Array<{operationId:string;sourceRunId:string;path:string}>;
    const copy=recovered?.find(item=>item.operationId===preserved.value&&item.sourceRunId===f.input.runId);
    expect(copy,"The public Retry must deliver the preserved source archive").toBeDefined();
    const cwd=String((ctx.context.paperclipWorkspace as {cwd?:string})?.cwd??"");
    expect(await readFile(path.join(cwd,copy!.path,"files/saved.txt"),"utf8")).toBe("retained synthetic output");
    if(ctx.executionTarget?.kind!=="remote"||ctx.executionTarget.transport!=="ssh")throw Error("Retry target not SSH");
    const runtime=await prepareRemoteManagedRuntime({spec:ctx.executionTarget.spec,runId:ctx.runId,adapterKey:"synthetic-recovered-role",workspaceLocalDir:cwd,assets:[]});
    try{
      expect((await runSshCommand(ctx.executionTarget.spec,`cat ${shellQuote(path.posix.join(runtime.workspaceRemoteDir,copy!.path,"files/saved.txt"))}`)).stdout).toBe("retained synthetic output");
      await continuationFence;
      await issueService(db).update(f.input.issueId,{status:"done",actorAgentId:f.agentId,actorRunId:ctx.runId});
    }finally{await runtime.restoreWorkspace();}
    return {exitCode:0,signal:null,timedOut:false,label:"Recovered archive verified by synthetic provider"};
  }});
  try{
    const retry=await requestTaskRetry({db,companyId:f.input.companyId,issueId:f.input.issueId,actorId:"operator",actorSource:"session",observedRunId:f.input.runId,idempotencyKey:randomUUID()});
    expect(retry.accepted).toBe(true);expect(retry.requestId).toBeTruthy();
    await expect(heartbeat.resumeTaskRetry(f.input.companyId,retry.requestId!)).rejects.toThrow("Company is not active");expect(continued).toBe(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,f.input.companyId))).toHaveLength(1);
    // The specialist is still blocked at admission resume. The canonical
    // Coordinator Retry must stay behind real unresolved dependencies.
    if(paused){await patchCompany("active");await settleLifecycle("ready");}
    else await db.update(companies).set({status:"active"}).where(eq(companies.id,f.input.companyId));
    await heartbeat.resumeTaskRetry(f.input.companyId,retry.requestId!);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,f.input.companyId))).toHaveLength(1);
    expect(continued).toBe(0);
    if(paused){
      releaseStale();await staleDelivery;
      const allWakeRows=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,f.input.companyId));
      expect(allWakeRows.filter(row=>row.requestedByActorId==="issue-blocker-stall")).toHaveLength(1);
      expect(allWakeRows.find(row=>row.id===wake.id)).toEqual(cancelled);
      const enqueue=vi.fn();await wakeWaitersOfStalledIssues(db,enqueue,{companyId:f.input.companyId});expect(enqueue).not.toHaveBeenCalled();
    }
    await issueService(db).update(child.id,{status:"done",actorUserId:"operator"});
    await db.update(issueRecoveryActions).set({status:"resolved",resolvedAt:new Date()}).where(eq(issueRecoveryActions.id,childAction.id));
    await db.update(companies).set({status:"active"}).where(eq(companies.id,f.input.companyId));
    if(order==="retry_first") {
      // This fixture has already recovered bytes and satisfied its dependency;
      // unlike the production incident it has a qualified supported workspace.
      const state=await readMaintenance(db);
      const maintenance=await startMaintenance(db,{actorId:"operator",requestId:randomUUID(),expectedGeneration:state.generation,operatorNote:"Synthetic supported continuation review"});
      expect((await reconcileMaintenance(db)).state).toBe("held");
      const [originalIntent]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,retry.requestId!));
      await heartbeat.resumeTaskRetry(f.input.companyId,retry.requestId!).catch(error=>{expect(String(error)).toMatch(/maintenance|drain|paused/i);});
      expect(continued).toBe(0);expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,f.input.companyId)))).toHaveLength(1);
      const [heldIntent]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,retry.requestId!));
      expect(heldIntent.id).toBe(originalIntent.id);expect(heldIntent.payload).toEqual(originalIntent.payload);
      const reviewed=await maintenanceContinuationReview(db,"review_all");
      await releaseMaintenance(db,{actorId:"operator",requestId:randomUUID(),generation:maintenance.generation,ownerId:maintenance.ownerId!,reviewFingerprint:reviewed.fingerprint});
    }
    const notify=async()=>{
      const result=await heartbeat.reconcileResolvedDependencyWakes({companyId:f.input.companyId,blockerIssueId:child.id});
      expect(result.checked).toBe(1);
      expect(result.enqueueFailed).toBe(0);
      const [intentReceipt]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,retry.requestId!));
      expect(intentReceipt).toMatchObject({reason:"task_retry",requestedByActorType:"user",requestedByActorId:"operator"});
      expect(intentReceipt.payload?.taskRetry).toMatchObject({sourceRunId:f.input.runId,generationId:retry.requestId});
      expect(result.healed+result.livePathSkipped+result.interactionSkipped+result.existingWakeSkipped).toBe(1);
      return result;
    };
    if(deliveryOrder==="notification_first")await notify();
    await heartbeat.resumeTaskRetry(f.input.companyId,retry.requestId!);
    if(deliveryOrder==="retry_first")await notify();
    await heartbeat.resumeExecutionWaitComments({companyId:f.input.companyId,requestId:retry.requestId!});
    releaseContinuation();
    await heartbeat.drainActiveRunExecutions();
    const allRuns=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,f.input.companyId));
    const successors=allRuns.filter(run=>run.id!==f.input.runId);expect(successors).toHaveLength(1);
    expect(successors[0].status,successors[0].error??undefined).toBe("succeeded");expect(continued).toBe(1);
    await heartbeat.resumeTaskRetry(f.input.companyId,retry.requestId!);
    await heartbeat.reconcileResolvedDependencyWakes({companyId:f.input.companyId,blockerIssueId:child.id});
    await heartbeat.drainActiveRunExecutions();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,f.input.companyId))).toHaveLength(2);
  }finally{releaseContinuation();if(paused)releaseStale();registerServerAdapter(original);await heartbeat.drainActiveRunExecutions();await lifecycle?.stop();}
},90000);

it.each([
  { role:"Researcher", action:"submit", target:"Coordinator" },
  { role:"Planner", action:"submit", target:"Coordinator" },
  { role:"Implementer", action:"submit", target:"Reviewer" },
  { role:"Reviewer", action:"approve", target:"Implementer" },
  { role:"Coordinator", action:"approve", target:"Researcher" },
  { role:"Reviewer", action:"changes", target:"Implementer" },
  { role:"Planner", action:"human", target:"Coordinator" },
  { role:"Coordinator", action:"next_human", target:"Researcher" },
  { role:"Implementer", action:"chain", target:"Reviewer" },
  { role:"Researcher", action:"cancel", target:"Coordinator" },
  { role:"Researcher", action:"provider_failed", target:"Coordinator" },
  { role:"Researcher", action:"doc_changed", target:"Coordinator" },
  { role:"Researcher", action:"unsafe_link", target:"Coordinator" },
  { role:"Researcher", action:"restart", target:"Coordinator" },
  { role:"Implementer", action:"drain", target:"Reviewer" },
  { role:"Researcher", action:"older_writer", target:"Coordinator" },
  { role:"Researcher", action:"db_disconnect", target:"Coordinator" },
  { role:"Researcher", action:"unsupported_workspace", target:"Coordinator" },
])("actual Codex adapter and agent-JWT HTTP $role $action returns real bytes before workflow assignment",async scenario=>{
  const companyId=randomUUID(),producerId=randomUUID(),reviewerId=randomUUID(),issueId=randomUUID(),environmentId=randomUUID();
  const deciding=["approve","changes","next_human"].includes(scenario.action), chain=["chain","drain"].includes(scenario.action);
  const controlled=["cancel","doc_changed","unsafe_link","restart","drain","older_writer","db_disconnect"].includes(scenario.action);
  const failed=["cancel","provider_failed","doc_changed","unsafe_link","older_writer"].includes(scenario.action);
  const controlFile=path.join(connection.remoteWorkspacePath,"synthetic-control-"+companyId);
  const requestedStatus=deciding ? scenario.action==="changes" ? "in_progress" : "done" : "in_review";
  const syntheticHome=path.join(root,'http-synthetic-codex-shared');await mkdir(syntheticHome,{recursive:true,mode:0o700});vi.stubEnv('CODEX_HOME',syntheticHome);
  const managedHome=path.join(root,'instances/default/companies',companyId,'codex-home');
  vi.stubEnv('PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS',JSON.stringify([path.join(root,'staging'),syntheticHome,managedHome]));
  await db.insert(companies).values({id:companyId,name:"Actual HTTP review handoff",issuePrefix:"H"+companyId.replaceAll("-",""),defaultResponsibleUserId:"operator",requireBoardApprovalForNewAgents:false});
  await db.insert(companyMemberships).values({companyId,principalType:"user",principalId:"operator",status:"active",membershipRole:"owner"});
  // Scope this regression to the changed handoff boundaries. Generic startup,
  // Retry admission and checkout retain their existing pools. The authenticated
  // PATCH route, exact source validator, real copy-back recorder and workflow
  // commit owner share ONE main connection, with the normal shared work signals.
  let runtimeDb=db, releaseHandoffPool=()=>{};
  let handoffPoolLifetime:Promise<void>|undefined;
  if(process.env.PAPERCLIP_TEST_HANDOFF_DB_POOL_MAX==="1"){
    let ready!:()=>void;const allocated=new Promise<void>(resolve=>ready=resolve);
    const release=new Promise<void>(resolve=>releaseHandoffPool=resolve);
    handoffPoolLifetime=withDedicatedDbConnection(db,async dedicated=>{runtimeDb=dedicated;ready();await release;});
    await allocated;
  }
  const storage=createStorageService(createLocalDiskStorageProvider(path.join(root,"http-handoff-objects")));
  const app=express();app.use(express.json());app.use(actorMiddleware(runtimeDb,{deploymentMode:"authenticated"}));
  const handoffRoutes=issueRoutes(runtimeDb,storage),ordinaryRoutes=runtimeDb===db?handoffRoutes:issueRoutes(db,storage);
  app.use("/api",(req,res,next)=>req.method==="POST"&&/\/issues\/[^/]+\/checkout$/.test(req.path)
    ?ordinaryRoutes(req,res,next):handoffRoutes(req,res,next));app.use(errorHandler);
  const server:Server=await new Promise(resolve=>{const v=app.listen(0,"0.0.0.0",()=>resolve(v));});
  const port=(server.address() as {port:number}).port;
  const executable=path.join(connection.remoteWorkspacePath,"synthetic-codex-"+companyId);
  const script=`#!/usr/bin/python3
import json,os,sys,time,urllib.request
if '--version' in sys.argv:
 print('codex-cli 0.159.0');sys.exit(0)
print(json.dumps({'type':'thread.started','thread_id':'synthetic-'+os.environ['PAPERCLIP_RUN_ID']}),flush=True)
print(json.dumps({'type':'turn.started'}),flush=True)
recipient=os.environ['PAPERCLIP_AGENT_ID']!='${producerId}'
with open('reviewed.txt' if recipient else 'returned.txt','w') as f:f.write('real adapter handoff bytes\\n')
base='http://192.0.2.1:${port}/api'
headers={'Authorization':'Bearer '+os.environ['PAPERCLIP_TEST_AGENT_JWT'],'X-Paperclip-Run-Id':os.environ['PAPERCLIP_RUN_ID']}
with urllib.request.urlopen(urllib.request.Request(base+'/issues/'+os.environ['PAPERCLIP_TASK_ID'],headers=headers),timeout=30) as response: before=json.load(response)
checkout=urllib.request.Request(base+'/issues/'+os.environ['PAPERCLIP_TASK_ID']+'/checkout',data=json.dumps({'agentId':os.environ['PAPERCLIP_AGENT_ID'],'expectedStatuses':[before['status']]}).encode(),method='POST',headers={**headers,'Content-Type':'application/json'})
with urllib.request.urlopen(checkout,timeout=30) as response: checked=json.load(response)
assert checked['executionRunId']==os.environ['PAPERCLIP_RUN_ID'] and checked['checkoutRunId']==os.environ['PAPERCLIP_RUN_ID']
with urllib.request.urlopen(urllib.request.Request(base+'/issues/'+os.environ['PAPERCLIP_TASK_ID'],headers=headers),timeout=30) as response: before=json.load(response)
body={'status':'done' if recipient else '${requestedStatus}','comment':'The exact saved evidence supports this configured workflow decision.'}
if recipient or ${deciding ? "True" : "False"}:
 body.update({'expectedExecutionStageId':before['executionState']['currentStageId'],'expectedDecisionStatusVersion':before['statusVersion'],'expectedDecisionLastDecisionId':before['executionState'].get('lastDecisionId'),'expectedPlanRevisionId':None})
body=json.dumps(body).encode()
req=urllib.request.Request(base+'/issues/'+os.environ['PAPERCLIP_TASK_ID'],data=body,method='PATCH',headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['PAPERCLIP_TEST_AGENT_JWT'],'X-Paperclip-Run-Id':os.environ['PAPERCLIP_RUN_ID']})
try:
 with urllib.request.urlopen(req,timeout=30) as response:
  assert response.status==202
  result=json.load(response)
 assert result['assigneeAgentId']==os.environ['PAPERCLIP_AGENT_ID']
 assert result['status']==before['status'] and result['executionRunId']==os.environ['PAPERCLIP_RUN_ID']
 # A lost reply must join the same intent, not duplicate comments or decisions.
 with urllib.request.urlopen(req,timeout=30) as response: replay=json.load(response)
 assert replay['pendingWorkflowHandoff']['id']==result['pendingWorkflowHandoff']['id']
except urllib.error.HTTPError as error:
 payload=json.loads(error.read().decode())
 if ${scenario.action==="unsupported_workspace" ? "True" : "False"}:
  assert error.code==422 and payload['details']['code']=='workflow_handoff_workspace_unsupported'
  print(json.dumps({'type':'item.completed','item':{'id':'blocked','type':'agent_message','text':'Workspace setup is blocked; no review handoff was performed.'}}),flush=True)
  print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1,'cached_input_tokens':0}}),flush=True);sys.exit(0)
 print(json.dumps(payload),file=sys.stderr,flush=True);raise
if not recipient and ${controlled ? "True" : "False"}:
 with open('${controlFile}.accepted','w') as accepted:accepted.write('The exact replay was acknowledged.')
 while not os.path.exists('${controlFile}'):time.sleep(0.05)
if not recipient and ${scenario.action==="provider_failed" ? "True" : "False"}:sys.exit(42)
print(json.dumps({'type':'item.completed','item':{'id':'msg','type':'agent_message','text':'Review handoff accepted; returning files.'}}),flush=True)
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1,'cached_input_tokens':0}}),flush=True)
`;
  await writeFile(executable,script,{mode:0o700});
  const secret=await secretService(db).create(companyId,{name:"synthetic-http-ssh",provider:"local_encrypted",value:connection.privateKey!});
  await secretService(db).createBinding({companyId,secretId:secret.id,targetType:"environment",targetId:environmentId,configPath:"privateKeySecretRef"});
  await db.insert(environments).values({id:environmentId,name:"HTTP workflow fixture "+environmentId,driver:"ssh",config:{...connection,privateKey:null,privateKeySecretRef:{type:"secret_ref",secretId:secret.id,version:"latest"}}});
  await db.insert(agents).values([{id:producerId,companyId,name:scenario.role,role:"general",status:"idle",adapterType:"codex_local",defaultEnvironmentId:environmentId,runtimeConfig:{heartbeat:{wakeOnDemand:true}},adapterConfig:{command:executable,engine:"cli",paperclipSkillSync:{desiredSkills:[]}},permissions:{}},{id:reviewerId,companyId,name:scenario.target,role:"pm",status:"idle",adapterType:"codex_local",defaultEnvironmentId:environmentId,runtimeConfig:{heartbeat:{wakeOnDemand:chain}},adapterConfig:{command:executable,engine:"cli",paperclipSkillSync:{desiredSkills:[]}},permissions:{}}]);
  const providerSecret=await secretService(db).create(companyId,{name:"synthetic-no-provider",provider:"local_encrypted",value:"sk-synthetic-not-sent-to-provider"});
  await secretService(db).createBinding({companyId,secretId:providerSecret.id,targetType:"agent",targetId:producerId,configPath:"env.OPENAI_API_KEY"});
  await db.update(agents).set({adapterConfig:{command:executable,engine:"cli",paperclipSkillSync:{desiredSkills:[]},env:{OPENAI_API_KEY:{type:"secret_ref",secretId:providerSecret.id,version:"latest"}}}}).where(eq(agents.id,producerId));
  if(chain){
    await secretService(db).createBinding({companyId,secretId:providerSecret.id,targetType:"agent",targetId:reviewerId,configPath:"env.OPENAI_API_KEY"});
    await db.update(agents).set({adapterConfig:{command:executable,engine:"cli",paperclipSkillSync:{desiredSkills:[]},env:{OPENAI_API_KEY:{type:"secret_ref",secretId:providerSecret.id,version:"latest"}}}}).where(eq(agents.id,reviewerId));
  }
  const {normalizeIssueExecutionPolicy,applyIssueExecutionPolicyTransition}=await import("../services/issue-execution-policy.js");
  const policy=normalizeIssueExecutionPolicy({mode:"normal",stages:[
    {type:scenario.action==="human"?"approval":"review",participants:[scenario.action==="human"?{type:"user",userId:"operator"}:{type:"agent",agentId:deciding?producerId:reviewerId}]},
    ...(scenario.action==="next_human"?[{type:"approval",participants:[{type:"user",userId:"operator"}]}]:[]),
  ]});
  const seedTask={status:"in_progress",assigneeAgentId:reviewerId,assigneeUserId:null,responsibleUserId:"operator",executionPolicy:policy,executionState:null};
  const initial=deciding ? applyIssueExecutionPolicyTransition({issue:seedTask,policy,previousPolicy:policy,requestedStatus:"in_review",requestedAssigneePatch:{},actor:{agentId:reviewerId},commentBody:"Submit the exact work to its configured reviewer."}).patch : {};
  await db.insert(issues).values({id:issueId,companyId,title:"Actual configured "+scenario.role+" "+scenario.action,status:deciding?"in_review":"todo",assigneeAgentId:producerId,responsibleUserId:"operator",executionPolicy:policy as unknown as Record<string,unknown>,executionState:initial.executionState as Record<string,unknown>|null});
  if(deciding){
    // A real reviewer inherits the producer's persisted native task workspace.
    // Do not replace that production precondition with an unbound fallback.
    const nativeCwd=await materializeIsolatedTaskDirectory({companyId,issueId});
    const [nativeWorkspace]=await db.insert(executionWorkspaces).values({companyId,sourceIssueId:issueId,name:"Submitted review workspace",mode:"isolated_workspace",strategyType:"project_primary",cwd:nativeCwd,providerType:"local_fs"}).returning();
    await executionWorkspaceService(db).bindTaskWorkspace(companyId,issueId,nativeWorkspace.id);
    await db.update(issues).set({executionWorkspacePreference:"reuse_existing",workspaceSelection:{version:1,source:"explicit",selection:{kind:"existing",workspaceId:nativeWorkspace.id}}}).where(eq(issues.id,issueId));
    await writeFile(path.join(nativeCwd,"submitted.txt"),"Exact prior producer bytes.");
  }
  if(scenario.action==="unsupported_workspace"){
    // Ordinary static policy is already approved in this synthetic profile;
    // its shared flat workspace is deliberately outside the native handoff contract.
    const cwd=path.join(root,"static-approved-shared",companyId,issueId);await mkdir(cwd,{recursive:true,mode:0o700});
    const [workspace]=await db.insert(executionWorkspaces).values({companyId,sourceIssueId:issueId,name:"Already approved static shared source",mode:"shared_workspace",strategyType:"project_primary",cwd,providerType:"local_fs"}).returning();
    await executionWorkspaceService(db).bindTaskWorkspace(companyId,issueId,workspace.id);
    await db.update(issues).set({executionWorkspacePreference:"reuse_existing",workspaceSelection:{version:1,source:"explicit",selection:{kind:"existing",workspaceId:workspace.id}}}).where(eq(issues.id,issueId));
    vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS",JSON.stringify([path.join(root,"staging"),syntheticHome,managedHome,cwd]));
    vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS",JSON.stringify([path.join(root,"legacy"),cwd]));
  }
  vi.stubEnv("PAPERCLIP_API_URL",`http://192.0.2.1:${port}/api`);vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET","synthetic-http-workflow-test-secret-not-a-live-credential");
  vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS","1");vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG","");
  vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS",JSON.stringify([{...connection,privateKey:undefined}]));
  await instanceSettingsService(db).updateExperimental({enableIsolatedWorkspaces:false});
  const {documentService}=await import("../services/documents.js");
  await documentService(db).upsertIssueDocument({issueId,key:"research",format:"markdown",body:"Existing exact research revision must remain unchanged.",baseRevisionId:null,createdByUserId:"operator"});
  const originalAdapter=getServerAdapter("codex_local");
  let sourceJwt:string|null=null;
  registerServerAdapter({...originalAdapter,execute:async ctx=>{
    if(ctx.agent.id===producerId)sourceJwt=ctx.authToken??null;
    const actual=()=>originalAdapter.execute({...ctx,
      ...(runtimeDb!==db?{onWorkspaceCopyback:(verify:Parameters<typeof recordTaskWorkflowReturn>[2])=>recordTaskWorkflowReturn(runtimeDb,{companyId,runId:ctx.runId},verify)}:{}),
      config:{...ctx.config,env:{...(ctx.config.env as Record<string,unknown>),PAPERCLIP_TEST_AGENT_JWT:ctx.authToken}}});
    if(runtimeDb===db)return actual();
    const [bound]=await runtimeDb.select({id:executionWorkspaces.id,cwd:executionWorkspaces.cwd}).from(issues)
      .innerJoin(executionWorkspaces,eq(issues.executionWorkspaceId,executionWorkspaces.id)).where(eq(issues.id,issueId));
    return withScopedTaskWorkspaceAuthority(runtimeDb,{companyId,agentId:ctx.agent.id,issueId,runId:ctx.runId,
      workspaceId:bound.id,workspaceCwd:bound.cwd!,target:ctx.executionTarget,signal:ctx.signal??new AbortController().signal},actual);
  }});
  const heartbeat=heartbeatService(db);
  const ownerErrors: unknown[] = [];
  let allowDispatch=true;
  const makeCoordinator=()=>createDeliveryWorkCoordinator({owner:runtimeDb,canRun:()=>allowDispatch,canReconcile:()=>true,onError:error=>ownerErrors.push(error)});
  let coordinator=makeCoordinator();
  let workflowOwner=registerTaskWorkflowHandoffWork(runtimeDb,coordinator);await workflowOwner.ready;
  const receiptOwner=chain?heartbeat.registerDeferredReceiptWork(coordinator,()=>true):null;await receiptOwner?.ready;
  let releaseBlockedRead=()=>{}, releaseOldWriter=()=>{};
  let oldWriter:Promise<unknown>|undefined, injectedCommit:Promise<{error?:unknown;value?:boolean}>|undefined;
  let hashSpy:{mockRestore():void}|undefined, lossDb:ReturnType<typeof createDb>|undefined;
  const chainDiagnostic=chain?setInterval(()=>{void Promise.all([
    db.select({id:heartbeatRuns.id,agentId:heartbeatRuns.agentId,status:heartbeatRuns.status,errorCode:heartbeatRuns.errorCode}).from(heartbeatRuns).where(eq(heartbeatRuns.companyId,companyId)),
    db.select({id:issueWorkflowHandoffs.id,state:issueWorkflowHandoffs.state,failure:issueWorkflowHandoffs.failureCode}).from(issueWorkflowHandoffs).where(eq(issueWorkflowHandoffs.companyId,companyId)),
    db.select({id:agentWakeupRequests.id,status:agentWakeupRequests.status,runId:agentWakeupRequests.runId,reason:agentWakeupRequests.reason}).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,companyId)),
  ]).then(([runs,intents,wakes])=>console.info("isolated workflow chain",JSON.stringify({runs,intents,wakes}))).catch(()=>{});},5000):null;
  try{
    let started:Awaited<ReturnType<typeof heartbeat.getRun>> | null;
    if(deciding || scenario.action==="unsupported_workspace"){
      started=await heartbeat.wakeup(producerId,{source:"assignment",triggerDetail:"system",reason:"execution_review_requested",payload:{issueId},contextSnapshot:{issueId},requestedByActorType:"user",requestedByActorId:"operator"});
    }else{
      const [prior]=await db.insert(heartbeatRuns).values({companyId,agentId:producerId,issueId,runtimeMode:"legacy",status:"failed",errorCode:"configuration_incomplete",contextSnapshot:{issueId},startedAt:new Date(Date.now()-2000),finishedAt:new Date(Date.now()-1000)}).returning();
      await db.update(issues).set({status:"blocked"}).where(eq(issues.id,issueId));
      const retry=await requestTaskRetry({db,companyId,issueId,actorId:"operator",actorSource:"session",observedRunId:prior.id,idempotencyKey:randomUUID()});
      await heartbeat.resumeTaskRetry(companyId,retry.requestId!);
      const [retryWake]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,retry.requestId!));
      started=await heartbeat.getRun(retryWake.runId!);
    }
    expect(started).not.toBeNull();
    if(controlled){
      await vi.waitFor(async()=>{
        const [intent]=await db.select().from(issueWorkflowHandoffs).where(eq(issueWorkflowHandoffs.sourceRunId,started!.id));expect(intent?.state).toBe("pending");
      },{timeout:15000});
      if(["restart","older_writer","db_disconnect"].includes(scenario.action)){workflowOwner.stop();await coordinator.stop();}
      if(scenario.action==="drain")allowDispatch=false;
      if(scenario.action==="doc_changed"){
        // Change the reviewed document only after both original acceptance and
        // its exact replay have actually returned to the provider.
        await vi.waitFor(async()=>expect(await readFile(controlFile+".accepted","utf8")).toBe("The exact replay was acknowledged."),{timeout:15000});
        const {documentService}=await import("../services/documents.js");
        await documentService(db).upsertIssueDocument({issueId,key:"plan",format:"markdown",body:"A material plan changed after this review request.",baseRevisionId:null,createdByUserId:"operator"});
        const replay=await request(app).patch(`/api/issues/${issueId}`).set("Authorization","Bearer "+sourceJwt).set("X-Paperclip-Run-Id",started!.id)
          .send({status:"in_review",comment:"The exact saved evidence supports this configured workflow decision."});
        expect(replay.status,replay.text).toBe(409);
      }
      if(scenario.action==="unsafe_link"){
        const [bound]=await db.select({cwd:executionWorkspaces.cwd}).from(issues).innerJoin(executionWorkspaces,eq(issues.executionWorkspaceId,executionWorkspaces.id)).where(eq(issues.id,issueId));
        const synthetic=path.join(root,"synthetic-keys","synthetic-workflow-"+companyId);await writeFile(synthetic,"synthetic-protected-key-must-never-enter-the-snapshot",{mode:0o600});
        await link(synthetic,path.join(bound.cwd!,"unsafe-controller-alias"));
      }
      if(scenario.action==="cancel"){
        const operatorApp=express();operatorApp.use(express.json());operatorApp.use((req,_res,next)=>{req.actor={type:"board",userId:"operator",source:"session",companyIds:[companyId],memberships:[{companyId,membershipRole:"owner",status:"active"}]};next();});
        operatorApp.use("/api",agentRoutes(runtimeDb));operatorApp.use(errorHandler);
        const stopped=await request(operatorApp).post(`/api/heartbeat-runs/${started!.id}/cancel`).send({});
        expect(stopped.status,stopped.text).toBe(200);
      }
      await writeFile(controlFile,"The isolated test may return.");
    }
    await heartbeat.drainActiveRunExecutions();
    if(scenario.action==="older_writer"){
      const [saved]=await db.select().from(issueWorkflowHandoffs).where(eq(issueWorkflowHandoffs.sourceRunId,started!.id));
      expect(saved.state).toBe("pending");expect(saved.returnProof).not.toBeNull();
      const [workspace]=await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id,saved.workspaceId));
      const [alias]=await db.insert(executionWorkspaces).values({companyId,sourceIssueId:issueId,name:"Earlier record for the exact same physical directory",mode:"isolated_workspace",strategyType:"project_primary",providerType:"local_fs",cwd:workspace.cwd}).returning();
      const [realLease]=await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId,started!.id));
      const cleanHistory=Array.from({length:105},()=>({id:randomUUID(),companyId,agentId:producerId,issueId,runtimeMode:"legacy",status:"succeeded",
        contextSnapshot:{issueId,executionWorkspaceId:alias.id},createdAt:new Date(started!.createdAt.getTime()-10000),startedAt:new Date(started!.createdAt.getTime()-9000),finishedAt:new Date(started!.createdAt.getTime()-8000)}));
      await db.insert(heartbeatRuns).values(cleanHistory);
      await db.insert(environmentLeases).values(cleanHistory.map(history=>{
        const id=randomUUID(),scope={...(realLease.metadata!.remoteExecutionScope as Record<string,unknown>),runId:history.id,leaseId:id,generation:randomUUID()};
        return {id,companyId,environmentId,issueId,heartbeatRunId:history.id,executionWorkspaceId:alias.id,provider:"ssh",providerLeaseId:realLease.providerLeaseId,
          status:"released",releasedAt:new Date(),cleanupStatus:"success",leasePolicy:"ephemeral",metadata:{remoteExecutionScopeRequired:true,remoteExecutionScope:scope,
            remoteExecutionTermination:{schema:"paperclip.remote-termination.v1",companyId,runId:history.id,leaseId:id,provider:"ssh",providerLeaseId:realLease.providerLeaseId,state:"stopped",resourceScope:scope}}};
      }));
      const [old]=await db.insert(heartbeatRuns).values({companyId,agentId:producerId,issueId,runtimeMode:"legacy",status:"succeeded",
        contextSnapshot:{issueId,executionWorkspaceId:alias.id},createdAt:new Date(started!.createdAt.getTime()-5000),startedAt:new Date(started!.createdAt.getTime()-4000),finishedAt:new Date(started!.createdAt.getTime()-3000)}).returning();
      let enter!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve);
      const permit=new Promise<void>(resolve=>releaseOldWriter=resolve);
      oldWriter=withNativeWorkspaceFinalizationOwnership({db,companyId,runId:old.id,liveLegacyPublication:true},async owner=>{
        await owner.assertHeld();enter();await permit;
        await withDirectoryMergeLock(workspace.cwd!,async()=>{await owner.assertHeld();await writeFile(path.join(workspace.cwd!,"older-publisher.txt"),"Genuine older callback bytes must not be silently merged into this decision.");});
      });
      await entered;coordinator=makeCoordinator();workflowOwner=registerTaskWorkflowHandoffWork(runtimeDb,coordinator);await workflowOwner.ready;
      await vi.waitFor(async()=>{
        const [held]=await db.select().from(issueWorkflowHandoffs).where(eq(issueWorkflowHandoffs.id,saved.id));
        expect(held).toMatchObject({state:"pending",failureCode:"workflow_handoff_competing_writer"});
      },{timeout:15000});
      const [beforeOldJoins]=await db.select().from(issues).where(eq(issues.id,issueId));expect(beforeOldJoins.assigneeAgentId).toBe(producerId);
      releaseOldWriter();await oldWriter;
    }
    if(scenario.action==="db_disconnect"){
      const [saved]=await db.select().from(issueWorkflowHandoffs).where(eq(issueWorkflowHandoffs.sourceRunId,started!.id));
      const [workspace]=await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id,saved.workspaceId));
      const materializer=await import("@paperclipai/adapter-utils/controller-source-materialization");
      const actual=materializer.createControllerSourceSnapshot;
      let enter!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve);
      const permit=new Promise<void>(resolve=>releaseBlockedRead=resolve);
      hashSpy=vi.spyOn(materializer,"createControllerSourceSnapshot").mockImplementation(async(...args)=>{enter();await permit;return actual(...args);});
      const applicationName="workflow-disconnect-"+companyId;
      lossDb=createDb(database.connectionString,{maxConnections:1,applicationName});
      let settled=false;
      injectedCommit=commitTaskWorkflowHandoff(lossDb,companyId,started!.id).then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});
      await entered;
      const sessions=await db.execute<{pid:number}>(sql`select pid from pg_stat_activity where datname=current_database() and application_name=${applicationName} and state='idle in transaction'`);
      expect(sessions).toHaveLength(1);
      await db.execute(sql`select pg_terminate_backend(${sessions[0].pid})`);
      await vi.waitFor(async()=>{expect(await db.execute(sql`select pid from pg_stat_activity where pid=${sessions[0].pid}`)).toHaveLength(0);});
      expect(settled).toBe(false);
      expect(await tryWithDirectoryMergeLock(workspace.cwd!,async()=>true)).toBeUndefined();
      releaseBlockedRead();const result=await injectedCommit;expect(result.error).toBeDefined();
      hashSpy.mockRestore();hashSpy=undefined;
      expect(await tryWithDirectoryMergeLock(workspace.cwd!,async()=>true)).toBe(true);
      const [unchanged]=await db.select().from(issueWorkflowHandoffs).where(eq(issueWorkflowHandoffs.id,saved.id));expect(unchanged.state).toBe("pending");
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,reviewerId))).toHaveLength(0);
      await lossDb.$client.end({timeout:5});lossDb=undefined;
      coordinator=makeCoordinator();workflowOwner=registerTaskWorkflowHandoffWork(runtimeDb,coordinator);await workflowOwner.ready;
    }
    if(scenario.action==="restart"){
      const [saved]=await db.select().from(issueWorkflowHandoffs).where(eq(issueWorkflowHandoffs.sourceRunId,started!.id));
      expect(saved.state).toBe("pending");expect(saved.returnProof).not.toBeNull();
      const [owned]=await db.select().from(issues).where(eq(issues.id,issueId));
      expect(owned).toMatchObject({executionRunId:started!.id,checkoutRunId:started!.id});
      const guards=issueService(db);
      expect(await guards.clearExecutionRunIfTerminal(issueId)).toBe(false);
      expect(await guards.clearCheckoutRunIfTerminal(issueId)).toBe(false);
      expect((await heartbeat.sweepStaleIssueLocks({companyId,issueId})).cleared).toBe(0);
      const [stillOwned]=await db.select().from(issues).where(eq(issues.id,issueId));
      expect(stillOwned).toMatchObject({executionRunId:started!.id,checkoutRunId:started!.id});
      coordinator=makeCoordinator();workflowOwner=registerTaskWorkflowHandoffWork(runtimeDb,coordinator);await workflowOwner.ready;
    }
    const finished=await heartbeat.getRun(started!.id);
    const [diagnostic]=await db.select({stderr:heartbeatRuns.stderrExcerpt,stdout:heartbeatRuns.stdoutExcerpt}).from(heartbeatRuns).where(eq(heartbeatRuns.id,started!.id));
    expect(finished?.status,JSON.stringify(diagnostic)).toBe(scenario.action==="cancel"?"cancelled":["provider_failed","unsafe_link"].includes(scenario.action)?"failed":"succeeded");
    if(scenario.action==="unsupported_workspace"){
      expect(await db.select().from(issueWorkflowHandoffs).where(eq(issueWorkflowHandoffs.sourceRunId,started!.id))).toHaveLength(0);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,reviewerId))).toHaveLength(0);
      const [blocked]=await db.select().from(issues).where(eq(issues.id,issueId));expect(blocked).toMatchObject({status:"in_progress",assigneeAgentId:producerId});
      const [workspace]=await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id,blocked.executionWorkspaceId!));
      expect(await readFile(path.join(workspace.cwd!,"returned.txt"),"utf8")).toBe("real adapter handoff bytes\n");
      const leases=await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId,started!.id));expect(hasRemoteTerminationReceipt(leases[0])).toBe(true);
      return;
    }
    if(failed){
      await vi.waitFor(async()=>{
        const [intent]=await db.select().from(issueWorkflowHandoffs).where(eq(issueWorkflowHandoffs.sourceRunId,started!.id));expect(intent?.state).toBe("held");
      },{timeout:15000});
      const [unchanged]=await db.select().from(issues).where(eq(issues.id,issueId));
      expect(unchanged.assigneeAgentId).toBe(producerId);expect(unchanged.status).toBe("in_progress");
      const blocker=await getExecutionBlocker(db,companyId,issueId);expect(blocker?.canRetry).toBe(false);
      const targetWakes=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,reviewerId));expect(targetWakes).toHaveLength(0);
      const leases=await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId,started!.id));expect(leases).toHaveLength(1);expect(hasRemoteTerminationReceipt(leases[0])).toBe(true);
      await vi.waitFor(async()=>{
        const [source]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,started!.id));
        expect(source.resultJson?.workspaceRestoreRecovery).toMatchObject({source:{runId:source.id,leaseId:leases[0].id,providerLeaseId:leases[0].providerLeaseId}});
        // A held handoff intent is not yet the canonical retained-source hold.
        // Await its actual descriptor/blocker publication before certifying it.
        expect((await getExecutionBlocker(db,companyId,issueId))?.workspaceRepairRequired).toBe(true);
      },{timeout:15000});
      if(scenario.action==="cancel"){
        const denied=await request(app).patch(`/api/issues/${issueId}`).set("Authorization","Bearer "+sourceJwt)
          .set("X-Paperclip-Run-Id",started!.id).send({status:"in_review",comment:"A canceled token cannot reacquire handoff authority."});
        expect([401,403,409]).toContain(denied.status);
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,reviewerId))).toHaveLength(0);
      }
      if(scenario.action==="unsafe_link")expect(await readFile(path.join(root,"synthetic-keys","synthetic-workflow-"+companyId),"utf8")).toBe("synthetic-protected-key-must-never-enter-the-snapshot");
      return;
    }
    const [bound]=await db.select({cwd:executionWorkspaces.cwd}).from(issues).innerJoin(executionWorkspaces,eq(issues.executionWorkspaceId,executionWorkspaces.id)).where(eq(issues.id,issueId));
    const cwd=bound.cwd!;
    expect(await readFile(path.join(cwd,"returned.txt"),"utf8")).toBe("real adapter handoff bytes\n");
    await vi.waitFor(async()=>{
      const [intent]=await db.select().from(issueWorkflowHandoffs).where(eq(issueWorkflowHandoffs.sourceRunId,started!.id));
      const revisions=await db.execute(sql`select l.key,d.latest_revision_id from issue_documents l join documents d on d.id=l.document_id where l.company_id=${companyId} and l.issue_id=${issueId}`);
      expect({state:intent?.state},JSON.stringify({failure:intent?.failureCode,errors:ownerErrors.map(String),savedDocuments:intent?.intent.documentRevisions,currentDocuments:revisions})).toMatchObject({state:"committed"});
    },{timeout:15000});
    if(scenario.action==="drain"){
      const beforeOpen=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,companyId));
      expect(beforeOpen.filter(run=>run.agentId===reviewerId)).toHaveLength(0);
      const [waiting]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,reviewerId));
      expect(waiting).toMatchObject({status:"deferred_issue_execution",runId:null});
      allowDispatch=true;receiptOwner!.wake();
    }
    const [task]=await db.select().from(issues).where(eq(issues.id,issueId));
    const expectedStatus=scenario.action==="approve"?"done":scenario.action==="changes"?"in_progress":"in_review";
    if(!chain) expect(task).toMatchObject({status:expectedStatus,assigneeAgentId:["human","next_human"].includes(scenario.action)?null:scenario.action==="approve"?producerId:reviewerId,executionRunId:null,checkoutRunId:null});
    if(["human","next_human"].includes(scenario.action)) expect(task.assigneeUserId).toBe("operator");
    const leases=await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId,started!.id));
    expect(leases).toHaveLength(1);expect(hasRemoteTerminationReceipt(leases[0])).toBe(true);
    const wakes=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,reviewerId));
    expect(wakes).toHaveLength(["approve","human","next_human"].includes(scenario.action)?0:1);
    if(chain){
      await vi.waitFor(async()=>{
        const [completed]=await db.select().from(issues).where(eq(issues.id,issueId));
        expect(completed.status,JSON.stringify(ownerErrors.map(String))).toBe("done");
      },{timeout:30000});
      await heartbeat.drainActiveRunExecutions();
      const all=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,companyId));
      const executed=all.filter(run=>run.status==="succeeded");expect(executed).toHaveLength(2);
      expect(new Set(executed.map(run=>run.agentId))).toEqual(new Set([producerId,reviewerId]));
      const [finalTask]=await db.select().from(issues).where(eq(issues.id,issueId));
      const [finalWorkspace]=await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id,finalTask.executionWorkspaceId!));
      expect(await readFile(path.join(finalWorkspace.cwd!,"reviewed.txt"),"utf8")).toBe("real adapter handoff bytes\n");
      const intents=await db.select().from(issueWorkflowHandoffs).where(eq(issueWorkflowHandoffs.companyId,companyId));
      expect(intents).toHaveLength(2);expect(intents.every(intent=>intent.state==="committed")).toBe(true);
      await heartbeat.resumeExecutionWaitComments({companyId});await heartbeat.drainActiveRunExecutions();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,companyId))).toHaveLength(all.length);
    }
    expect(await getExecutionBlocker(db,companyId,issueId)).toBeNull();
  }finally{releaseBlockedRead();releaseOldWriter();await injectedCommit;await oldWriter;hashSpy?.mockRestore();await lossDb?.$client.end({timeout:5});if(controlled)await writeFile(controlFile,"Release isolated fixture on cleanup.");if(chainDiagnostic)clearInterval(chainDiagnostic);workflowOwner.stop();await receiptOwner?.stop();await coordinator.stop();registerServerAdapter(originalAdapter);await heartbeat.drainActiveRunExecutions();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));releaseHandoffPool();await handoffPoolLifetime;}
},180000);

});
