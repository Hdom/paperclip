import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, copyFileSync, chmodSync, lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const [sha,outputArg,...extra]=process.argv.slice(2);
if(process.platform!=="linux"||!sha?.match(/^[a-f0-9]{40}$/)||!outputArg||extra.length)throw Error("management_package_arguments_refused");
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|HOME|USER|LOGNAME|LANG|LC_ALL|CI|COREPACK_HOME|PNPM_HOME)$/.test(key)));
const run=(command,args,options={})=>execFileSync(command,args,{cwd:root,env,encoding:"utf8",timeout:120000,maxBuffer:1024*1024,...options});
if(run("git",["rev-parse","HEAD"]).trim()!==sha||run("git",["status","--porcelain","--untracked-files=all"]).trim())throw Error("management_package_requires_clean_exact_source");
const output=path.resolve(outputArg);if(existsSync(output)||output===root||root.startsWith(output+path.sep))throw Error("management_package_output_refused");
run(process.execPath,[path.join(root,"scripts/build-management.mjs")],{stdio:"inherit"});
if(run("git",["status","--porcelain","--untracked-files=all"]).trim())throw Error("management_build_changed_source");
mkdirSync(output,{recursive:true,mode:0o700});const stage=mkdtempSync(path.join(output,".management-stage-")),payload=path.join(stage,"management");mkdirSync(payload,{mode:0o755});
function canonical(v){return Array.isArray(v)?`[${v.map(canonical)}]`:v&&typeof v==="object"?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`)}}`:JSON.stringify(v)}
function hash(bytes){return createHash("sha256").update(bytes).digest("hex")}
try{
 const assetMap=JSON.parse(readFileSync(path.join(root,"ui/dist-management/management-assets.json"),"utf8"));
 const inputs=[['server/dist-management/entry.mjs','entry.mjs'],['server/dist-management/closure.json','server-closure.json'],['ui/dist-management/management-ui-closure.json','ui/management-ui-closure.json'],['ui/dist-management/management-assets.json','ui/management-assets.json'],...assetMap.assets.map(a=>[`ui/dist-management/${a.file}`,`ui/${a.file}`])];
 const files={};for(const [source,target]of inputs){
  const src=path.join(root,source),stat=lstatSync(src);if(!stat.isFile()||stat.nlink!==1||realpathSync(src)!==src||stat.size>8*1024*1024)throw Error("management_package_input_refused");
  const dest=path.join(payload,target);mkdirSync(path.dirname(dest),{recursive:true,mode:0o755});copyFileSync(src,dest);chmodSync(dest,0o644);const bytes=readFileSync(dest);files[target]={sha256:hash(bytes),bytes:bytes.length};
 }
 writeFileSync(path.join(payload,"package-manifest.json"),canonical({schema:"paperclip.management-package.v1",sourceSha:sha,files}),{mode:0o644});
 const archive=`paperclip-management-${sha.slice(0,12)}.tar.gz`;
 run("tar",["--sort=name","--mtime=@0","--owner=0","--group=0","--numeric-owner","-czf",path.join(output,archive),"-C",stage,"management"]);
 const bytes=readFileSync(path.join(output,archive)),digest=hash(bytes);writeFileSync(path.join(output,"SHA256SUMS"),`${digest}  ${archive}\n`,{mode:0o644});
 process.stdout.write(JSON.stringify({sourceSha:sha,archive,sha256:digest,bytes:bytes.length,includesCredentials:false,includesData:false,deploys:false})+"\n");
}finally{if(path.dirname(stage)!==output||!path.basename(stage).startsWith('.management-stage-'))throw Error('management_stage_cleanup_refused');rmSync(stage,{recursive:true,force:true})}
