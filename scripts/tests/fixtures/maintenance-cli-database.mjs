import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import readline from 'node:readline';
const [capsule]=process.argv.slice(2);
if(!path.isAbsolute(capsule)||process.getuid()===0)throw Error('Explicit unprivileged fixture owner required');
const entry=path.join(capsule,'node_modules/@paperclipai/db/dist/index.js');
const require=createRequire(entry),{sql}=require('drizzle-orm');
const m=await import(pathToFileURL(entry));
let temporary,cloneUrl,sourceUrl,adminUrl,sourceSnapshot,cloneSnapshot,cloneName;
const result=value=>console.log('MAINTENANCE_CLI_FIXTURE:'+JSON.stringify(value));
const id=v=>'"'+v+'"';
const snapshot=async url=>{
 const db=m.createDb(url,{maxConnections:1});
 try{
  const names=['companies','agents','issues','heartbeat_runs','environment_leases','issue_recovery_actions','agent_wakeup_requests','company_secrets','company_secret_versions'];
  const rows={};for(const name of names){const [s]=await db.execute(sql.raw(`select count(*)::int as count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by id),'')) as digest from ${id(name)} t`));rows[name]=s;}
  return rows;
 }finally{await db.$client.end();}
};
const dbOperation=async(url,fn)=>{const db=m.createDb(url,{maxConnections:1});try{return await fn(db);}finally{await db.$client.end();}};
try{
 temporary=await m.startEmbeddedPostgresTestDatabase('maintenance-packaged-cli-');sourceUrl=temporary.connectionString;
 const ids=Array.from({length:12},()=>randomUUID());const [company,issue,parent,run,action,lease,instance,...actors]=ids;
 await dbOperation(sourceUrl,async db=>{
  await db.insert(m.instanceSettings).values({id:instance,singletonKey:'default'}).onConflictDoNothing();
  await db.insert(m.companies).values({id:company,name:'Synthetic packaged CLI company',issuePrefix:'MCLI'});
  for(const [i,name] of ['Coordinator','Researcher','Planner','Implementer','Reviewer'].entries())await db.insert(m.agents).values({id:actors[i],companyId:company,name,adapterType:'process',status:'idle',adapterConfig:{command:'/usr/bin/false'},runtimeConfig:{heartbeat:{enabled:false}}});
  await db.insert(m.issues).values([{id:issue,companyId:company,title:'Synthetic retained review',status:'in_review',assigneeAgentId:actors[0]},{id:parent,companyId:company,title:'Synthetic parent retry',status:'blocked',assigneeAgentId:actors[0]}]);
  const scope={schema:'paperclip.ssh-execution-scope.v1',generation:randomUUID()};
  const descriptor={schema:'paperclip.workspace-restore-recovery.v1',source:{provider:'ssh',runId:run},leaseIds:[lease],fixtureOnly:true};
  await db.insert(m.heartbeatRuns).values({id:run,companyId:company,agentId:actors[1],issueId:issue,status:'cancelled',runtimeMode:'legacy',finishedAt:new Date(),resultJson:{workspaceRestoreFailure:'restore_failed',workspaceRestoreRecovery:descriptor}});
  await db.insert(m.environmentLeases).values({id:lease,companyId:company,issueId:issue,heartbeatRunId:run,provider:'ssh',providerLeaseId:'synthetic-cli-allocation',status:'expired',cleanupStatus:'success',releasedAt:new Date(),metadata:{remoteExecutionScopeRequired:true,remoteExecutionScope:scope,remoteExecutionTermination:{schema:'paperclip.remote-termination.v1',companyId:company,runId:run,leaseId:lease,provider:'ssh',providerLeaseId:'synthetic-cli-allocation',state:'stopped',resourceScope:scope}}});
  await db.insert(m.issueRecoveryActions).values({id:action,companyId:company,sourceIssueId:issue,kind:'active_run_watchdog',ownerType:'board',status:'resolved',cause:'legacy_execution_requires_reconciliation',fingerprint:randomUUID(),nextAction:'Retain synthetic source',evidence:{runId:run,workspaceRestoreRecovery:descriptor,automaticRecovery:{policy:'preserve_without_replay_v1',replay:'blocked'}}});
  await db.insert(m.agentWakeupRequests).values([{companyId:company,agentId:actors[0],source:'automation',status:'deferred_issue_execution',reason:'execution_reconciliation_required',payload:{issueId:issue,executionWait:{reason:'execution_recovery',recoveryActionId:action}}},{companyId:company,agentId:actors[0],source:'on_demand',status:'deferred_issue_execution',reason:'task_retry',payload:{issueId:parent,taskRetry:{synthetic:true}}}]);
  for(let n=0;n<3;n++){const secret=randomUUID();await db.insert(m.companySecrets).values({id:secret,companyId:company,scope:'controller',key:'synthetic-cli-signing-'+n,name:'Synthetic ciphertext only '+n,provider:'local_encrypted'});await db.insert(m.companySecretVersions).values({secretId:secret,version:1,material:{ciphertext:'synthetic-not-a-signing-key-'+n,iv:'synthetic',tag:'synthetic'},valueSha256:'a'.repeat(64),fingerprintSha256:'b'.repeat(64)});}
 });
 sourceSnapshot=await snapshot(sourceUrl);
 const admin=new URL(sourceUrl);admin.pathname='/postgres';adminUrl=admin.href;
 const sourceName=new URL(sourceUrl).pathname.slice(1);cloneName='maintenance_cli_'+randomUUID().replaceAll('-','');
 if(!/^[a-z0-9_]+$/.test(sourceName))throw Error('Unsafe synthetic template identity');
 await dbOperation(adminUrl,db=>db.execute(sql.raw(`create database ${id(cloneName)} template ${id(sourceName)}`)));
 const u=new URL(sourceUrl);u.pathname='/'+cloneName;cloneUrl=u.href;cloneSnapshot=await snapshot(cloneUrl);
 const identity=await dbOperation(cloneUrl,async db=>{const [x]=await db.execute(sql`select current_database() as database,(select oid::int from pg_database where datname=current_database()) as "databaseOid",(select id::text from instance_settings where singleton_key='default') as "instanceId"`);return x;});
 result({kind:'ready',databaseUrl:cloneUrl,identity});
 for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
  const q=JSON.parse(line);
  if(q.mode==='verify'){
   if(JSON.stringify(await snapshot(sourceUrl))!==JSON.stringify(sourceSnapshot))throw Error('Original populated source changed');
   if(JSON.stringify(await snapshot(cloneUrl))!==JSON.stringify(cloneSnapshot))throw Error('Retained clone rows or secret/wake payloads changed');
   const state=await dbOperation(cloneUrl,async db=>{const [x]=await db.execute(sql`select state,generation,continuation_policy from instance_maintenance`);return x;});
   if(state.state!=='held'||state.continuation_policy!=='requires_readiness_decision')throw Error('Strict maintenance was lost');
   result({kind:'verified',state,retainedDomainCount:Object.keys(cloneSnapshot).length,retainedDigest:createHash('sha256').update(JSON.stringify(cloneSnapshot)).digest('hex')});
  }else if(q.mode==='stop'){break;}else throw Error('Unknown synthetic fixture command');
 }
}finally{
 if(cloneName)await dbOperation(adminUrl,db=>db.execute(sql.raw(`drop database ${id(cloneName)}`)));
 await temporary?.cleanup();
}
result({kind:'stopped',productionAccess:false});
