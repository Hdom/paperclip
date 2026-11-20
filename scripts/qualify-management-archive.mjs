import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, canonical } from "./__tests__/management-test-fixture.mjs";
import { verifiedArchive } from "./management-archive-reader.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const [archiveArg,expected,sourceSha,evidenceArg,...extra]=process.argv.slice(2);
if(!archiveArg||!expected?.match(/^[a-f0-9]{64}$/)||!sourceSha?.match(/^[a-f0-9]{40}$/)||extra.length)throw Error("management_archive_arguments_refused");
const archive=path.resolve(archiveArg),{tar,archiveBytes}=verifiedArchive(archive,expected);
const hash=b=>createHash("sha256").update(b).digest("hex");
const run=(command,args,options={})=>execFileSync(command,args,{cwd:root,encoding:"utf8",timeout:120000,maxBuffer:1024*1024,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:"C",LC_ALL:"C"},...options});
const listing=run("tar",["-tvf","-","--numeric-owner","--full-time"],{input:tar}).trim().split('\n');let total=0;const names=new Set();
for(const line of listing){const m=line.match(/^([-d])[rwxstST-]{9}\s+\d+\/\d+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+(management(?:\/[A-Za-z0-9_.-]+)*\/?)$/);if(!m||m[3].includes('..')||names.has(m[3]))throw Error('management_tar_entry_refused');names.add(m[3]);total+=Number(m[2]);if(total>32*1024*1024||names.size>80)throw Error('management_tar_bounds_refused')}
const f=fixture();
try{
 run("tar",["-xf","-","--no-same-owner","--no-same-permissions","-C",f.root],{input:tar});const extracted=path.join(f.root,"management");
 const bytes=readFileSync(path.join(extracted,"package-manifest.json")),manifest=JSON.parse(bytes);if(canonical(manifest)!==bytes.toString()||Object.keys(manifest).sort().join(',')!=='files,schema,sourceSha'||manifest.schema!=="paperclip.management-package.v1"||manifest.sourceSha!==sourceSha)throw Error('management_manifest_refused');
 const observed=[];function visit(dir,prefix=''){for(const name of readdirSync(dir)){const file=path.join(dir,name),s=lstatSync(file);if(s.isDirectory())visit(file,prefix+name+'/');else{if(!s.isFile()||s.nlink!==1)throw Error('management_extracted_type_refused');observed.push(prefix+name)}}}visit(extracted);
 if(observed.filter(n=>n!=='package-manifest.json').sort().join('\n')!==Object.keys(manifest.files).sort().join('\n'))throw Error('management_package_inventory_refused');
 for(const [name,info]of Object.entries(manifest.files)){if(!/^(?:entry\.mjs|server-closure\.json|ui\/(?:management(?:-assets|-ui-closure)?\.(?:html|json)|assets\/[A-Za-z0-9_-]+\.(?:js|css)|fonts\/(?:InterVariable|InterVariable-Italic|PaperMono-Variable)\.woff2))$/.test(name)||Object.keys(info).sort().join(',')!=='bytes,sha256')throw Error('management_package_path_refused');const b=readFileSync(path.join(extracted,name));if(b.length!==info.bytes||hash(b)!==info.sha256)throw Error('management_extracted_digest_refused')}
 const env={PATH:process.env.PATH,HOME:process.env.HOME,MANAGEMENT_PACKAGE_DIR:extracted};
 const unit=run(process.execPath,["--test","scripts/__tests__/management-only.test.mjs"],{env});
 if(evidenceArg){mkdirSync(path.resolve(evidenceArg),{recursive:true});env.MANAGEMENT_SCREENSHOT_DIR=path.resolve(evidenceArg)}
 const browser=run(process.execPath,["scripts/test-management-browser.mjs"],{env});
 const result={sourceSha,archiveSha256:expected,archiveBytes,extractedFiles:observed.length,actualArchiveCli:true,humanRefusal:true,runtimeImports:false,dispatch:false,productionAccess:false,browser:JSON.parse(browser.trim())};
 if(evidenceArg)writeFileSync(path.join(path.resolve(evidenceArg),"qualification.json"),JSON.stringify(result,null,2));process.stdout.write(unit+JSON.stringify(result)+"\n");
}finally{f.cleanup()}
