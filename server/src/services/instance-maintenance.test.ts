import { assertMaintenanceRuntimeCompatibility } from "./maintenance-runtime-compatibility.js";
import { openMaintenanceProviderChannel } from "./maintenance-provider-channel.js";
import type { CommandManagedDuplexChannel } from "@paperclipai/adapter-utils/command-managed-runtime";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues, issueRecoveryActions, environmentLeases,
  instanceMaintenance, instanceMaintenanceOperations, agentWakeupRequests, environments } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { readMaintenance, startMaintenance, reconcileMaintenance, maintenanceClosed, withMaintenanceOperation,
  releaseMaintenance, assertMaintenanceAdmission, assertMaintenanceRecovery, revokeMaintenanceRecovery,
  assertMaintenanceProviderAdmission, type MaintenanceRecoveryAuthority } from "./instance-maintenance.js";
import { adoptHistoricalWorkspaceRecoveries } from "./workspace-recovery-backfill.js";
import { reconcileRetainedWorkspaces } from "./workspace-recovery.js";
import { registerWorkspaceRecoveryWork } from "./workspace-recovery-work.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { maintenanceContinuationReview } from "./maintenance-continuation-review.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import express, { type Request } from "express";
import request from "supertest";
import { instanceMaintenanceRoutes } from "../routes/instance-maintenance.js";
import { errorHandler } from "../middleware/error-handler.js";

describe("persistent instance maintenance (real isolated PostgreSQL)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("maintenance-test-"); db = createDb(temporary.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  beforeEach(async () => {
    await db.execute(sql`truncate instance_maintenance_operations, instance_maintenance_events`);
    await db.transaction(async tx => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql`truncate companies cascade`); });
    await db.update(instanceMaintenance).set({ generation: 0, state: "released", ownerId: null, operatorNote: null, actorId: null, requestId: null, continuationPolicy: "review_all" });
  });
  const start = () => startMaintenance(db, { actorId: "operator", requestId: randomUUID(), expectedGeneration: 0, operatorNote: "Private operator note" });
  const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

  it("persists closure across a new database client, without TTL or implicit reconstruction", async () => {
    await start(); await reconcileMaintenance(db);
    const restarted = createDb(temporary.connectionString);
    try { expect(await readMaintenance(restarted)).toMatchObject({ generation: 1, state: "held", operatorNote: "Private operator note" });
      expect(await withMaintenanceOperation(restarted, "execution", async () => { throw Error("must not enter"); })).toEqual({ admitted: false });
    } finally { await restarted.$client.end(); }
  });

  it("enforces board/instance-admin HTTP authority and excludes private global notes from task/non-admin responses", async () => {
    const app=(actor: Request["actor"])=>{const app=express();app.use(express.json());app.use((req,_res,next)=>{req.actor=actor;next();});app.use(instanceMaintenanceRoutes(db));app.use(errorHandler);return app;};
    const adminApp=app({type:"board",source:"local_implicit",userId:"operator",isInstanceAdmin:true} as Request["actor"]);
    const nonAdmin=app({type:"board",source:"board_key",userId:"member",isInstanceAdmin:false,companyIds:[]} as Request["actor"]);
    const agent=app({type:"agent",source:"agent_jwt",agentId:randomUUID(),companyId:randomUUID()} as Request["actor"]);
    const input={requestId:randomUUID(),expectedGeneration:0,operatorNote:"PRIVATE OTHER COMPANY INCIDENT"};
    expect((await request(nonAdmin).post('/instance/maintenance').send(input)).status).toBe(403);
    expect((await request(agent).post('/instance/maintenance').send(input)).status).toBe(403);
    expect((await request(adminApp).post('/instance/maintenance').send(input)).status).toBe(202);
    expect((await request(adminApp).post('/instance/maintenance').send(input)).status).toBe(202);
    expect((await request(adminApp).post('/instance/maintenance').send({...input,operatorNote:"changed"})).status).toBe(409);
    const projected=(await request(nonAdmin).get('/instance/maintenance')).body;
    expect(projected).toMatchObject({state:"held",canManage:false});expect(projected.admin).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain(input.operatorNote);
    const task=(await request(adminApp).get('/instance/maintenance?view=task')).body;
    expect(task.admin).toBeUndefined();expect(JSON.stringify(task)).not.toContain(input.operatorNote);
    expect((await request(adminApp).get('/instance/maintenance')).body.admin.operatorNote).toBe(input.operatorNote);
  });

  it("serializes acquisition against genuine callback settlement, including a rejected callback", async () => {
    const entered=barrier(), finish=barrier();
    const work=withMaintenanceOperation(db, "execution", async () => { entered.resolve(); await finish.promise; throw Error("synthetic provider refusal"); });
    const checked=expect(work).rejects.toThrow("synthetic provider refusal");
    await entered.promise; await start();
    expect((await reconcileMaintenance(db)).state).toBe("acquiring");
    expect((await db.select().from(instanceMaintenanceOperations))[0].state).toBe("active");
    finish.resolve(); await checked;
    expect((await reconcileMaintenance(db)).state).toBe("held");
    expect((await db.select().from(instanceMaintenanceOperations))[0].state).toBe("settled");
  });

  it("makes a shared admission transaction and acquisition mutually ordered", async () => {
    const entered=barrier(), finish=barrier();
    const claim=db.transaction(async tx => { await assertMaintenanceAdmission(tx as unknown as typeof db); entered.resolve(); await finish.promise; });
    await entered.promise;
    let acquisitionAnswered=false;const acquiring=start().then(value => { acquisitionAnswered=true;return value; });
    // A DB round trip lets the other client submit its blocking FOR UPDATE.
    await db.execute(sql`select 1`); expect(acquisitionAnswered).toBe(false);
    finish.resolve();await claim;await acquiring;
    await expect(db.transaction(tx => assertMaintenanceAdmission(tx as unknown as typeof db))).rejects.toThrow("Maintenance temporarily");
  });

  async function retainedSource() {
    const [company]=await db.insert(companies).values({ name:"Synthetic maintenance",issuePrefix:"MT" }).returning();
    const [agent]=await db.insert(agents).values({ companyId:company.id,name:"Researcher",adapterType:"process",status:"idle" }).returning();
    const [issue]=await db.insert(issues).values({ companyId:company.id,title:"Retained source",status:"in_review",assigneeAgentId:agent.id }).returning();
    const runId=randomUUID(),leaseId=randomUUID(),generation=randomUUID();
    const descriptor={schema:"paperclip.workspace-restore-recovery.v1",leaseIds:[leaseId],source:{provider:"ssh",runId,leaseId,generation}};
    await db.insert(heartbeatRuns).values({id:runId,companyId:company.id,agentId:agent.id,issueId:issue.id,status:"cancelled",runtimeMode:"legacy",
      invocationSource:"on_demand",finishedAt:new Date(),resultJson:{workspaceRestoreFailure:"restore_failed",workspaceRestoreRecovery:descriptor}});
    const [action]=await db.insert(issueRecoveryActions).values({companyId:company.id,sourceIssueId:issue.id,kind:"active_run_watchdog",cause:"legacy_execution_requires_reconciliation",fingerprint:randomUUID(),ownerType:"board",status:"resolved",nextAction:"Preserve original source",evidence:{runId,workspaceRestoreRecovery:descriptor,automaticRecovery:{policy:"preserve_without_replay_v1",replay:"blocked"}}}).returning();
    await db.insert(environmentLeases).values({id:leaseId,companyId:company.id,issueId:issue.id,heartbeatRunId:runId,status:"expired",leasePolicy:"retain_on_failure",cleanupStatus:"success",metadata:{remoteExecutionScope:{generation}}});
    const source={companyId:company.id,issueId:issue.id,runId,actionId:action.id};
    return {source,descriptor,leaseId,generation,agent};
  }

  it("leaves the board/resolved/missing-system-state source and saved wake unchanged on startup sweep and later notifications", async () => {
    const f=await retainedSource();
    const [wake]=await db.insert(agentWakeupRequests).values({companyId:f.source.companyId,agentId:f.agent.id,source:"automation",status:"deferred_issue_execution",payload:{issueId:f.source.issueId,executionWait:{reason:"execution_recovery",recoveryActionId:f.source.actionId}}}).returning();
    const before=(await db.select().from(issueRecoveryActions))[0].evidence;
    await start();await reconcileMaintenance(db);
    await expect(adoptHistoricalWorkspaceRecoveries(db)).rejects.toThrow("Maintenance temporarily");
    const errors:unknown[]=[];const coordinator=createDeliveryWorkCoordinator({owner:db,canRun:()=>true,onError:e=>errors.push(e)});
    const runtime=environmentRuntimeService(db);
    const worker=registerWorkspaceRecoveryWork(db,coordinator,runtime,async()=>{throw Error("must not promote");});
    try { await worker.ready;
      await db.transaction(tx=>notifyDeliveryWork(tx,DELIVERY_QUEUES.workspaceRecovery));
      await coordinator.stop();
      expect(await reconcileRetainedWorkspaces(db,runtime,async()=>{throw Error("must not promote");})).toEqual([]);
      expect((await db.select().from(issueRecoveryActions))[0].evidence).toEqual(before);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id)))[0]).toEqual(wake);
      expect(errors).toEqual([]);
    } finally { await worker.stop();await coordinator.stop(); }
  });

  it("fails closed when state is missing or schema version is unknown", async () => {
    await db.update(instanceMaintenance).set({protocolVersion:99});
    expect(await maintenanceClosed(db)).toBe(true);
    await expect(withMaintenanceOperation(db,"execution",async()=>true)).rejects.toThrow("cannot be verified");
    await db.update(instanceMaintenance).set({protocolVersion:1});
    await db.delete(instanceMaintenance);
    expect(await maintenanceClosed(db)).toBe(true);
    await expect(withMaintenanceOperation(db,"execution",async()=>true)).rejects.toThrow("cannot be verified");
    await db.insert(instanceMaintenance).values({singletonKey:"default"});
  });

  it("does not mistake a terminal finalization owner or released remote lease without physical proof for quiescence", async () => {
    const f=await retainedSource();
    await db.update(heartbeatRuns).set({runnerProfileJson:{nativeWorkspaceFinalizationOwner:"synthetic-owner"}}).where(eq(heartbeatRuns.id,f.source.runId));
    await start();expect((await reconcileMaintenance(db)).state).toBe("acquiring");
    await db.update(heartbeatRuns).set({runnerProfileJson:{}}).where(eq(heartbeatRuns.id,f.source.runId));
    await db.update(environmentLeases).set({provider:"ssh",providerLeaseId:"ssh://synthetic-only",releasedAt:new Date()}).where(eq(environmentLeases.id,f.leaseId));
    expect((await reconcileMaintenance(db)).state).toBe("acquiring");
  });

  it("parks positively never-dispatched scheduled work without consuming or cancelling it", async () => {
    const [company]=await db.insert(companies).values({name:"Parked",issuePrefix:"PK"}).returning();
    const [agent]=await db.insert(agents).values({companyId:company.id,name:"Parked agent",adapterType:"process",status:"idle"}).returning();
    const [run]=await db.insert(heartbeatRuns).values({companyId:company.id,agentId:agent.id,status:"scheduled_retry",invocationSource:"automation",scheduledRetryAt:new Date()}).returning();
    await start();expect((await reconcileMaintenance(db)).state).toBe("held");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id)))[0]).toEqual(run);
  });

  it("joins the exact pre-admitted provider boundary while refusing other runs and inherited closed authority", async () => {
    const f=await retainedSource(),runId=f.source.runId,entered=barrier(),finish=barrier();
    await db.update(heartbeatRuns).set({status:"running"}).where(eq(heartbeatRuns.id,runId));
    let detached!:()=>Promise<void>;
    const work=withMaintenanceOperation(db,"execution",async()=>{
      detached=()=>assertMaintenanceProviderAdmission(db,runId);
      entered.resolve();await finish.promise;
      await db.transaction(tx=>assertMaintenanceProviderAdmission(tx as unknown as typeof db,runId));
      await expect(db.transaction(tx=>assertMaintenanceProviderAdmission(tx as unknown as typeof db,randomUUID()))).rejects.toThrow("Maintenance temporarily");
      await db.update(heartbeatRuns).set({status:"cancelled"}).where(eq(heartbeatRuns.id,runId));
    },undefined,runId);
    await entered.promise;await start();expect((await reconcileMaintenance(db)).state).toBe("acquiring");
    finish.resolve();await work;expect((await reconcileMaintenance(db)).state).toBe("held");
    await expect(detached()).rejects.toThrow("Maintenance temporarily");
  });

  it("rejects stale release and never turns saved work into an implicit continuation", async () => {
    const row=await start();await reconcileMaintenance(db);
    await expect(releaseMaintenance(db,{actorId:"operator",requestId:randomUUID(),generation:0,ownerId:row.ownerId!})).rejects.toThrow("changed");
    const f=await retainedSource();
    await db.insert(agentWakeupRequests).values({companyId:f.source.companyId,agentId:f.agent.id,source:"automation",status:"deferred_issue_execution",payload:{issueId:f.source.issueId}});
    await expect(releaseMaintenance(db,{actorId:"operator",requestId:randomUUID(),generation:1,ownerId:row.ownerId!})).rejects.toThrow("reviewed continuation fingerprint");
    expect((await readMaintenance(db)).state).toBe("held");
  });

  it("binds exact recovery to persisted source/generation, revokes without pretending callback settlement", async () => {
    const f=await retainedSource();const held=await start();await reconcileMaintenance(db);
    const authority:MaintenanceRecoveryAuthority={...f.source,leaseId:f.leaseId,leaseGeneration:f.generation,descriptorFingerprint:nativeSha256(f.descriptor),maintenanceGeneration:1,maintenanceOwnerId:held.ownerId!,operation:"preserve-and-recover-exact-source",requestId:randomUUID()};
    await expect(withMaintenanceOperation(db,"source_recovery",async()=>true,{...authority,leaseGeneration:randomUUID()})).rejects.toThrow("source changed");
    const entered=barrier(),finish=barrier();
    const work=withMaintenanceOperation(db,"source_recovery",async()=>{await assertMaintenanceRecovery(db,f.source);entered.resolve();await finish.promise;await assertMaintenanceRecovery(db,f.source);},authority);
    const checked=expect(work).rejects.toThrow("revoked");await entered.promise;
    const [op]=await db.select().from(instanceMaintenanceOperations).where(and(eq(instanceMaintenanceOperations.kind,"source_recovery"),eq(instanceMaintenanceOperations.state,"active")));
    await revokeMaintenanceRecovery(db,{generation:1,ownerId:held.ownerId!,operationId:op.id,actorId:"operator",requestId:randomUUID()});
    expect((await db.select().from(instanceMaintenanceOperations).where(eq(instanceMaintenanceOperations.id,op.id)))[0].state).toBe("active");
    finish.resolve();await checked;
    expect((await db.select().from(instanceMaintenanceOperations).where(eq(instanceMaintenanceOperations.id,op.id)))[0].state).toBe("settled");
  });
  it("binds reviewed release to full wake authority and preserves its original identity", async () => {
    const f=await retainedSource();
    const [wake]=await db.insert(agentWakeupRequests).values({companyId:f.source.companyId,agentId:f.agent.id,source:"automation",status:"deferred_issue_execution",payload:{issueId:f.source.issueId}}).returning();
    const held=await start();await reconcileMaintenance(db);
    const first=await maintenanceContinuationReview(db,"review_all");
    await db.update(agentWakeupRequests).set({requestedByActorType:"user",requestedByActorId:"other-operator"}).where(eq(agentWakeupRequests.id,wake.id));
    await expect(releaseMaintenance(db,{actorId:"operator",requestId:randomUUID(),generation:1,ownerId:held.ownerId!,reviewFingerprint:first.fingerprint})).rejects.toThrow("reviewed continuation fingerprint");
    const reviewed=await maintenanceContinuationReview(db,"review_all");
    expect(reviewed.fingerprint).not.toBe(first.fingerprint);
    const before=await db.select().from(agentWakeupRequests);
    await releaseMaintenance(db,{actorId:"operator",requestId:randomUUID(),generation:1,ownerId:held.ownerId!,reviewFingerprint:reviewed.fingerprint});
    expect((await readMaintenance(db)).state).toBe("released");
    expect(await db.select().from(agentWakeupRequests)).toEqual(before);
  });

  it("never releases a protected readiness decision merely because all intents were reviewed",async()=>{
    const held=await startMaintenance(db,{actorId:"operator",requestId:randomUUID(),expectedGeneration:0,operatorNote:"Unsupported future workspace",continuationPolicy:"requires_readiness_decision"});
    await reconcileMaintenance(db);
    const reviewed=await maintenanceContinuationReview(db,"requires_readiness_decision");
    await expect(releaseMaintenance(db,{actorId:"operator",requestId:randomUUID(),generation:1,ownerId:held.ownerId!,reviewFingerprint:reviewed.fingerprint})).rejects.toThrow("readiness decision");
    expect((await readMaintenance(db)).state).toBe("held");
  });

  it.each(["insert","update","delete"] as const)("serializes saved wake %s against the singleton release lock", async operation=>{
    const f=await retainedSource();
    const values={companyId:f.source.companyId,agentId:f.agent.id,source:"automation" as const,status:"deferred_issue_execution",payload:{issueId:f.source.issueId}};
    const [wake]=await db.insert(agentWakeupRequests).values(values).returning();
    const locked=barrier(),finish=barrier();
    const holder=db.transaction(async tx=>{await tx.select().from(instanceMaintenance).for("update");locked.resolve();await finish.promise;});
    await locked.promise;
    let answered=false,writerPid=0;
    const mutation=db.transaction(async tx=>{
      writerPid=Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
      if(operation==="insert")await tx.insert(agentWakeupRequests).values(values);
      else if(operation==="update")await tx.update(agentWakeupRequests).set({reason:"changed intent"}).where(eq(agentWakeupRequests.id,wake.id));
      else await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id));
      answered=true;
    });
    try {
      await vi.waitFor(async()=>{expect(writerPid).toBeGreaterThan(0);const [activity]=await db.execute(sql`select wait_event_type from pg_stat_activity where pid=${writerPid}`);expect(activity.wait_event_type).toBe("Lock");});
      expect(answered).toBe(false);
    } finally {finish.resolve();await holder;await mutation;}
    expect(answered).toBe(true);
  });
  async function channelFixture() {
    const f=await retainedSource();
    const [environment]=await db.insert(environments).values({name:"Synthetic channel only "+randomUUID(),driver:"process",config:{}}).returning();
    await db.update(environmentLeases).set({environmentId:environment.id,heartbeatRunId:null,status:"active",releasedAt:null,metadata:{}}).where(eq(environmentLeases.id,f.leaseId));
    type Exit=Parameters<Parameters<CommandManagedDuplexChannel["onExit"]>[0]>[0];
    let listener:((value:Exit)=>void)|undefined;let writes=0,closes=0,stops=0;
    const raw:CommandManagedDuplexChannel={write(){writes++;},onData(){},onExit(cb){listener=cb;},stop(){stops++;},async close(){closes++;}};
    const [lease]=await db.select().from(environmentLeases).where(eq(environmentLeases.id,f.leaseId));
    return {f,raw,input:{lease,environment},
      emit:(value:Exit)=>listener!(value),counts:()=>({writes,closes,stops})};
  }
  it("holds acquisition across returned duplex channel, late numeric exit and joined close",async()=>{
    const c=await channelFixture();const channel=await openMaintenanceProviderChannel(db,c.input,async()=>c.raw);
    await start();expect((await reconcileMaintenance(db)).state).toBe("acquiring");
    const closing=expect(channel.close()).rejects.toThrow("unconfirmed");await closing;
    expect((await db.select().from(instanceMaintenanceOperations).where(eq(instanceMaintenanceOperations.kind,"provider_channel")))[0].state).toBe("active");
    c.emit({exitCode:0});await vi.waitFor(async()=>expect((await db.select().from(instanceMaintenanceOperations).where(eq(instanceMaintenanceOperations.kind,"provider_channel")))[0].state).toBe("settled"));
    await db.update(environmentLeases).set({status:"expired"}).where(eq(environmentLeases.id,c.f.leaseId));
    expect((await reconcileMaintenance(db)).state).toBe("held");expect(c.counts().closes).toBe(1);
  });
  it("retains duplex obligation on transport uncertainty and lost open reply",async()=>{
    const c=await channelFixture();const channel=await openMaintenanceProviderChannel(db,c.input,async()=>c.raw);
    c.emit({exitCode:null,transportClosed:true});
    await expect(channel.close()).rejects.toThrow("unconfirmed");
    await expect(openMaintenanceProviderChannel(db,c.input,async()=>{throw Error("lost channel open reply");})).rejects.toThrow("lost channel open reply");
    expect((await db.select().from(instanceMaintenanceOperations).where(eq(instanceMaintenanceOperations.state,"active")))).toHaveLength(2);
  });
  it("refuses duplex input after closure acquisition while leaving physical Stop and Close available",async()=>{
    const c=await channelFixture();const channel=await openMaintenanceProviderChannel(db,c.input,async()=>c.raw);
    await start();channel.write(new Uint8Array([1,2]));
    channel.stop();c.emit({exitCode:143});await channel.close();
    expect(c.counts().writes).toBe(0);expect(c.counts().stops).toBeGreaterThanOrEqual(1);
  });
  it("permits valid expiry renewal but refuses changed provider authority and latches queued input",async()=>{
    const c=await channelFixture();const channel=await openMaintenanceProviderChannel(db,c.input,async()=>c.raw);
    await db.update(environmentLeases).set({expiresAt:new Date(Date.now()+120_000)}).where(eq(environmentLeases.id,c.f.leaseId));
    channel.write(new Uint8Array([1]));await vi.waitFor(()=>expect(c.counts().writes).toBe(1));
    await db.update(environmentLeases).set({providerLeaseId:"replacement-handle"}).where(eq(environmentLeases.id,c.f.leaseId));
    channel.write(new Uint8Array([2]));channel.write(new Uint8Array([3]));
    await vi.waitFor(()=>expect(c.counts().stops).toBe(1));
    expect(c.counts().writes).toBe(1);expect(()=>channel.write(new Uint8Array([4]))).toThrow("input is closed");
    c.emit({exitCode:143});await channel.close();
  });
  it("rejects stale factory snapshot and expired/released lease before opening any channel",async()=>{
    const c=await channelFixture();let opened=false;const factory=async()=>{opened=true;return c.raw;};
    for(const change of [{expiresAt:new Date(Date.now()-1000)},{expiresAt:null,releasedAt:new Date()},
      {releasedAt:null,providerLeaseId:"changed"}]){
      await db.update(environmentLeases).set(change).where(eq(environmentLeases.id,c.f.leaseId));
      await expect(openMaintenanceProviderChannel(db,c.input,factory)).rejects.toThrow("ownership changed");
    }
    expect(opened).toBe(false);
  });
  it("refuses a release racing a task-first writer without skipping the locked task or deadlocking",async()=>{
    const f=await retainedSource();
    await db.insert(agentWakeupRequests).values({companyId:f.source.companyId,agentId:f.agent.id,source:"automation",status:"deferred_issue_execution",payload:{issueId:f.source.issueId}});
    const held=await start();await reconcileMaintenance(db);const review=await maintenanceContinuationReview(db,"review_all");
    const locked=barrier(),finish=barrier();
    const writer=db.transaction(async tx=>{await tx.update(issues).set({title:"Concurrent task revision"}).where(eq(issues.id,f.source.issueId));locked.resolve();await finish.promise;});
    await locked.promise;
    try {await expect(releaseMaintenance(db,{actorId:"operator",requestId:randomUUID(),generation:held.generation,ownerId:held.ownerId!,reviewFingerprint:review.fingerprint})).rejects.toThrow("Saved work is changing");}
    finally {finish.resolve();await writer;}
    expect((await readMaintenance(db)).state).toBe("held");
  });
  it("refuses pre-fence or mismatched rollback runtimes against the persisted maintenance database",async()=>{
    await start();await reconcileMaintenance(db);
    for(const manifest of [undefined,{}, {schema:"paperclip.runtime-capabilities.v1",instanceMaintenance:0},
      {schema:"paperclip.runtime-capabilities.v1",instanceMaintenance:99}])
      await expect(assertMaintenanceRuntimeCompatibility(db,manifest)).rejects.toThrow("cannot honor persisted maintenance");
    await expect(assertMaintenanceRuntimeCompatibility(db,{schema:"paperclip.runtime-capabilities.v1",instanceMaintenance:1})).resolves.toBeUndefined();
    expect((await readMaintenance(db)).state).toBe("held");
  });
  it("prevents a second physical source operation even with a fresh UUID after a lost reply",async()=>{
    const f=await retainedSource(),held=await start();await reconcileMaintenance(db);let physical=0;
    const authority:MaintenanceRecoveryAuthority={...f.source,leaseId:f.leaseId,leaseGeneration:f.generation,descriptorFingerprint:nativeSha256(f.descriptor),maintenanceGeneration:held.generation,maintenanceOwnerId:held.ownerId!,operation:"preserve-and-recover-exact-source",requestId:randomUUID()};
    await withMaintenanceOperation(db,"source_recovery",async()=>{physical++;},authority);
    for(const requestId of [authority.requestId,randomUUID()])
      await expect(withMaintenanceOperation(db,"source_recovery",async()=>{physical++;},{...authority,requestId})).rejects.toThrow("original recovery request");
    expect(physical).toBe(1);expect((await db.select().from(instanceMaintenanceOperations))).toHaveLength(1);
  });
});
