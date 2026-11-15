import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, createDb, environments, heartbeatRuns, agentWakeupRequests } from "@paperclipai/db";
import { buildSshEnvLabFixtureConfig, getSshEnvLabSupport, startSshEnvLabFixture, stopSshEnvLabFixture, type SshEnvLabFixtureState } from "@paperclipai/adapter-utils/ssh";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import { heartbeatService } from "../services/heartbeat.js";
import { secretService } from "../services/secrets.js";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { hasRemoteTerminationReceipt } from "../services/remote-execution-termination.js";

it("assembles real heartbeat Stop, SSH ownership and durable cleanup without provider work or successor runs",async()=>{
  expect((await getEmbeddedPostgresTestSupport()).supported).toBe(true);
  const support=await getSshEnvLabSupport();expect(support.supported,support.reason ?? undefined).toBe(true);
  const root=await mkdtemp(path.join(os.tmpdir(),"heartbeat-ssh-stop-"));
  const database=await startEmbeddedPostgresTestDatabase("heartbeat-ssh-stop-");
  const db=createDb(database.connectionString),runtime=environmentRuntimeService(db),heartbeat=heartbeatService(db);
  let fixture:SshEnvLabFixtureState|undefined,invocation:Promise<unknown>|undefined,runId:string|undefined,leaseId:string|undefined;
  try{
    fixture=await startSshEnvLabFixture({statePath:path.join(root,"fixture/state.json")});
    const config=await buildSshEnvLabFixtureConfig(fixture);
    const companyId=randomUUID(),agentId=randomUUID(),environmentId=randomUUID();runId=randomUUID();
    await db.insert(companies).values({id:companyId,name:"Isolated cancellation fixture",issuePrefix:`Q${companyId.replaceAll("-","")}`,requireBoardApprovalForNewAgents:false});
    await db.insert(agents).values({id:agentId,companyId,name:"No-model fixture",role:"engineer",status:"running",adapterType:"codex_local",runtimeConfig:{heartbeat:{wakeOnDemand:false}}});
    const secret=await secretService(db).create(companyId,{name:"Isolated SSH fixture credential",provider:"local_encrypted",value:config.privateKey!});
    await secretService(db).createBinding({companyId,secretId:secret.id,targetType:"environment",targetId:environmentId,configPath:"privateKeySecretRef"});
    await db.insert(environments).values({id:environmentId,name:`Isolated SSH ${environmentId}`,driver:"ssh",config:{...config,privateKey:null,
      privateKeySecretRef:{type:"secret_ref",secretId:secret.id,version:"latest"}}});
    await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,status:"running",runtimeMode:"legacy",startedAt:new Date()});
    const environment=(await environmentService(db).getById(environmentId))!;
    const acquired=await runtime.acquireRunLease({companyId,environment,heartbeatRunId:runId,issueId:null,persistedExecutionWorkspace:null});leaseId=acquired.lease.id;
    const target=await resolveEnvironmentExecutionTarget({db,companyId,adapterType:"codex_local",environment,leaseId,lease:acquired.lease,leaseMetadata:acquired.lease.metadata});
    expect(target?.kind).toBe("remote");
    if(target?.kind!=="remote"||target.transport!=="ssh")throw Error("Fixture target not SSH");
    const marker=path.join(root,"owned.pid"),program=path.join(root,"no-model.py");
    await writeFile(program,`import os,pathlib,time\npathlib.Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))\ntime.sleep(60)`);
    // The real process owner/finalizer path, with a deterministic sleeping
    // executable. It never runs an agent model, connector tool or external API.
    invocation=runChildProcess(runId,"python3",[program],{cwd:root,env:{},timeoutSec:0,graceSec:1,onLog:async()=>{},remoteExecution:target.spec,
      onSpawn:async meta=>{await db.update(heartbeatRuns).set({processPid:meta.pid,processGroupId:meta.processGroupId,processStartedAt:new Date(meta.startedAt)}).where(eq(heartbeatRuns.id,runId!));}})
      .finally(async()=>{await runtime.releaseRunLeases(runId!,"released",undefined,undefined,true);});
    const deadline=Date.now()+10000;let pid=0;
    while(Date.now()<deadline){try{pid=Number(await readFile(marker,"utf8"));if(pid>0)break;}catch{}await new Promise(r=>setTimeout(r,20));}
    expect(pid).toBeGreaterThan(0);
    await db.update(agents).set({status:"paused",lifecycleState:"pausing",lifecycleHolds:["manual"],pauseReason:"manual"}).where(eq(agents.id,agentId));
    await heartbeat.cancelRun(runId,"Isolated fixture Stop");await invocation;
    const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));
    const lease=(await environmentService(db).getLeaseById(leaseId))!;
    expect(run.status).toBe("cancelled");expect(hasRemoteTerminationReceipt(lease)).toBe(true);
    expect(()=>process.kill(pid,0)).toThrow();expect(await agentExecutionsHaveStopped(db,[agentId])).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,companyId))).toEqual([]);
  }finally{
    if(runId){await heartbeat.cancelRun(runId,"Fixture teardown").catch(()=>{});await runtime.releaseRunLeases(runId,"released",undefined,undefined,true);}
    await invocation;await heartbeat.drainActiveRunExecutions();
    if(leaseId){const lease=(await environmentService(db).getLeaseById(leaseId))!;
      if(hasRemoteTerminationReceipt(lease)){const state=path.join(os.homedir(),".local/state/paperclip/ssh-scopes-v1",leaseId);await rm(state,{recursive:true});}}
    if(fixture)await stopSshEnvLabFixture(fixture);
    await database.cleanup();await rm(root,{recursive:true,force:true});
  }
},90000);
