import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [output,sourceCommit]=process.argv.slice(2);
if(!output||!path.isAbsolute(output)||!sourceCommit||!/^[a-f0-9]{40}$/.test(sourceCommit)||fs.existsSync(output))throw new Error('Expected a new absolute output directory and exact commit');
if(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==sourceCommit || execFileSync('git',['status','--porcelain','--','scripts/operations'],{cwd:root,encoding:'utf8'}).trim())throw new Error('Operator source is not the clean pinned commit');
fs.mkdirSync(output,{recursive:true});
const source=path.join(root,'scripts/operations');
const names=['qualify-database-upgrade.mjs','prepare-database-upgrade.py','verify-utility-provenance.py','guest-exec.py','Invoke-PaperclipOperator.ps1','README.md','observed-deployment-inventory.json','deployment-examples'];
for(const name of names)fs.cpSync(path.join(source,name),path.join(output,name),{recursive:true,dereference:false,filter:file=>!file.split(path.sep).includes('__pycache__')&&!file.endsWith('.pyc')});
const bundled = await build({metafile:true,absWorkingDir:root,alias:{'@paperclipai/shared/home-paths':path.join(root,'packages/shared/src/home-paths.ts')},entryPoints:['scripts/operations/activate-prepared-release.ts'],outfile:path.join(output,'activate-prepared-release.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',logLevel:'warning'});
const inputs=Object.keys(bundled.metafile.inputs);
for(const file of inputs){const resolved=path.resolve(root,file);if(!resolved.startsWith(root+path.sep))throw new Error('Bundled input escapes checkout');execFileSync('git',['ls-files','--error-unmatch','--',file],{cwd:root,stdio:'pipe'});}
if(execFileSync('git',['status','--porcelain','--',...inputs],{cwd:root,encoding:'utf8'}).trim())throw new Error('Bundled CLI/shared source differs from the pinned commit');
const hashes={};
function inspect(dir){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),stat=fs.lstatSync(file);if(stat.isDirectory())inspect(file);else if(stat.isFile())hashes[path.relative(output,file)]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');else throw new Error('Special file in operator tools');}}
inspect(output);
fs.writeFileSync(path.join(output,'operator-tools-manifest.json'),JSON.stringify({repository:'Hdom/paperclip',sourceCommit,files:hashes,limitations:['Does not authorize a privileged action','Does not install services or grant permissions','Does not start an agent or connector run']},null,2)+'\n');
console.log('Built versioned operator tools from '+sourceCommit);
