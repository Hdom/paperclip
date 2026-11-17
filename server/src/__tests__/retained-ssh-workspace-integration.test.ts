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
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, workspaceOperations } from "@paperclipai/db";
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

it.each(["Coordinator","Researcher","Planner","Implementer","Reviewer"])("fresh %s heartbeat prepares linked saved skills, returns status before copyback and stops SSH",async role=>{
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
  const nativeCwd=await materializeIsolatedTaskDirectory({companyId,issueId});
  const [nativeWorkspace]=await db.insert(executionWorkspaces).values({companyId,sourceIssueId:issueId,name:"Explicit native task directory",mode:"isolated_workspace",strategyType:"project_primary",cwd:nativeCwd,providerType:"local_fs"}).returning();
  await executionWorkspaceService(db).bindTaskWorkspace(companyId,issueId,nativeWorkspace.id);
  await db.update(issues).set({executionWorkspacePreference:"reuse_existing",workspaceSelection:{version:1,source:"explicit",selection:{kind:"existing",workspaceId:nativeWorkspace.id}}}).where(eq(issues.id,issueId));
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
    const started=await heartbeat.invoke(agentId,"on_demand",{issueId,wakeReason:"issue_assigned"},"manual");
    const diagnostic=started?[]:await db.select({status:agentWakeupRequests.status,reason:agentWakeupRequests.reason,error:agentWakeupRequests.error}).from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,agentId));
    expect(started,JSON.stringify(diagnostic)).not.toBeNull();
    let finished=await heartbeat.getRun(started!.id);
    for(let i=0;i<600&&finished&&["queued","running"].includes(finished.status);i++){await new Promise(resolve=>setTimeout(resolve,100));finished=await heartbeat.getRun(started!.id);}
    expect(finished?.status,finished?.error??undefined).toBe("succeeded");await heartbeat.drainActiveRunExecutions();
    expect(providerCount).toBe(1);expect(await readFile(path.join(localCwd,"returned.txt"),"utf8")).toBe(role+" returned work");
    const leases=await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId,started!.id));
    expect(leases).toHaveLength(1);expect(hasRemoteTerminationReceipt(leases[0])).toBe(true);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,companyId))).map(run=>run.id)).toEqual([started!.id]);
  }finally{registerServerAdapter(original);await heartbeat.drainActiveRunExecutions();}
},90000);

it("preserves immutable output before exact audited wake retirement and genuine recovery completion",async()=>{
  const f=await seed(), spec={...connection,remoteCwd:connection.remoteWorkspacePath!,runScope:f.scope};
  await prepareSshRunScope(connection,f.scope);
  await runSshCommand(spec,`mkdir -p ${shellQuote(f.source.remoteDir)} && chmod 700 ${shellQuote(f.source.remoteDir)} && printf 'retained synthetic output' > ${shellQuote(f.source.remoteDir+'/saved.txt')}`);
  await stopSshRunScope(spec,f.scope);
  await expect(runSshCommand(spec,"true")).rejects.toMatchObject({code:125});
  const [child]=await db.insert(issues).values({companyId:f.input.companyId,title:"Stalled child",status:"blocked",parentId:f.input.issueId,assigneeAgentId:f.agentId}).returning();
  const [childAction]=await db.insert(issueRecoveryActions).values({companyId:f.input.companyId,sourceIssueId:child.id,kind:"run_recovery",status:"escalated",ownerType:"board",cause:"execution_recovery_budget_exhausted",fingerprint:randomUUID(),nextAction:"Retry child"}).returning();
  const [wake]=await db.insert(agentWakeupRequests).values({companyId:f.input.companyId,agentId:f.agentId,source:"automation",requestedByActorType:"system",requestedByActorId:"issue-blocker-stall",status:"deferred_issue_execution",
    payload:{issueId:f.input.issueId,stalledIssueId:child.id,recoveryAction:{id:childAction.id},_paperclipWakeContext:{issueId:f.input.issueId,wakeReason:"issue_blocker_stalled",blockerStall:{stalledIssueId:child.id,recoveryAction:{id:childAction.id}}}}}).returning();
  const disposition={...f.input,sourceActionId:f.input.actionId,wakeId:wake.id,stalledIssueId:child.id,stalledActionId:childAction.id,actorId:"operator"};
  expect((await getExecutionBlocker(db,f.input.companyId,f.input.issueId))?.workspaceRepairRequired).toBe(true);
  await expect(retireDeferredBlockerStallWake(db,disposition)).rejects.toThrow(/immutable snapshot/);
  await expect(assertNoPendingDeferredBlockerStall(db,f.input.companyId,f.input.issueId)).rejects.toThrow();
  const storage=storageModule.getStorageService(),put=storage.putFile.bind(storage);
  const lostReply=vi.spyOn(storage,"putFile").mockImplementationOnce(async input=>{await put(input);throw Error("synthetic lost archive upload reply");});
  try{
    await expect(withNativeWorkspaceFinalizationOwnership({db,companyId:f.input.companyId,runId:f.input.runId,retainedRepairActionId:f.input.actionId},
      owner=>preserveRetainedSshWorkspace({...f.input,db,assertHeld:owner.assertHeld}))).rejects.toThrow("synthetic lost archive upload reply");
    await expect(retireDeferredBlockerStallWake(db,disposition)).rejects.toThrow(/immutable snapshot/);
  }finally{lostReply.mockRestore();}
  const preserved=await withNativeWorkspaceFinalizationOwnership({db,companyId:f.input.companyId,runId:f.input.runId,retainedRepairActionId:f.input.actionId},
    owner=>preserveRetainedSshWorkspace({...f.input,db,assertHeld:owner.assertHeld}));
  expect(preserved.acquired).toBe(true);
  if(!preserved.acquired)throw Error("Source ownership not acquired");
  expect(await retainedSshPreservationReceipt(db,{...f.input,operationIds:[preserved.value]})).toBe(preserved.value);
  // Claimed notifications and an active successor must never be retired.
  await db.update(agentWakeupRequests).set({status:"claimed"}).where(eq(agentWakeupRequests.id,wake.id));
  await expect(retireDeferredBlockerStallWake(db,disposition)).rejects.toThrow(/pending incident/);
  await db.update(agentWakeupRequests).set({status:"deferred_issue_execution"}).where(eq(agentWakeupRequests.id,wake.id));
  const [successor]=await db.insert(heartbeatRuns).values({companyId:f.input.companyId,agentId:f.agentId,issueId:f.input.issueId,status:"queued",runtimeMode:"legacy",contextSnapshot:{issueId:f.input.issueId}}).returning();
  try{await expect(retireDeferredBlockerStallWake(db,disposition)).rejects.toThrow();}
  finally{await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id,successor.id));}
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
  expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id)))[0]).toMatchObject({status:"deferred_issue_execution",runId:null});
  expect((await getExecutionBlocker(db,f.input.companyId,f.input.issueId))?.workspaceRepairRequired).toBe(true);
  await expect(retireDeferredBlockerStallWake(db,disposition)).resolves.toMatchObject({alreadyRetired:false,dispatchCreated:false});
  await expect(retireDeferredBlockerStallWake(db,disposition)).resolves.toMatchObject({alreadyRetired:true,dispatchCreated:false});
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
},90000);
});
