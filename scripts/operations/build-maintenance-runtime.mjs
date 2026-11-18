/** Build the independent operator runtime, never from a selected candidate.
 * No production files are read or modified by this builder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export async function buildRuntime(output,{qualification=false}={}){
  if(!path.isAbsolute(output)||fs.existsSync(output))throw Error('New absolute output required');
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  if(!qualification&&execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim())throw Error('Release operator bundle requires clean exact source');
  fs.mkdirSync(output,{mode:0o700});
  const entry=path.join(root,'scripts/operations/maintenance-offline-runtime.ts');
  const bundle=await build({absWorkingDir:root,entryPoints:[entry],outfile:path.join(output,'runtime.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',metafile:true,
    alias:{'@paperclipai/db/work-signals':path.join(root,'packages/db/src/work-signals.ts'),'@paperclipai/db':path.join(root,'scripts/operations/maintenance-db-entry.ts'),
      'drizzle-orm':fs.realpathSync(path.join(root,'server/node_modules/drizzle-orm'))},
    banner:{js:"import { createRequire as _createRequire } from 'node:module'; const _nativeRequire=_createRequire(import.meta.url); const require=(name)=>{if(!name.startsWith('node:')&&!"+JSON.stringify(builtinModules)+".includes(name))throw Error('Non-builtin runtime dependency refused');return _nativeRequire(name);};"},logLevel:'warning'});
  const builtins=new Set([...builtinModules,...builtinModules.map(n=>'node:'+n)]);
  for(const output of Object.values(bundle.metafile.outputs))for(const dependency of output.imports)if(dependency.external&&!builtins.has(dependency.path))throw Error('External runtime dependency: '+dependency.path);
  const migrations=path.join(root,'packages/db/src/migrations');
  fs.mkdirSync(path.join(output,'migrations/meta'),{recursive:true});
  for(const name of fs.readdirSync(migrations).filter(n=>/^\d{4}_.+\.sql$/.test(n)))fs.copyFileSync(path.join(migrations,name),path.join(output,'migrations',name));
  fs.copyFileSync(path.join(migrations,'meta/_journal.json'),path.join(output,'migrations/meta/_journal.json'));
  fs.copyFileSync(process.execPath,path.join(output,'node'));fs.chmodSync(path.join(output,'node'),0o700);
  fs.copyFileSync(path.join(root,'scripts/operations/maintenance-host.py'),path.join(output,'maintenance-host.py'));
  const files={};
  const walk=dir=>{for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name);const stat=fs.lstatSync(file);if(stat.isDirectory())walk(file);else if(stat.isFile()&&stat.nlink===1)files[path.relative(output,file)]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');else throw Error('Unsafe operator output');}};
  walk(output);
  const manifest={schema:'paperclip.maintenance-operator-bundle.v1',repository:'Hdom/paperclip',sourceCommit:commit,qualificationOnly:qualification,nodeVersion:process.version,files,
    sourceInputs:Object.keys(bundle.metafile.inputs).sort(),limitations:['Not installed or authorized for production','Requires separately reviewed protected host launcher and database identity','No candidate code or signing-key resolution']};
  fs.writeFileSync(output+'.manifest.json',JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
  return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [output,...flags]=process.argv.slice(2);if(flags.some(f=>f!=='--qualification'))throw Error('Unknown build option');
  const manifest=await buildRuntime(output,{qualification:flags.includes('--qualification')});
  console.log(JSON.stringify({output,sourceCommit:manifest.sourceCommit,qualificationOnly:manifest.qualificationOnly,files:Object.keys(manifest.files).length}));
}
