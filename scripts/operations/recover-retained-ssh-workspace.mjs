import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cloneUrl, requireCloneIdentity } from './qualify-database-upgrade.mjs';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const profileNames=new Set(['PAPERCLIP_HOME','PAPERCLIP_INSTANCE_ID','PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS',
 'PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS','PAPERCLIP_CONTROLLER_PROTECTED_PATHS','PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS',
 'PAPERCLIP_CONTROLLER_ASSET_SNAPSHOT_ROOT','PAPERCLIP_SECRETS_MASTER_KEY_FILE']);
export function validateRetainedSshOptions(o){
 if(!o||!['attest','preserve','retire-wake','verify'].includes(o.command)||o.confirm!==true||
   !['companyId','issueId','runId','actionId'].every(k=>uuid.test(o[k]??''))||typeof o.actorId!=='string'||!o.actorId||o.actorId.length>255||
   !/^[a-f0-9]{40}$/.test(o.sourceCommit??'')||!/^\/opt\/paperclip-data\/cli\/installs\/git\/[a-f0-9]{12}$/.test(o.payload??'')||
   o.config!=='/opt/paperclip-data/instances/default/config.json'||
   !/^\/var\/lib\/paperclip\/operator-receipts\/[a-f0-9-]{36}\.json$/.test(o.receipt??''))throw Error('Explicit scoped operator options required');
 if(o.command==='retire-wake'&&!['wakeId','stalledIssueId','stalledActionId'].every(k=>uuid.test(o[k]??'')))throw Error('Exact deferred stall identity required');
 if(o.command==='attest'&&(!/^paperclip_qualify_[a-f0-9]{12}$/.test(o.cloneDatabase??'')||
   !/^[a-f0-9]{64}$/.test(o.expectedRestoreSha256??'')||!/^[a-f0-9]{64}$/.test(o.expectedHostKeyPolicySha256??'')||
   !/^\/var\/backups\/paperclip\/[a-zA-Z0-9_./-]+\.dump$/.test(o.historicalBackup??'')||o.historicalBackup.split('/').includes('..')))throw Error('Verified historical endpoint provenance required');
}
export function selectedProtectionProfile(bytes){
 if(bytes.length>1024*1024)throw Error('Service environment too large');
 const selected={}; let protectedService=false;
 for(const entry of bytes.toString('utf8').split('\0')){
   const at=entry.indexOf('=');if(at<1)continue;const name=entry.slice(0,at),value=entry.slice(at+1);
   if((name==='PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS'||name==='PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG')&&value)protectedService=true;
   if(profileNames.has(name))selected[name]=value;
 }
 if(!protectedService||!selected.PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS||!selected.PAPERCLIP_CONTROLLER_ASSET_SNAPSHOT_ROOT)throw Error('Protected service profile unavailable');
 // This never grants a new root. Effective named values come from the running
 // protected service, not the options file or an agent's configuration.
 return {...selected,PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS:'1'};
}
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export async function recoverRetainedSshWorkspace(o){
 validateRetainedSshOptions(o);
 if(process.getuid?.()!==0||process.env.PAPERCLIP_OPERATOR_API_TOKEN)throw Error('Dedicated root operator process required');
 const root=fs.realpathSync(o.payload);
 if(root!==o.payload||read(path.join(root,'node_modules/@paperclipai/server/dist/build-info.json')).commit!==o.sourceCommit)throw Error('Pinned release differs');
 const health=await fetch('https://project.orozco.mov/api/health',{redirect:'error',signal:AbortSignal.timeout(15000)}).then(r=>{if(!r.ok)throw Error('Health unavailable');return r.json();});
 if(health.status!=='ok'||health.commit!==o.sourceCommit)throw Error('The reviewed release is not the healthy live release');
 const pid=Number(execFileSync('systemctl',['show','paperclip.service','--property=MainPID','--value'],{encoding:'utf8'}).trim());
 const uid=Number(execFileSync('id',['-u','paperclip'],{encoding:'utf8'}).trim()),gid=Number(execFileSync('id',['-g','paperclip'],{encoding:'utf8'}).trim());
 if(!Number.isSafeInteger(pid)||pid<2||!uid||!gid||fs.statSync(`/proc/${pid}`).uid!==uid)throw Error('Service process identity differs');
 const start=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
 const profile=selectedProtectionProfile(fs.readFileSync(`/proc/${pid}/environ`));
 if(fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(' ').slice(21,22).join()!==start.split(' ').slice(21,22).join())throw Error('Service changed during profile capture');
 const instance=read(o.config),live=new URL(instance.database.connectionString);
 if(!['postgres:','postgresql:'].includes(live.protocol)||!['localhost','127.0.0.1','[::1]'].includes(live.hostname)||live.pathname!=='/paperclip'||live.search||live.hash)throw Error('Live database target differs');
 let historical;
 const receipts='/var/lib/paperclip/operator-receipts';fs.mkdirSync(receipts,{recursive:true,mode:0o700});
 const directory=fs.lstatSync(receipts);if(fs.realpathSync(receipts)!==receipts||directory.uid!==0||(directory.mode&0o077))throw Error('Protected operator receipt directory required');
 const fd=fs.openSync(o.receipt,'wx',0o600);
 const writeReceipt=value=>{const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');fs.writeSync(fd,bytes,0,bytes.length,0);fs.ftruncateSync(fd,bytes.length);fs.fsyncSync(fd);};
 writeReceipt({status:'started',sourceCommit:o.sourceCommit,command:o.command,companyId:o.companyId,issueId:o.issueId,runId:o.runId,actionId:o.actionId,...(o.command==='attest'?{cloneDatabase:o.cloneDatabase,historicalBackup:o.historicalBackup,expectedRestoreSha256:o.expectedRestoreSha256}:{})});
 let dbModule,probe;
 try{
   if(o.command==='attest'){
     // Create an exclusive fresh clone from the verified open historical dump.
     // A receipt for a previously reused database is not provenance.
     if(live.port && live.port!=='5432')throw Error('Historical restore requires the verified local system PostgreSQL cluster');
     const backup=o.historicalBackup;
     let parent=path.dirname(backup);
     while(parent!=='/'){
       const stat=fs.lstatSync(parent);
       if(fs.realpathSync(parent)!==parent||!stat.isDirectory()||stat.uid!==0||(stat.mode&0o022))throw Error('Protected physical backup ancestry required');
       parent=path.dirname(parent);
     }
     const dump=fs.openSync(backup,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
     try{
       const before=fs.fstatSync(dump,{bigint:true});
       if(!before.isFile()||before.uid!==0n||before.nlink!==1n||(before.mode&0o077n)||before.size<1n||before.size>268435456n)throw Error('Bounded protected root-owned backup required');
       const fingerprint=()=>{
         const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let position=0,count;
         while((count=fs.readSync(dump,buffer,0,buffer.length,position))>0){hash.update(buffer.subarray(0,count));position+=count;if(position>268435456)throw Error('Historical backup exceeds bound');}
         if(BigInt(position)!==before.size)throw Error('Historical backup size changed');
         return hash.digest('hex');
       };
       if(fingerprint()!==o.expectedRestoreSha256)throw Error('Historical backup digest differs');
       const postgres=(command,args,stdin='ignore')=>execFileSync('runuser',['-u','postgres','--',command,...args],
         {env:{PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/var/lib/postgresql'},stdio:[stdin,'ignore','pipe'],timeout:120000});
       // No clean/drop/reuse fallback: an existing or uncertain clone is refused.
       postgres('createdb',['--owner','paperclip',o.cloneDatabase]);
       postgres('pg_restore',['--exit-on-error','--dbname',o.cloneDatabase],dump);
       const after=fs.fstatSync(dump,{bigint:true}),named=fs.lstatSync(backup,{bigint:true});
       if(['dev','ino','size','mtimeNs','ctimeNs','uid','mode','nlink'].some(k=>before[k]!==after[k]||before[k]!==named[k])||
         fingerprint()!==o.expectedRestoreSha256)throw Error('Historical backup changed during restore');
       postgres('psql',['-X','--dbname','postgres','--set','ON_ERROR_STOP=1','-c',
         `ALTER DATABASE "${o.cloneDatabase}" SET default_transaction_read_only = on; REVOKE CONNECT ON DATABASE "${o.cloneDatabase}" FROM PUBLIC;`]);
       historical=new URL(cloneUrl(live.href,o.cloneDatabase,{cloneDatabase:o.cloneDatabase,restoreVerified:true,
         liveDatabaseModified:false,sha256:o.expectedRestoreSha256}));
       historical.searchParams.set('options','-c default_transaction_read_only=on');
     }finally{fs.closeSync(dump);}
   }
   // Match the service identity for private source staging and SSH transport.
   // Neither desktop credentials nor unrelated service environment values survive.
   for(const key of Object.keys(process.env))delete process.env[key];
   Object.assign(process.env,profile,{HOME:'/home/paperclip',USER:'paperclip',LOGNAME:'paperclip',PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'});
   process.setgroups([]);process.setgid(gid);process.setuid(uid);
   const dbEntry=path.join(root,'node_modules/@paperclipai/db/dist/index.js');dbModule=await import(pathToFileURL(dbEntry).href);
   const require=createRequire(dbEntry),postgres=require('postgres');
   if(o.command==='verify')live.searchParams.set('options','-c default_transaction_read_only=on');
   const db=dbModule.createDb(live.href,{maxConnections:2});
   const load=name=>import(pathToFileURL(path.join(root,'node_modules/@paperclipai/server/dist',name+'.js')).href);
   const input={companyId:o.companyId,issueId:o.issueId,runId:o.runId,actionId:o.actionId};
   let outcome;
   if(o.command==='attest'){
     probe=postgres(historical.href,{max:1});await requireCloneIdentity(probe,o.cloneDatabase);
     const historicalDb=dbModule.createDb(historical.href,{maxConnections:1});
     const {attestRetainedSshEndpointFromHistoricalEnvironment}=await load('services/retained-ssh-endpoint-attestation');
     outcome=await attestRetainedSshEndpointFromHistoricalEnvironment(db,{...input,historicalDb,historicalDatabase:o.cloneDatabase,historicalBackupSha256:o.expectedRestoreSha256,
       expectedHostKeyPolicySha256:o.expectedHostKeyPolicySha256,actorId:o.actorId});
   }else if(o.command==='retire-wake'){
     const {retireDeferredBlockerStallWake}=await load('modules/wake-queue/index');
     outcome=await retireDeferredBlockerStallWake(db,{...input,sourceActionId:o.actionId,wakeId:o.wakeId,
       stalledIssueId:o.stalledIssueId,stalledActionId:o.stalledActionId,actorId:o.actorId});
   }else if(o.command==='preserve'){
     const {withNativeWorkspaceFinalizationOwnership}=await load('services/native-runtime/native-workspace-finalization-ownership');
     const {preserveRetainedSshWorkspace}=await load('services/retained-ssh-workspace-preservation');
     const held=await withNativeWorkspaceFinalizationOwnership({db,companyId:o.companyId,runId:o.runId,retainedRepairActionId:o.actionId},
       owner=>preserveRetainedSshWorkspace({...input,db,assertHeld:owner.assertHeld}));
     if(!held.acquired)throw Error('Original source ownership unavailable');
     outcome={operationId:held.value,immutableSnapshotVerified:true,originalSourceRetained:true,liveMergePerformed:false};
   }else{
     const {getExecutionBlocker}=await load('services/execution-blocker');const blocker=await getExecutionBlocker(db,o.companyId,o.issueId);
     outcome={recoveryActionId:blocker?.recoveryActionId??null,workspaceRepairRequired:blocker?.workspaceRepairRequired??false,
       canRetry:blocker?.canRetry??false,canContinue:blocker?.canContinue??false};
   }
   const result={sourceCommit:o.sourceCommit,command:o.command,...input,outcome,serverWorkersStarted:false,providerTurnStarted:false,secretsDisclosed:false};
   writeReceipt({status:'completed',...result});return result;
 }finally{
   fs.closeSync(fd);await probe?.end({timeout:5});
   if(dbModule){await dbModule.closeRegisteredClients(live.href,{scope:'database'});if(historical)await dbModule.closeRegisteredClients(historical.href,{scope:'database'});}
 }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{if(process.argv.length!==3)throw Error('Non-secret options file required');console.log(JSON.stringify(await recoverRetainedSshWorkspace(read(process.argv[2]))));}
 catch(error){console.error(JSON.stringify({error:'Scoped retained SSH operation refused or incomplete; inspect its exact recorded state before retrying',type:error?.name??'Error'}));process.exitCode=1;}
}
