import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, agentWakeupRequests } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { hasRemoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import type { SshRunScope } from "@paperclipai/adapter-utils/ssh-run-scope";

const transport=vi.hoisted(()=>({stop:vi.fn(),prepare:vi.fn(),probe:vi.fn(),workspace:vi.fn()}));
vi.mock("@paperclipai/adapter-utils/ssh",async(importOriginal)=>({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>(),
  stopSshRunScope:transport.stop,prepareSshRunScope:transport.prepare,probeSshRunScope:transport.probe,ensureSshWorkspaceReady:transport.workspace,
}));
const support=await getEmbeddedPostgresTestSupport();
(support.supported?describe:describe.skip)("automatic exact-scope SSH lease stop",()=>{
  let database:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db:ReturnType<typeof createDb>;
  beforeAll(async()=>{database=await startEmbeddedPostgresTestDatabase("ssh-auto-stop-");db=createDb(database.connectionString);},90000);
  afterAll(async()=>{await database?.cleanup();});
  beforeEach(()=>{
    vi.clearAllMocks();
    transport.stop.mockImplementation(async(_config,scope)=>({owner:scope,phase:"stopped",waitProof:"ECHILD_WALL",admissionClosed:true}));
  });
  async function seed(){
    const companyId=randomUUID(),agentId=randomUUID(),runId=randomUUID(),environmentId=randomUUID(),leaseId=randomUUID();
    await db.insert(companies).values({id:companyId,name:"SSH fixture",issuePrefix:`S${companyId.replaceAll("-","")}`});
    await db.insert(agents).values({id:agentId,companyId,name:"Held worker",role:"engineer",adapterType:"codex_local",
      status:"paused",lifecycleState:"pausing",lifecycleHolds:["manual"],pauseReason:"manual"});
    await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,runtimeMode:"legacy",status:"cancelled",finishedAt:new Date(),
      resultJson:{executionCancellation:{state:"acknowledged"}}});
    await db.insert(environments).values({id:environmentId,name:`Isolated SSH ${environmentId}`,driver:"ssh",
      config:{host:"192.0.2.124",port:22,username:"worker",remoteWorkspacePath:"/workspace"}}).returning();
    const scope:SshRunScope={schema:"paperclip.ssh-run-scope.v1",companyId,runId,leaseId,generation:randomUUID(),bootId:randomUUID()};
    await db.insert(environmentLeases).values({id:leaseId,companyId,environmentId,heartbeatRunId:runId,provider:"ssh",
      providerLeaseId:"ssh://worker@192.0.2.124:22/workspace",status:"active",leasePolicy:"ephemeral",metadata:{
        host:"192.0.2.124",port:22,username:"worker",remoteWorkspacePath:"/workspace",remoteCwd:"/workspace",remoteExecutionScopeRequired:true,remoteExecutionScope:scope,
      }}).returning();
    const environment=(await environmentService(db).getById(environmentId))!;
    const lease=(await environmentService(db).getLeaseById(leaseId))!;
    return{companyId,agentId,runId,environment,lease,scope};
  }
  async function release(f:Awaited<ReturnType<typeof seed>>){
    return environmentRuntimeService(db).getDriver("ssh")!.releaseRunLease({environment:f.environment,lease:f.lease,status:"released",cancelActiveWork:true});
  }
  async function acquire(f:Awaited<ReturnType<typeof seed>>){
    await db.delete(environmentLeases).where(eq(environmentLeases.id,f.lease.id));
    await db.update(heartbeatRuns).set({status:"running",finishedAt:null,resultJson:null}).where(eq(heartbeatRuns.id,f.runId));
    transport.probe.mockResolvedValue({bootId:f.scope.bootId,remoteCwd:"/workspace"});
    transport.workspace.mockResolvedValue({remoteCwd:"/workspace"});
    return environmentRuntimeService(db).getDriver("ssh")!.acquireRunLease({companyId:f.companyId,environment:f.environment,
      issueId:null,agentId:f.agentId,heartbeatRunId:f.runId,executionWorkspaceId:null,executionWorkspaceMode:null,executionWorkspaceSettings:null,adapterType:"codex_local"});
  }
  it("persists exact ownership before remote startup and carries it into native and legacy targets",async()=>{
    const f=await seed();
    transport.prepare.mockImplementationOnce(async(_config,scope)=>{
      const [stored]=await db.select().from(environmentLeases).where(eq(environmentLeases.id,scope.leaseId));
      expect(stored.metadata?.remoteExecutionScope).toEqual(scope);
      expect(scope).toMatchObject({companyId:f.companyId,runId:f.runId,bootId:f.scope.bootId});
    });
    const lease=await acquire(f);
    expect(transport.prepare).toHaveBeenCalledOnce();
    expect(transport.workspace.mock.calls[0][0].runScope).toEqual(lease.metadata?.remoteExecutionScope);
    const target=await resolveEnvironmentExecutionTarget({db,companyId:f.companyId,adapterType:"codex_local",environment:f.environment,
      leaseId:lease.id,leaseMetadata:lease.metadata});
    expect(target).toMatchObject({kind:"remote",transport:"ssh",spec:{runScope:lease.metadata?.remoteExecutionScope}});
    const stoppedLease=await environmentRuntimeService(db).getDriver("ssh")!.releaseRunLease({environment:f.environment,lease,status:"released"});
    expect(hasRemoteTerminationReceipt(stoppedLease!)).toBe(true);
  });
  it("settles a cancellation racing startup without admitting workspace commands or creating another scope",async()=>{
    const f=await seed();
    transport.prepare.mockImplementationOnce(async(_config,scope)=>{
      await db.update(environmentLeases).set({status:"pending_cleanup",cleanupStatus:"failed",releasedAt:new Date()}).where(eq(environmentLeases.id,scope.leaseId));
    });
    await expect(acquire(f)).rejects.toThrow("ssh_run_scope_admission_closed");
    expect(transport.prepare).toHaveBeenCalledOnce();expect(transport.workspace).not.toHaveBeenCalled();
    const [lease]=await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId,f.runId));
    expect(hasRemoteTerminationReceipt(lease)).toBe(true);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,f.companyId))).toEqual([]);
  });
  it("rejects cancellation committed while the prerequisite probe was blocked, before lease insertion",async()=>{
    const f=await seed();let entered!:()=>void,finish!:(value:unknown)=>void;
    const probing=new Promise<void>(resolve=>{entered=resolve;});
    const probe=new Promise(resolve=>{finish=resolve;});
    // acquire() installs its normal fixture response, then this one-shot wins.
    transport.probe.mockImplementationOnce(()=>{entered();return probe;});
    const pending=acquire(f);await probing;
    await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.runId));
    finish({bootId:f.scope.bootId,remoteCwd:"/workspace"});
    await expect(pending).rejects.toThrow("ssh_run_scope_admission_closed");
    expect(transport.prepare).not.toHaveBeenCalled();expect(transport.workspace).not.toHaveBeenCalled();
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId,f.runId))).toEqual([]);
  });
  it("refuses to attach an old-scope acknowledgement after scope authority changes",async()=>{
    const f=await seed(),changed={...f.scope,generation:randomUUID()};
    transport.stop.mockImplementationOnce(async()=>{
      await db.update(environmentLeases).set({metadata:{...f.lease.metadata,remoteExecutionScope:changed}}).where(eq(environmentLeases.id,f.lease.id));
      return{owner:f.scope,phase:"stopped",waitProof:"ECHILD_WALL",admissionClosed:true};
    });
    expect(await release(f)).toBeNull();
    const lease=(await environmentService(db).getLeaseById(f.lease.id))!;
    expect(lease.metadata?.remoteExecutionScope).toEqual(changed);
    expect(hasRemoteTerminationReceipt(lease)).toBe(false);
  });
  it.each([false,true])("preserves successful proof across concurrent Stop success/failure (failure first=%s)",async(failureFirst)=>{
    const f=await seed();let success!:()=>void,fail!:()=>void;
    const successful=new Promise<void>(resolve=>{success=resolve;});
    const failed=new Promise<void>(resolve=>{fail=resolve;});
    transport.stop.mockImplementationOnce(async()=>{await successful;return{owner:f.scope,phase:"stopped",waitProof:"ECHILD_WALL",admissionClosed:true};})
      .mockImplementationOnce(async()=>{await failed;throw new Error("lost response");});
    const successCall=release(f),failedCall=release(f);
    // Both calls have the same old snapshot; settle in each possible order.
    if(failureFirst){fail();await failedCall;success();await successCall;}
    else{success();await successCall;fail();await failedCall;}
    const lease=(await environmentService(db).getLeaseById(f.lease.id))!;
    expect(lease).toMatchObject({status:"released",cleanupStatus:"success"});
    expect(hasRemoteTerminationReceipt(lease)).toBe(true);
    expect(await agentExecutionsHaveStopped(db,[f.agentId])).toBe(true);
  });
  it("preserves immutable ownership and existing host proof through generic metadata edits",async()=>{
    const f=await seed();await release(f);
    const lease=(await environmentService(db).getLeaseById(f.lease.id))!;
    const updated=await environmentService(db).updateLeaseMetadata(lease.id,{...lease.metadata,
      remoteExecutionScope:{...f.scope,generation:randomUUID()},remoteExecutionScopeRequired:false});
    expect(updated?.metadata?.remoteExecutionScope).toEqual(f.scope);
    expect(updated?.metadata?.remoteExecutionScopeRequired).toBe(true);
    expect(hasRemoteTerminationReceipt(updated!)).toBe(true);
    expect(updated?.metadata?.remoteExecutionTermination).toEqual(lease.metadata?.remoteExecutionTermination);
  });
  it("never downgrades required-scope dispatch to unscoped SSH",async()=>{
    const f=await seed(),metadata={...f.lease.metadata};delete metadata.remoteExecutionScope;
    await expect(resolveEnvironmentExecutionTarget({db,companyId:f.companyId,adapterType:"codex_local",environment:f.environment,
      leaseId:f.lease.id,leaseMetadata:metadata})).rejects.toThrow("ssh_run_scope_unverified");
  });
  it("turns a verified remote Stop into a canonical receipt, releasing the lifecycle barrier without a wake",async()=>{
    const f=await seed();const before=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));
    expect(await agentExecutionsHaveStopped(db,[f.agentId])).toBe(false);
    const lease=await release(f);
    expect(transport.stop).toHaveBeenCalledOnce();
    expect(transport.stop.mock.calls[0][1]).toEqual(f.scope);
    expect(lease).toMatchObject({status:"released",cleanupStatus:"success"});
    expect(hasRemoteTerminationReceipt(lease!)).toBe(true);
    expect(await agentExecutionsHaveStopped(db,[f.agentId])).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId))).toEqual(before);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,f.companyId))).toEqual([]);
  });
  it.each(["lost","foreign","malformed","numeric","missing"])("keeps %s stop evidence pending instead of clearing the barrier",async(kind)=>{
    const f=await seed();
    if(kind==="lost")transport.stop.mockRejectedValueOnce(new Error("transport disconnected"));
    else if(kind==="missing"){
      f.lease.metadata={...f.lease.metadata};delete f.lease.metadata.remoteExecutionScope;
      await db.update(environmentLeases).set({metadata:f.lease.metadata}).where(eq(environmentLeases.id,f.lease.id));
    }
    else transport.stop.mockResolvedValueOnce(kind==="foreign"?{owner:{...f.scope,generation:randomUUID()},phase:"stopped",waitProof:"ECHILD_WALL",admissionClosed:true}:
      kind==="numeric"?{owner:f.scope,phase:"stopped",waitProof:"ECHILD_WALL",admissionClosed:1}:{error:"ssh_run_scope_stop_pending"});
    const lease=await release(f);
    expect(lease).toMatchObject({status:"pending_cleanup",cleanupStatus:"failed"});
    expect(hasRemoteTerminationReceipt(lease!)).toBe(false);
    expect(await agentExecutionsHaveStopped(db,[f.agentId])).toBe(false);
  });
  it("retains legacy bookkeeping without inventing termination proof for an unscoped cancelled run",async()=>{
    const f=await seed();f.lease.metadata={...f.lease.metadata};
    delete f.lease.metadata.remoteExecutionScope;delete f.lease.metadata.remoteExecutionScopeRequired;
    await db.update(environmentLeases).set({metadata:f.lease.metadata}).where(eq(environmentLeases.id,f.lease.id));
    const lease=await release(f);
    expect(lease).toMatchObject({status:"released",cleanupStatus:null});
    expect(transport.stop).not.toHaveBeenCalled();expect(hasRemoteTerminationReceipt(lease!)).toBe(false);
    expect(await agentExecutionsHaveStopped(db,[f.agentId])).toBe(false);
  });
  it.each(["host","run","company"])("rejects changed %s before contacting a remote target",async(kind)=>{
    const f=await seed();
    if(kind==="host")f.environment.config={...f.environment.config,host:"192.0.2.99"};
    else f.lease.metadata={...f.lease.metadata,remoteExecutionScope:{...f.scope,[kind==="run"?"runId":"companyId"]:randomUUID()}};
    await db.update(environmentLeases).set({metadata:f.lease.metadata}).where(eq(environmentLeases.id,f.lease.id));
    const lease=await release(f);
    expect(transport.stop).not.toHaveBeenCalled();
    expect(lease).toMatchObject({status:"pending_cleanup",cleanupStatus:"failed"});
    expect(hasRemoteTerminationReceipt(lease!)).toBe(false);
  });
});
