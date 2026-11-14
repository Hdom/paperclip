import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cloneUrl,requireCloneIdentity } from './qualify-database-upgrade.mjs';
const roles=['coordinator','implementer','reviewer'];
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function validateNativeRecovery(config,expected){
 if(!config||!config.companyId||Object.keys(expected??{}).sort().join(',')!==[...roles].sort().join(','))throw new Error('Three expected public fingerprints required');
 for(const role of roles){const app=config.apps?.[role];if(!app||app.privateKeyPath||!app.signingKeySecret||!Number.isSafeInteger(app.signingKeySecret.version)||app.signingKeySecret.version<1||!Number.isSafeInteger(app.appId)||app.appId<1||typeof app.signingKeySecret.secretId!=='string'||!/^SHA256:[A-Za-z0-9+/]{43}=$/.test(expected[role]))throw new Error('Pinned native signing reference required');}
}
export async function verifyNativeRecovery(options){
 const config=read(options.nativeConfig);validateNativeRecovery(config,options.expectedFingerprints);
 const root=fs.realpathSync(options.payload);
 if(!/^[a-f0-9]{40}$/.test(options.sourceCommit)||read(path.join(root,'node_modules/@paperclipai/server/dist/build-info.json')).commit!==options.sourceCommit)throw new Error('Release identity mismatch');
 const instance=read(options.config);
 const url=cloneUrl(instance.database.connectionString,options.cloneDatabase,read(options.restoreReceipt));
 const configuredMaster=path.resolve(instance.secrets?.localEncrypted?.keyFilePath??path.join(path.dirname(options.config),'secrets/master.key'));
 if(options.masterKeyFile!==configuredMaster)throw new Error('Recovery master path differs from native configuration');
 const master=options.masterKeyFile,info=fs.lstatSync(master);
 if(fs.realpathSync(master)!==master||!info.isFile()||info.nlink!==1||(info.mode&0o077)||info.size>256||process.env.PAPERCLIP_SECRETS_MASTER_KEY)throw new Error('Existing protected native master key required');
 const previous=process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
 const entry=path.join(root,'node_modules/@paperclipai/db/dist/index.js'),require=createRequire(entry),postgres=require('postgres');
 const probe=postgres(url,{max:1});
 let dbModule;
 try{
  await requireCloneIdentity(probe,options.cloneDatabase);
  const before=hash(master);
  // Resolve only the released service module. No application/server factory is started.
  process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE=master;
  dbModule=await import(pathToFileURL(entry).href);
  const {secretService}=await import(pathToFileURL(path.join(root,'node_modules/@paperclipai/server/dist/services/secrets.js')).href);
  const secrets=secretService(dbModule.createDb(url));
  const fingerprints={};
  for(const role of roles){
   const app=config.apps[role],reference=app.signingKeySecret;
   const signed=await secrets.signControllerGitHubAppJwt(config.companyId,reference.secretId,reference.version,role,app.appId);
   try{
    if(signed.publicFingerprint!==options.expectedFingerprints[role])throw new Error('Restored native public fingerprint differs');
    fingerprints[role]=signed.publicFingerprint;
   }finally{signed.jwt='';} // No JWT is returned, saved or printed, including refusal paths.
  }
  if(hash(master)!==before)throw new Error('Native encryption master changed');
  const result={sourceCommit:options.sourceCommit,cloneDatabase:options.cloneDatabase,publicFingerprints:fingerprints,masterKeyUnchanged:true,serverWorkersStarted:false,liveDatabaseModified:false,jwtsDisclosed:false};
  const fd=fs.openSync(options.receipt,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(result,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return result;
 }finally{
  if(previous===undefined)delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE=previous;
  await probe.end({timeout:5});
  if(dbModule)await dbModule.closeRegisteredClients(url,{scope:'database'});
 }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{if(process.getuid?.()!==0||process.argv.length!==3)throw new Error('Controller root operator and non-secret options file required');console.log(JSON.stringify(await verifyNativeRecovery(read(process.argv[2]))));}
 catch(error){console.error(JSON.stringify({error:'Restored native signing qualification failed',type:error?.name??'Error'}));process.exitCode=1;}
}
