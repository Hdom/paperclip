import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cloneUrl, requireCloneIdentity, requireUpToDate, qualify } from './qualify-database-upgrade.mjs';
const hash='a'.repeat(64), sha='b'.repeat(40), clone='paperclip_gitops_test';
const restored={cloneDatabase:clone,restoreVerified:true,liveDatabaseModified:false,sha256:hash};
test('connection startup overrides cannot redirect qualification to production',()=>{
 for(const suffix of ['?database=paperclip','?user=postgres','#fragment','?host=remote','?sslmode=disable'])
  assert.throws(()=>cloneUrl('postgres://user:canary@localhost/paperclip'+suffix,clone,restored));
 assert.throws(()=>cloneUrl('postgres://user@remote/paperclip',clone,restored));
 assert.throws(()=>cloneUrl('postgres://user@localhost/'+clone,clone,restored));
 assert.equal(new URL(cloneUrl('postgres://user@localhost/paperclip',clone,restored)).pathname,'/'+clone);
});
test('actual database identity must be the owned restored clone',async()=>{
 await assert.rejects(requireCloneIdentity(async()=>[{name:'paperclip'}],clone));
 await requireCloneIdentity(async()=>[{name:clone}],clone);
});
test('upToDate is a distinct union without pendingMigrations',()=>{
 requireUpToDate({status:'upToDate'});
 assert.throws(()=>requireUpToDate({status:'needsMigrations',pendingMigrations:[]}));
});
function fixture(actualDatabase=clone) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'paperclip-qualifier-'));
 const write=(name,text)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
 const state=write('state.json',JSON.stringify({name:actualDatabase,history:[{id:1,hash,created_at:'1'}],writes:0}));
 write('payload/node_modules/@paperclipai/server/dist/build-info.json',JSON.stringify({commit:sha}));
 write('payload/node_modules/postgres/package.json',JSON.stringify({name:'postgres',main:'index.cjs'}));
 write('payload/node_modules/postgres/index.cjs',`const fs=require('fs'); module.exports=()=>{const read=()=>JSON.parse(fs.readFileSync(${JSON.stringify(state)})); const client=async(strings)=>{const query=strings.join('');const state=read();if(query.includes('current_database'))return[{name:state.name}];if(query.includes('pg_constraint'))return[{definition:"scope = 'controller'"}];return state.history;};client.unsafe=async()=>[{count:1,digest:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}];client.end=async()=>{};return client;}`);
 write('payload/node_modules/@paperclipai/db/package.json',JSON.stringify({type:'module'}));
 write('payload/node_modules/@paperclipai/db/dist/index.js',`import fs from 'node:fs';const file=${JSON.stringify(state)};const read=()=>JSON.parse(fs.readFileSync(file));export async function inspectMigrations(){return read().writes?{status:'upToDate'}:{status:'needsMigrations',pendingMigrations:['0466_scope']};}export async function applyPendingMigrations(){const state=read();if(!state.writes){state.writes++;state.history.push({id:2,hash:'native',created_at:'2'});fs.writeFileSync(file,JSON.stringify(state));}}`);
 const config=write('config.json',JSON.stringify({database:{connectionString:'postgres://synthetic:DO_NOT_ECHO@localhost/paperclip'}}));
 const options={payload:path.join(root,'payload'),sourceCommit:sha,config,restoreReceipt:write('restore.json',JSON.stringify(restored)),cloneDatabase:clone,expectedJournalCount:1,expectedBridgeHash:hash,invariants:write('invariants.json',JSON.stringify(Object.fromEntries(['companies','agents','projects','issues','issue_comments','company_secrets','company_secret_versions'].map(name=>[name,{columns:['id'],count:1,digest:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}])))),receipt:path.join(root,'result.json')};
 return {root,state,write,options,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('qualified upgrade preserves receipts/data and proves a no-op second apply',async()=>{
 const f=fixture();try{const result=await qualify(f.options);assert.equal(result.secondApplyNoOp,true);assert.equal(result.preservedTables.length,7);assert.equal(result.liveDatabaseModified,false);assert.equal(JSON.parse(fs.readFileSync(f.state)).writes,1);assert.equal(fs.statSync(f.options.receipt).mode&0o777,0o600);}finally{f.cleanup();}
});
test('wrong actual database is rejected before migration imports can mutate',async()=>{
 const f=fixture('paperclip');try{await assert.rejects(qualify(f.options));assert.equal(JSON.parse(fs.readFileSync(f.state)).writes,0);assert.equal(fs.existsSync(f.options.receipt),false);}finally{f.cleanup();}
});
test('CLI errors do not disclose malformed config or credential text',()=>{
 const f=fixture();try{fs.writeFileSync(f.options.config,'{"credential":"PRIVATE_CANARY');const options=f.write('options.json',JSON.stringify(f.options));const result=spawnSync(process.execPath,[fileURLToPath(new URL('./qualify-database-upgrade.mjs',import.meta.url)),options],{encoding:'utf8'});assert.equal(result.status,1);assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE_CANARY|DO_NOT_ECHO/);assert.match(result.stderr,/Isolated upgrade qualification failed/);}finally{f.cleanup();}
});

test('missing retained tables or invalid digest cannot omit the data proof',async()=>{
 for(const baseline of [{},{companies:{columns:['id'],count:1,digest:'a'.repeat(32)}}]){const f=fixture();try{fs.writeFileSync(f.options.invariants,JSON.stringify(baseline));await assert.rejects(qualify(f.options));assert.equal(JSON.parse(fs.readFileSync(f.state)).writes,0);assert.equal(fs.existsSync(f.options.receipt),false);}finally{f.cleanup();}}
});

test('a malformed full baseline or changed retained data cannot produce a success receipt',async()=>{
 for(const malformed of [true,false]){const f=fixture();try{const baseline=JSON.parse(fs.readFileSync(f.options.invariants));baseline.companies.digest=malformed?'not-a-digest':'b'.repeat(32);fs.writeFileSync(f.options.invariants,JSON.stringify(baseline));await assert.rejects(qualify(f.options));assert.equal(fs.existsSync(f.options.receipt),false);if(malformed)assert.equal(JSON.parse(fs.readFileSync(f.state)).writes,0);}finally{f.cleanup();}}
});
