/** Actual independent packaged runtime against a populated PostgreSQL clone.
 * Synthetic source, ciphertext, actors, leases and wakes only; no production
 * connection/config/key is read. Network namespace required by outer harness.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, companies, agents, issues, heartbeatRuns, issueRecoveryActions, agentWakeupRequests,
  environmentLeases, companySecrets, companySecretVersions, instanceSettings } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
const isolated=process.env.PAPERCLIP_TEST_MAINTENANCE_STARTUP_ISOLATED==='1';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const identifier=(v:string)=>{if(!/^[a-z0-9_]+$/.test(v))throw Error('Unsafe fixture database name');return '"'+v+'"';};
(isolated?describe:describe.skip)('independent offline cutover populated clone',()=>{
  let temporary:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,root:string,bundle:string,sourceUrl:string;
  let admin:ReturnType<typeof createDb>,sourceSnapshot:unknown;
  const clones:string[]=[],timings:Record<string,number>={};
  const actorIds=['Coordinator','Researcher','Planner','Implementer','Reviewer'].map(()=>randomUUID());
  const companyId=randomUUID(),issueId=randomUUID(),parentId=randomUUID(),runId=randomUUID(),actionId=randomUUID(),leaseId=randomUUID(),instanceId=randomUUID();
  function operator(input:Record<string,unknown>,ok=true){
    const bridge='import {operate} from "./runtime.mjs";let s="";for await(const c of process.stdin)s+=c;try{console.log(JSON.stringify(await operate(JSON.parse(s))))}catch(e){console.error(e.message);process.exit(3)}';
    const started=performance.now();const result=spawnSync(path.join(bundle,'node'),['--input-type=module','--eval',bridge],{cwd:bundle,env:{PATH:'/usr/bin:/bin',HOME:root},input:JSON.stringify(input),encoding:'utf8',maxBuffer:8*1024*1024});
    timings[String(input.mode)]=(timings[String(input.mode)]??0)+(performance.now()-started);
    if(ok){expect(result.status,result.stderr).toBe(0);return JSON.parse(result.stdout);}expect(result.status).toBe(3);return result.stderr;
  }
  async function clone(){
    const name='maintenance_clone_'+randomUUID().replaceAll('-','');clones.push(name);
    const source=new URL(sourceUrl).pathname.slice(1);
    await admin.execute(sql.raw(`create database ${identifier(name)} template ${identifier(source)}`));
    const u=new URL(sourceUrl);u.pathname='/'+name;const db=createDb(u.href,{maxConnections:1});
    let identity;
    try{const [r]=await db.execute(sql`select current_database() as database,(select oid::int from pg_database where datname=current_database()) as "databaseOid",(select id::text from instance_settings where singleton_key='default') as "instanceId"`);identity=r;}
    finally{await db.$client.end();}
    return {mode:'inspect',databaseUrl:u.href,identity,expectedGeneration:0,requestId:randomUUID(),approvalReference:'synthetic-review-approval',operatorNote:'Synthetic private operator note'};
  }
  beforeAll(async()=>{
    const routes=JSON.parse(execFileSync('ip',['-j','route','show','table','all'],{encoding:'utf8'}));expect(routes.some((r:{dst?:string})=>r.dst==='default')).toBe(false);
    root=await mkdtemp(path.join(os.homedir(),'.maintenance-cutover-fixture-'));bundle=path.join(root,'operator');
    execFileSync(process.execPath,[path.join(repo,'scripts/operations/build-maintenance-runtime.mjs'),bundle,'--qualification'],{cwd:repo,stdio:'pipe'});
    temporary=await startEmbeddedPostgresTestDatabase('maintenance-offline-');sourceUrl=temporary.connectionString;
    const source=createDb(sourceUrl,{maxConnections:1});
    try{
      await source.insert(instanceSettings).values({id:instanceId,singletonKey:'default'}).onConflictDoNothing();
      await source.insert(companies).values({id:companyId,name:'Synthetic five-role company',issuePrefix:'MCT'});
      for(const [i,name] of ['Coordinator','Researcher','Planner','Implementer','Reviewer'].entries())await source.insert(agents).values({id:actorIds[i],companyId,name,adapterType:'process',status:'idle'});
      await source.insert(issues).values([{id:issueId,companyId,title:'Retained source review',status:'in_review',assigneeAgentId:actorIds[0]},{id:parentId,companyId,title:'Blocked parent retry',status:'blocked',assigneeAgentId:actorIds[0]}]);
      const scope={schema:'paperclip.ssh-execution-scope.v1',generation:randomUUID()};
      const descriptor={schema:'paperclip.workspace-restore-recovery.v1',source:{provider:'ssh',runId},leaseIds:[leaseId],fixtureOnly:true};
      await source.insert(heartbeatRuns).values({id:runId,companyId,agentId:actorIds[1],issueId,status:'cancelled',runtimeMode:'legacy',finishedAt:new Date(),resultJson:{workspaceRestoreFailure:'restore_failed',workspaceRestoreRecovery:descriptor}});
      await source.insert(environmentLeases).values({id:leaseId,companyId,issueId,heartbeatRunId:runId,provider:'ssh',providerLeaseId:'synthetic-ssh-allocation',status:'expired',cleanupStatus:'success',releasedAt:new Date(),metadata:{remoteExecutionScopeRequired:true,remoteExecutionScope:scope,remoteExecutionTermination:{schema:'paperclip.remote-termination.v1',companyId,runId,leaseId,provider:'ssh',providerLeaseId:'synthetic-ssh-allocation',state:'stopped',resourceScope:scope}}});
      await source.insert(issueRecoveryActions).values({id:actionId,companyId,sourceIssueId:issueId,kind:'active_run_watchdog',ownerType:'board',status:'resolved',cause:'legacy_execution_requires_reconciliation',fingerprint:randomUUID(),nextAction:'Preserve exact source',evidence:{runId,workspaceRestoreRecovery:descriptor,automaticRecovery:{policy:'preserve_without_replay_v1',replay:'blocked'}}});
      await source.insert(agentWakeupRequests).values([{companyId,agentId:actorIds[0],source:'automation',status:'deferred_issue_execution',payload:{issueId,executionWait:{reason:'execution_recovery',recoveryActionId:actionId}}},{companyId,agentId:actorIds[0],source:'on_demand',status:'deferred_issue_execution',payload:{issueId:parentId,taskRetry:{fixtureOnly:true}}}]);
      for(let i=0;i<3;i++){
        const id=randomUUID();await source.insert(companySecrets).values({id,companyId,scope:'controller',key:'fixture-signing-'+i,name:'Synthetic signing key '+i,provider:'local_encrypted'});
        await source.insert(companySecretVersions).values({secretId:id,version:1,material:{encrypted:true,ciphertext:'synthetic-not-a-key-'+i,iv:'synthetic-only',tag:'synthetic-only'},valueSha256:'a'.repeat(64),fingerprintSha256:'b'.repeat(64)});
      }
      // Reconstruct the actual old467 floor, preserving retained rows.
      await source.execute(sql.raw('drop trigger maintenance_saved_intent_gate on public.agent_wakeup_requests; drop function public.maintenance_saved_intent_gate(); drop table public.instance_maintenance_events,public.instance_maintenance_operations,public.instance_maintenance;'));
      await source.execute(sql.raw('drop table public.issue_workflow_handoffs,public.github_app_settings; delete from drizzle.__drizzle_migrations where id in (select id from drizzle.__drizzle_migrations order by id desc limit 4)'));
    }finally{await source.$client.end();}
    const adminUrl=new URL(sourceUrl);adminUrl.pathname='/postgres';admin=createDb(adminUrl.href,{maxConnections:1});
    const original=createDb(sourceUrl,{maxConnections:1});let originalIdentity;
    try{const [r]=await original.execute(sql`select current_database() as database,(select oid::int from pg_database where datname=current_database()) as "databaseOid",(select id::text from instance_settings where singleton_key='default') as "instanceId"`);originalIdentity=r;}finally{await original.$client.end();}
    sourceSnapshot=operator({mode:'inspect',databaseUrl:sourceUrl,identity:originalIdentity,expectedGeneration:0});
  },90000);
  afterAll(async()=>{
    for(const name of clones)await admin.execute(sql.raw(`drop database ${identifier(name)}`));
    await admin?.$client.end();await temporary?.cleanup();if(root)await rm(root,{recursive:true,force:true});
    console.log(JSON.stringify({maintenanceCutoverRehearsalMilliseconds:timings,syntheticCloneOnly:true,productionAccess:false,sourceRecoveryPerformed:false}));
  },60000);
  it('upgrades a populated clone, preserves every retained domain, installs strict hold and safely replays a lost response',async()=>{
    const input=await clone();const before=operator(input);expect(before.migration.pendingMigrations).toHaveLength(4);
    expect(Object.keys(before.inventory).length).toBeGreaterThan(100);expect(before.inventory.company_secret_versions.count).toBe(3);expect(before.inventory.agent_wakeup_requests.count).toBe(2);
    const initialized=operator({...input,mode:'initialize',baseline:before.inventory});expect(initialized).toMatchObject({state:'held',generation:1,policy:'requires_readiness_decision'});
    expect(initialized.inventory).toMatchObject(before.inventory);expect(initialized.inventory.github_app_settings.count).toBe(0);expect(initialized.inventory.issue_workflow_handoffs.count).toBe(0);
    const replay=operator({...input,mode:'initialize',baseline:before.inventory});expect(replay).toEqual(initialized);
    const guard=operator({...input,mode:'guard',expectedGeneration:1,expectedOwnerId:initialized.ownerId});expect(guard).toMatchObject({state:'held',generation:1});
    expect(operator({...input,mode:'guard',expectedGeneration:2,expectedOwnerId:initialized.ownerId},false)).toContain('cannot be verified');
    expect(operator({...input,mode:'guard',expectedGeneration:1,expectedOwnerId:randomUUID()},false)).toContain('cannot be verified');
    const changed=operator({...input,mode:'initialize',baseline:before.inventory,operatorNote:'Changed authority'},false);expect(changed).toContain('identity changed');
    const u=sourceSnapshot as {identity:unknown,inventory:unknown};expect(operator({mode:'inspect',databaseUrl:sourceUrl,identity:u.identity,expectedGeneration:0}).inventory).toEqual(u.inventory);
  },90000);
  it('refuses another database client, wrong identity and a changed baseline before mutation',async()=>{
    const input=await clone();const before=operator(input);
    expect(operator({...input,mode:'initialize',baseline:{changed:true}},false)).toContain('baseline differs');
    expect(operator({...input,identity:{...input.identity,instanceId:randomUUID()}},false)).toContain('identity differs');
    const competing=createDb(input.databaseUrl,{maxConnections:1});await competing.execute(sql`select 1`);
    try{expect(operator(input,false)).toContain('Another database client');}finally{await competing.$client.end();}
    expect(operator(input).migration.pendingMigrations).toHaveLength(4);
  },60000);
  it('keeps acquiring rather than forcing held when genuine durable work remains',async()=>{
    const input=await clone();const db=createDb(input.databaseUrl,{maxConnections:1});
    try{await db.execute(sql`update heartbeat_runs set status='running' where id=${runId}`);}finally{await db.$client.end();}
    const baseline=operator(input).inventory;expect(operator({...input,mode:'initialize',baseline},false)).toContain('remains acquiring');
    const verify=createDb(input.databaseUrl,{maxConnections:1});
    try{const [r]=await verify.execute(sql`select state,continuation_policy from instance_maintenance`);expect(r).toEqual({state:'acquiring',continuation_policy:'requires_readiness_decision'});}finally{await verify.$client.end();}
    expect(operator({...input,mode:'guard',expectedGeneration:1,expectedOwnerId:randomUUID()},false)).toContain('cannot be verified');
  },60000);
  it('resumes a partially committed upgrade without changing source, wakes or encrypted secret rows',async()=>{
    const input=await clone();const before=operator(input);
    const migration=path.join(bundle,'migrations/0469_blue_celestials.sql');const original=await readFile(migration);
    try{
      await writeFile(migration,'select deliberately_missing_fixture_function();');
      operator({...input,mode:'initialize',baseline:before.inventory},false);
    }finally{await writeFile(migration,original);}
    const partial=operator(input);expect(partial.migration.pendingMigrations).toHaveLength(3);expect(partial.inventory.github_app_settings.count).toBe(0);
    const initialized=operator({...input,mode:'initialize',baseline:before.inventory});expect(initialized.state).toBe('held');expect(initialized.inventory).toMatchObject(before.inventory);
  },60000);
  it('refuses an old schema at the protected startup check',async()=>{
    const input=await clone();expect(operator({...input,mode:'guard',expectedGeneration:1,expectedOwnerId:randomUUID()},false)).toContain('instance_maintenance');
  },60000);
});
