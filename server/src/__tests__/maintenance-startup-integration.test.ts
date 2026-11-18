import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, companies, agents, issues, heartbeatRuns, issueRecoveryActions, agentWakeupRequests } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { startMaintenance, reconcileMaintenance } from "../services/instance-maintenance.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";

const isolated=process.env.PAPERCLIP_TEST_MAINTENANCE_STARTUP_ISOLATED==='1';
(isolated?describe:describe.skip)("actual cold startup/restart under persisted maintenance",()=>{
  let temporary:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>,root:string;
  let child:ChildProcess|undefined;
  let port=0;
  beforeAll(async()=>{
    const routes=JSON.parse(execFileSync('ip',['-j','route','show','table','all'],{encoding:'utf8'}));
    if(routes.some((r:{dst?:string})=>r.dst==='default'))throw Error('Owned loopback-only namespace required');
    temporary=await startEmbeddedPostgresTestDatabase('maintenance-startup-');db=createDb(temporary.connectionString);
    root=await mkdtemp(path.join(os.tmpdir(),'maintenance-startup-home-'));await mkdir(path.join(root,'cwd'),{mode:0o700});
  },60000);
  afterAll(async()=>{
    // Never remove the database/home beneath an uncertain server callback.
    // The outer owned-namespace fixture can stop residual processes, while
    // these synthetic files remain available for diagnosis after a failure.
    if(child){
      if(!child.connected)throw Error('Fixture shutdown uncertain; synthetic database/home retained');
      try{await stop();}catch{throw Error('Fixture shutdown did not join; synthetic database/home retained');}
    }
    await db?.$client.end();await temporary?.cleanup();if(root)await rm(root,{recursive:true,force:true});
  },90000);
  async function boot(){
    let tail='';const entry=fileURLToPath(new URL('./helpers/maintenance-startup-child.ts',import.meta.url));
    child=fork(entry,[],{cwd:path.join(root,'cwd'),execArgv:['--import',import.meta.resolve('tsx/esm')],stdio:['ignore','pipe','pipe','ipc'],env:{
      HOME:root,PATH:process.env.PATH,PAPERCLIP_HOME:root,PAPERCLIP_INSTANCE_ID:'maintenance-fixture',PAPERCLIP_CONFIG:path.join(root,'absent-config.json'),
      DATABASE_URL:temporary.connectionString,PAPERCLIP_DEPLOYMENT_MODE:'local_trusted',HOST:'127.0.0.1',PORT:'3100',SERVE_UI:'false',
      PAPERCLIP_TELEMETRY_DISABLED:'1',DO_NOT_TRACK:'1',PAPERCLIP_DB_BACKUP_ENABLED:'false',PAPERCLIP_SECRETS_MASTER_KEY:'47'.repeat(32),
      PAPERCLIP_AGENT_JWT_SECRET:'synthetic-startup-jwt-only-64-characters-no-production-value-here',
      PAPERCLIP_TEST_MAINTENANCE_STARTUP_ISOLATED:'1'}});
    const capture=(bytes:Buffer)=>{tail=(tail+bytes.toString()).slice(-6000);};child.stdout?.on('data',capture);child.stderr?.on('data',capture);
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Startup did not become ready: '+tail)),60000);
      child!.on('message',m=>{const message=m as {kind?:string;port?:number};if(message.kind==='ready'){port=message.port!;clearTimeout(timer);resolve();}});
      child!.once('exit',code=>{clearTimeout(timer);reject(Error('Startup exited '+code+': '+tail));});});
    return child;
  }
  async function stop(){const owned=child!;await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned startup fixture failed to settle shutdown')),60000);owned.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Owned startup fixture shutdown failed '+code));});owned.send('stop');});child=undefined;}
  it("keeps original missing-adoption source and two saved wakes across actual startup, later notification and restart",async()=>{
    const companyId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),parentId=randomUUID(),runId=randomUUID(),actionId=randomUUID();
    await db.insert(companies).values({id:companyId,name:'Startup fixture',issuePrefix:'MS'});
    await db.insert(agents).values({id:agentId,companyId,name:'Coordinator',adapterType:'process',status:'idle'});
    await db.insert(issues).values([{id:issueId,companyId,title:'Saved review',status:'in_review',assigneeAgentId:agentId},{id:parentId,companyId,title:'Parent Retry',status:'blocked',assigneeAgentId:agentId}]);
    const descriptor={schema:'paperclip.workspace-restore-recovery.v1',leaseIds:[],source:{provider:'ssh',runId}};
    await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,issueId,status:'cancelled',runtimeMode:'legacy',finishedAt:new Date(),resultJson:{workspaceRestoreFailure:'restore_failed',workspaceRestoreRecovery:descriptor}});
    await db.insert(issueRecoveryActions).values({id:actionId,companyId,sourceIssueId:issueId,kind:'active_run_watchdog',ownerType:'board',status:'resolved',cause:'legacy_execution_requires_reconciliation',fingerprint:randomUUID(),nextAction:'Preserve original source',evidence:{runId,workspaceRestoreRecovery:descriptor,automaticRecovery:{policy:'preserve_without_replay_v1',replay:'blocked'}}});
    await db.insert(agentWakeupRequests).values([{companyId,agentId,source:'automation',status:'deferred_issue_execution',reason:'execution_reconciliation_required',payload:{issueId,executionWait:{reason:'execution_recovery',recoveryActionId:actionId}}},{companyId,agentId,source:'on_demand',status:'deferred_issue_execution',reason:'task_retry',payload:{issueId:parentId,taskRetry:{fixture:true}}}]);
    await startMaintenance(db,{actorId:'isolated-operator',requestId:randomUUID(),expectedGeneration:0,operatorNote:'Private synthetic incident'});await reconcileMaintenance(db);
    const snapshot=async()=>({actions:await db.select().from(issueRecoveryActions),wakes:(await db.select().from(agentWakeupRequests)).map(w=>({id:w.id,status:w.status,runId:w.runId,payload:w.payload})),runs:await db.select().from(heartbeatRuns)});
    const before=await snapshot();
    for(let iteration=0;iteration<2;iteration++){
      await boot();const status=await fetch(`http://127.0.0.1:${port}/api/instance/maintenance`).then(r=>r.json());expect(status.state).toBe('held');
      const hint=randomUUID();
      const observed=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child?.off('message',listener);reject(Error('Exact recovery notification was not observed by the actual owner'));},30000);const listener=(m:unknown)=>{const msg=m as {kind?:string;hints?:string[]};if(msg.kind==='recovery_pass'&&msg.hints?.includes(hint)){clearTimeout(timer);child?.off('message',listener);resolve();}};child!.on('message',listener);});
      // Self-hosted queue hints are process-local by default. Drive the actual
      // server-owned committed producer, not an unrelated client/pool. The
      // private host seam grants no task/source/execution authority.
      child!.send({kind:'notify-recovery',hint});await observed;
      const projection=await fetch(`http://127.0.0.1:${port}/api/instance/maintenance?view=task`).then(r=>r.json());expect(projection.admin).toBeUndefined();
      await stop();expect(await snapshot()).toEqual(before);
    }
    const [count]=await db.execute(sql`select count(*)::int as n from instance_maintenance_operations where state='active'`);expect(count.n).toBe(0);
  },180000);
});
