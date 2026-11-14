import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { test,after } from 'node:test';
import { build } from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const compiled=fs.mkdtempSync(path.join(os.tmpdir(),'paperclip-activation-source-'));
after(()=>fs.rmSync(compiled,{recursive:true,force:true}));
const outfile=path.join(compiled,'entry.mjs');
await build({absWorkingDir:root,alias:{'@paperclipai/shared/home-paths':path.join(root,'packages/shared/src/home-paths.ts')},stdin:{contents:"export {activatePreparedRelease} from './scripts/operations/activate-prepared-release.ts'; export {initializeInstallStore,resolveInstallStorePaths,writeInstallManifestAtomic,flipCurrentAtomic} from './cli/src/install-store.ts';",resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',target:'node24',outfile});
const lib=await import(pathToFileURL(outfile).href);
function fixture(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'paperclip-activation-fixture-'));
 const old='1'.repeat(40),next='2'.repeat(40);
 const paths=lib.resolveInstallStorePaths({paperclipHome:temp,homeDir:temp});lib.initializeInstallStore(paths);
 const payload=sha=>path.join(paths.installsRoot,'git',sha.slice(0,12));
 for(const sha of [old,next]){fs.mkdirSync(path.join(payload(sha),'node_modules/@paperclipai/server/dist'),{recursive:true});fs.mkdirSync(path.join(payload(sha),'node_modules/paperclipai'),{recursive:true});fs.writeFileSync(path.join(payload(sha),'node_modules/@paperclipai/server/dist/build-info.json'),JSON.stringify({commit:sha}));fs.writeFileSync(path.join(payload(sha),'node_modules/paperclipai/package.json'),JSON.stringify({version:'1.0.0'}));}
 lib.writeInstallManifestAtomic({schemaVersion:1,source:'git',version:'1.0.0',channel:'pinned',payloadPath:payload(old),repo:'Hdom/paperclip',ref:old,sha:old,installedAt:new Date().toISOString(),previous:[]},paths);lib.flipCurrentAtomic(payload(old),paths);
 const manifest={repository:'Hdom/paperclip',sourceCommit:next,workflowCommit:next,workflowRun:'123',packageVersion:'1.0.0'};
 const file=path.join(temp,'release-manifest.json');const save=()=>fs.writeFileSync(file,JSON.stringify(manifest));save();
 return {paths,old,next,payload,manifest,save,input:{paperclipHome:temp,homeDir:temp,expectedCurrentSha:old,newSourceSha:next,releaseManifestPath:file,expectedWorkflowRun:'123'},cleanup:()=>fs.rmSync(temp,{recursive:true,force:true})};
}
test('activation uses canonical lock/store and is idempotent without pruning old payload',async()=>{
 const f=fixture();try{assert.equal((await lib.activatePreparedRelease(f.input)).activated,true);assert.equal(fs.realpathSync(f.paths.currentPath),f.payload(f.next));assert.equal(JSON.parse(fs.readFileSync(f.paths.manifestPath)).sha,f.next);assert.equal((await lib.activatePreparedRelease(f.input)).replay,true);assert.ok(fs.existsSync(f.payload(f.old)));}finally{f.cleanup();}
});
test('unexpected source/current/workflow identities cannot change selection',async()=>{
 for(const kind of ['current','repository','workflow','stamp']){
  const f=fixture();try{
   if(kind==='current')f.input.expectedCurrentSha='3'.repeat(40);
   if(kind==='repository'){f.manifest.repository='elsewhere/project';f.save();}
   if(kind==='workflow')f.input.expectedWorkflowRun='456';
   if(kind==='stamp')fs.writeFileSync(path.join(f.payload(f.next),'node_modules/@paperclipai/server/dist/build-info.json'),JSON.stringify({commit:'4'.repeat(40)}));
   await assert.rejects(lib.activatePreparedRelease(f.input));assert.equal(fs.realpathSync(f.paths.currentPath),f.payload(f.old));assert.equal(JSON.parse(fs.readFileSync(f.paths.manifestPath)).sha,f.old);
  }finally{f.cleanup();}
 }
});
test('replay reconciles a link flip interrupted before manifest commit',async()=>{
 const f=fixture();try{lib.flipCurrentAtomic(f.payload(f.next),f.paths);const result=await lib.activatePreparedRelease(f.input);assert.equal(result.activated,true);assert.equal(JSON.parse(fs.readFileSync(f.paths.manifestPath)).sha,f.next);}finally{f.cleanup();}
});
