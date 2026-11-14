import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateNativeRecovery} from './verify-native-key-recovery.mjs';
const roles=['coordinator','implementer','reviewer'];
function fixture(){return {config:{companyId:'synthetic-company',apps:Object.fromEntries(roles.map((role,index)=>[role,{appId:index+1,signingKeySecret:{secretId:'synthetic-'+role,version:1}}]))},expected:Object.fromEntries(roles.map(role=>[role,'SHA256:'+'a'.repeat(43)+'=']))};}
test('recovery requires all three pinned native identities and public fingerprints',()=>{const {config,expected}=fixture();validateNativeRecovery(config,expected);for(const mutate of [(c,e)=>delete e.reviewer,(c,e)=>c.apps.reviewer.privateKeyPath='/legacy/key.pem',(c,e)=>c.apps.implementer.signingKeySecret.version='latest',(c,e)=>e.coordinator='PRIVATE_CANARY']){const {config,expected}=fixture();mutate(config,expected);assert.throws(()=>validateNativeRecovery(config,expected));}});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {verifyNativeRecovery} from './verify-native-key-recovery.mjs';
function recoveryFixture(name='paperclip_gitops_recovery',badFingerprint=false){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'paperclip-native-recovery-'));
 const put=(name,content)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);return file;};
 const sha='b'.repeat(40),{config:native,expected}=fixture();
 const state=put('state.json',JSON.stringify({name,probeClosed:false,dbClosed:false}));
 const marker=path.join(root,'signer-imported');
 const master=put('master.key','a'.repeat(64));fs.chmodSync(master,0o600);
 const config=put('config.json',JSON.stringify({database:{connectionString:'postgres://synthetic:DO_NOT_ECHO@localhost/paperclip'},secrets:{localEncrypted:{keyFilePath:master}}}));
 put('payload/node_modules/postgres/package.json',JSON.stringify({main:'index.cjs'}));
 put('payload/node_modules/postgres/index.cjs',`const fs=require('fs');const file=${JSON.stringify(state)};module.exports=()=>{const client=async()=>[{name:JSON.parse(fs.readFileSync(file)).name}];client.end=async()=>{const state=JSON.parse(fs.readFileSync(file));state.probeClosed=true;fs.writeFileSync(file,JSON.stringify(state));};return client;};`);
 put('payload/node_modules/@paperclipai/db/package.json','{"type":"module"}');
 put('payload/node_modules/@paperclipai/db/dist/index.js',`import fs from 'node:fs';const file=${JSON.stringify(state)};export function createDb(url){return{url};}export async function closeRegisteredClients(){const state=JSON.parse(fs.readFileSync(file));state.dbClosed=true;fs.writeFileSync(file,JSON.stringify(state));}`);
 put('payload/node_modules/@paperclipai/server/package.json','{"type":"module"}');
 put('payload/node_modules/@paperclipai/server/dist/build-info.json',JSON.stringify({commit:sha}));
 put('payload/node_modules/@paperclipai/server/dist/services/secrets.js',`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'imported');export const signed=[];export function secretService(){return{async signControllerGitHubAppJwt(company,id,version,role,app){const value={jwt:'PRIVATE_JWT_CANARY',publicFingerprint:${badFingerprint?"'SHA256:'+'b'.repeat(43)+'='":"'SHA256:'+'a'.repeat(43)+'='"}};signed.push(value);return value;}};}`);
 const options={payload:path.join(root,'payload'),sourceCommit:sha,config,cloneDatabase:'paperclip_gitops_recovery',restoreReceipt:put('restore.json',JSON.stringify({cloneDatabase:'paperclip_gitops_recovery',restoreVerified:true,liveDatabaseModified:false,sha256:'a'.repeat(64)})),nativeConfig:put('native.json',JSON.stringify(native)),masterKeyFile:master,expectedFingerprints:expected,receipt:path.join(root,'result.json')};
 return{root,master,state,marker,options,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('restored dedicated signer proof returns public fingerprints only and restores environment',async()=>{
 const f=recoveryFixture(),before=process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE='synthetic-prior';
 try{const result=await verifyNativeRecovery(f.options);assert.equal(result.masterKeyUnchanged,true);assert.equal(result.serverWorkersStarted,false);assert.doesNotMatch(JSON.stringify(result)+fs.readFileSync(f.options.receipt),/PRIVATE_JWT_CANARY|DO_NOT_ECHO/);assert.equal(process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE,'synthetic-prior');assert.deepEqual(JSON.parse(fs.readFileSync(f.state)),{name:'paperclip_gitops_recovery',probeClosed:true,dbClosed:true});}finally{if(before===undefined)delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE=before;f.cleanup();}
});
test('wrong database stops before signer import or master-byte access',async()=>{
 const f=recoveryFixture('paperclip'),read=fs.readFileSync;let reads=0;fs.readFileSync=function(file,...args){if(file===f.master)reads++;return read.call(this,file,...args);};
 try{await assert.rejects(verifyNativeRecovery(f.options));assert.equal(reads,0);assert.equal(fs.existsSync(f.marker),false);assert.equal(fs.existsSync(f.options.receipt),false);assert.equal(JSON.parse(read(f.state)).probeClosed,true);}finally{fs.readFileSync=read;f.cleanup();}
});
test('fingerprint mismatch creates no receipt and closes clone connections',async()=>{
 const f=recoveryFixture('paperclip_gitops_recovery',true),before=process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
 try{await assert.rejects(verifyNativeRecovery(f.options));assert.equal(fs.existsSync(f.options.receipt),false);assert.equal(process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE,before);const state=JSON.parse(fs.readFileSync(f.state));assert.equal(state.probeClosed,true);assert.equal(state.dbClosed,true);}finally{f.cleanup();}
});
