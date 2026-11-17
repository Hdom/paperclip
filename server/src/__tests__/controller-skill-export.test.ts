import { writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { execFileSync } from "node:child_process";
import { readCheckedCacheFile } from "../services/checked-cache-file.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, companySkills, companySkillVersions, createDb, heartbeatRuns } from "@paperclipai/db";
import { assertControllerSourcePathAllowed } from "@paperclipai/adapter-utils/controller-source-protection";
import { stageCodexHomeForSync } from "../../../packages/adapters/codex-local/src/server/codex-home.js";
import { companySkillService } from "../services/company-skills.js";
import { withSkillActor } from "../services/skill-access.js";
import { withSkillVersionCacheLock, SkillCacheBusy } from "../services/skill-version-cache.js";
import { notFound } from "../errors.js";
import { controllerSkillExporter } from "../services/controller-skill-export.js";
import { skillPackageStore, skillPackagePaths } from "../services/skill-package-store.js";
import { skillPackageManifest, skillPackageManifestBytes, verifySkillPackageDirectory } from "../services/skill-package-files.js";
import * as storageModule from "../storage/index.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";

import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Node built-in named exports are snapshots of the mutable default object.
// Route named opens through that object so inode-read/race instrumentation also
// observes the real adapter-utils descriptor reader, not just server callers.
vi.mock("node:fs/promises",async importOriginal=>{
  const actual=await importOriginal<typeof import("node:fs/promises")>();
  const native=actual as typeof actual & {default:typeof actual};
  return {...actual,open:(...args:Parameters<typeof actual.open>)=>native.default.open(...args)};
});
const accessFaults=vi.hoisted(()=>new Map<string,()=>void>());
vi.mock("../services/skill-access.js",async importOriginal=>{
  const actual=await importOriginal<typeof import("../services/skill-access.js")>();
  return {...actual,skillAccessService:(...args:Parameters<typeof actual.skillAccessService>)=>{
    const access=actual.skillAccessService(...args);
    return {...access,assertSkill:async(companyId:string,skillId:string)=>{accessFaults.get(skillId)?.();return access.assertSkill(companyId,skillId);}};
  }};
});
const support=await getEmbeddedPostgresTestSupport();
(support.supported?describe:describe.skip)("protected pinned skill delivery",()=>{
  let database:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>,root:string,assets:string,home:string;
  const cleanups:Array<()=>Promise<void>>=[];
  beforeAll(async()=>{database=await startEmbeddedPostgresTestDatabase("protected-skills-");db=createDb(database.connectionString);},90000);
  afterAll(async()=>{await database?.cleanup();});
  beforeEach(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),"protected-native-skill-"));assets=path.join(root,"controller-assets");home=path.join(root,"managed-home");
    await fs.mkdir(home);await fs.mkdir(path.join(root,"keys"));await fs.writeFile(path.join(root,"keys/signing.pem"),"synthetic-private-signing-sentinel",{mode:0o600});
    vi.stubEnv("PAPERCLIP_HOME",path.join(root,"instance-home"));vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS","1");vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG","");
    vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS",JSON.stringify([assets,home]));vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS",JSON.stringify([home]));
    vi.stubEnv("PAPERCLIP_CONTROLLER_PROTECTED_PATHS",JSON.stringify([path.join(root,"keys")]));vi.stubEnv("PAPERCLIP_CONTROLLER_ASSET_SNAPSHOT_ROOT",assets);
  });
  afterEach(async()=>{accessFaults.clear();for(const cleanup of cleanups.splice(0))await cleanup();vi.unstubAllEnvs();vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});
  async function fixture(){
    const companyId=randomUUID(),agentId=randomUUID(),runId=randomUUID(),skillId=randomUUID(),key=`company/${companyId}/assigned`;
    await db.insert(companies).values({id:companyId,name:"Protected fixture",issuePrefix:`S${companyId.replaceAll("-","")}`});
    await db.insert(agents).values({id:agentId,companyId,name:"Assigned worker",role:"engineer",adapterType:"codex_local",status:"idle"});
    await db.insert(companySkills).values({id:skillId,companyId,key,slug:"assigned",name:"Assigned",markdown:"# Assigned",sourceType:"managed"});
    const versions=[];
    for(const n of [1,2]){
      const [v]=await db.insert(companySkillVersions).values({companyId,companySkillId:skillId,revisionNumber:n,fileInventory:[
        {path:"SKILL.md",kind:"skill",content:`---\nname: assigned\ndescription: revision ${n}\n---\n# Pinned ${n}\n`},
        {path:"references/example.md",kind:"reference",content:`reference ${n}`},
      ]}).returning();versions.push(v!);
    }
    await db.update(companySkills).set({currentVersionId:versions[1].id}).where(eq(companySkills.id,skillId));
    await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,status:"running",contextSnapshot:{skillVersions:{[key]:versions[0].id},skillSelectionSnapshot:true}});
    const actor={type:"agent" as const,companyId,agentId,runId,source:"agent_jwt" as const};
    const binding={agentId,runId,onCleanup:(cleanup:()=>Promise<void>)=>{cleanups.push(cleanup);}};
    const selection={companyId,skillId,key,versionId:versions[0].id};
    return{companyId,agentId,runId,skillId,key,versions,actor,binding,selection};
  }
  async function packageFixture(){
    const f=await fixture();
    const storage=createStorageService(createLocalDiskStorageProvider(path.join(root,"objects")));
    vi.spyOn(storageModule,"getStorageService").mockReturnValue(storage);
    const store=skillPackageStore(db,storage),files=f.versions[0].fileInventory;
    const snapshot=await store.prepare(f.companyId,files);
    await db.update(companySkillVersions).set({packageSnapshotId:snapshot,fileInventory:[]}).where(eq(companySkillVersions.id,f.versions[0].id));
    return {...f,store,files,snapshot,paths:skillPackagePaths(f.companyId,snapshot)};
  }
  async function countSentinelReads(filename:string,beforeOpen?:(filename:string)=>Promise<void>){
    const sentinel=await fs.stat(filename),open=fs.open.bind(fs),readFile=fs.readFile.bind(fs);let reads=0;
    vi.spyOn(fs,"readFile").mockImplementation((async(...args:Parameters<typeof fs.readFile>)=>{
      if(typeof args[0]==="string"){
        const stat=await fs.stat(args[0]).catch(()=>null);
        if(stat?.dev===sentinel.dev&&stat.ino===sentinel.ino)reads++;
      }
      return readFile(...args);
    }) as typeof fs.readFile);
    vi.spyOn(fs,"open").mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
      await beforeOpen?.(String(args[0]));const handle=await open(...args),stat=await handle.stat();
      if(stat.dev===sentinel.dev&&stat.ino===sentinel.ino){
        for(const method of ["read","readFile","createReadStream"] as const){
          const original=handle[method].bind(handle);
          vi.spyOn(handle,method).mockImplementation(((...values:unknown[])=>{reads++;return (original as (...args:unknown[])=>unknown)(...values);}) as never);
        }
      }
      return handle;
    });
    return ()=>reads;
  }
  it.each(["payload","manifest"])("never reads a protected sentinel through an actual package-backed %s hardlink",async kind=>{
    const f=await packageFixture();
    if(kind==="payload")await f.store.withPackage(f.companyId,f.snapshot,async()=>{});
    const target=kind==="payload"?path.join(f.paths.directory,"SKILL.md"):f.paths.manifest;
    const expected=kind==="payload"?Buffer.from(f.files[0].content):skillPackageManifestBytes(skillPackageManifest(f.files));
    const sentinel=path.join(root,"keys/package-sentinel");await fs.writeFile(sentinel,expected,{mode:0o600});
    await fs.rm(target,{force:true});await fs.link(sentinel,target);const reads=await countSentinelReads(sentinel);
    const exported=await withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,f.binding).exportVersion(f.selection));
    expect(await fs.readFile(path.join(exported,"SKILL.md"),"utf8")).toContain("Pinned 1");
    expect(reads()).toBe(0);
  });
  it("rejects a manifest-verifier hardlink before hashing protected sentinel bytes",async()=>{
    const f=await fixture(),directory=path.join(root,"verify"),sentinel=path.join(root,"keys/verify-sentinel");
    await fs.mkdir(directory);await fs.writeFile(sentinel,"safe",{mode:0o600});await fs.link(sentinel,path.join(directory,"SKILL.md"));
    const reads=await countSentinelReads(sentinel);
    expect(await verifySkillPackageDirectory(directory,skillPackageManifest([{path:"SKILL.md",kind:"skill",content:"safe"}]).files)).toBe(false);
    expect(reads()).toBe(0);
  });
  it.each(["final symlink","parent swap","FIFO"])("refuses %s before consuming any sentinel bytes",async kind=>{
    const parent=path.join(root,"reader-cache"),sentinel=path.join(root,"keys/payload"),target=path.join(parent,"payload");
    await fs.mkdir(parent);await fs.writeFile(sentinel,"safe",{mode:0o600});
    if(kind==="final symlink")await fs.symlink(sentinel,target);
    if(kind==="FIFO")execFileSync("mkfifo",[target]);
    if(kind==="parent swap")await fs.writeFile(target,"safe",{mode:0o600});
    let swapped=false;
    const reads=await countSentinelReads(sentinel,async filename=>{
      if(kind==="parent swap"&&filename===target&&!swapped){swapped=true;await fs.rename(parent,`${parent}-old`);await fs.symlink(path.join(root,"keys"),parent);}
    });
    await expect(readCheckedCacheFile(target,4,4)).rejects.toThrow();expect(reads()).toBe(0);
  });
  it("rejects an added hardlink on a previously verified manifest fast path",async()=>{
    const directory=path.join(root,"verified"),target=path.join(directory,"SKILL.md"),sentinel=path.join(root,"keys/linked-after-verification");
    await fs.mkdir(directory);await fs.writeFile(target,"safe",{mode:0o600});
    const files=skillPackageManifest([{path:"SKILL.md",kind:"skill",content:"safe"}]).files;
    expect(await verifySkillPackageDirectory(directory,files)).toBe(true);await fs.link(target,sentinel);
    const reads=await countSentinelReads(sentinel);expect(await verifySkillPackageDirectory(directory,files)).toBe(false);expect(reads()).toBe(0);
  });
  it("preserves a real package-cache I/O error without falling back or retrying storage",async()=>{
    const f=await packageFixture();await f.store.withPackage(f.companyId,f.snapshot,async()=>{});
    const failure=Object.assign(new Error("synthetic cache storage outage"),{code:"EIO"}),open=fs.open.bind(fs),target=path.join(f.paths.directory,"SKILL.md");
    vi.spyOn(fs,"open").mockImplementation((...args:Parameters<typeof fs.open>)=>String(args[0])===target?Promise.reject(failure):open(...args));
    const storage=storageModule.getStorageService(),get=vi.spyOn(storage,"getObject");
    await expect(withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,f.binding).exportVersion(f.selection))).rejects.toBe(failure);
    expect(get).not.toHaveBeenCalled();expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  it.each(["protected","feature off"])("preserves an operator-configured instance-root alias (%s) without allowing descendant aliases",async mode=>{
    const physical=path.join(root,"physical-instance"),logical=path.join(root,"operator-instance");
    await fs.mkdir(physical);await fs.symlink(physical,logical);vi.stubEnv("PAPERCLIP_HOME",logical);
    if(mode==="feature off")vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS","");
    const instance=resolvePaperclipInstanceRoot();expect(instance.startsWith(logical+path.sep)).toBe(true);
    const directory=path.join(instance,"cache");await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,"payload"),"safe",{mode:0o600});
    expect((await readCheckedCacheFile(path.join(directory,"payload"),4,4)).toString()).toBe("safe");
    const alias=path.join(instance,"untrusted-alias");await fs.symlink(directory,alias);
    await expect(readCheckedCacheFile(path.join(alias,"payload"),4,4)).rejects.toThrow(/Unsafe cached file path/);
  });
  it("preserves I/O errors in the single-file package read path",async()=>{
    const f=await packageFixture();await f.store.withPackage(f.companyId,f.snapshot,async()=>{});
    const failure=Object.assign(new Error("synthetic single-file cache outage"),{code:"EIO"}),open=fs.open.bind(fs),target=path.join(f.paths.directory,"SKILL.md");
    vi.spyOn(fs,"open").mockImplementation((...args:Parameters<typeof fs.open>)=>String(args[0])===target?Promise.reject(failure):open(...args));
    const version=await f.store.version(f.companyId,f.skillId,f.versions[0].id);
    await expect(f.store.readVersionFile(version!,"SKILL.md")).rejects.toBe(failure);
  });
  it.each(["protected","feature off"])("keeps the portable metadata branch explicit (%s)",async mode=>{
    const target=path.join(root,"portable-file");await fs.writeFile(target,"safe",{mode:0o600});
    if(mode==="feature off")vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS","");
    const descriptor=Object.getOwnPropertyDescriptor(process,"platform")!;
    try{
      Object.defineProperty(process,"platform",{...descriptor,value:"darwin"});
      if(mode==="protected")await expect(readCheckedCacheFile(target,4,4)).rejects.toThrow(/require Linux descriptor/);
      else expect((await readCheckedCacheFile(target,4,4)).toString()).toBe("safe");
    }finally{Object.defineProperty(process,"platform",descriptor);}
  });
  async function prepareLocalCapture(kind:string){
    const f=kind==="verification fast path"?await packageFixture():await fixture();
    if(kind!=="verification fast path")vi.spyOn(storageModule,"getStorageService").mockReturnValue(createStorageService(createLocalDiskStorageProvider(path.join(root,"local-objects"))));
    const source=path.join(kind==="outside"||kind==="verification fast path"?path.join(root,"keys"):home,"local-skill");
    const sentinel=path.join(root,"keys/local-sentinel");
    const content=f.versions[0].fileInventory[0].content;
    await fs.writeFile(sentinel,content,{mode:0o600});
    if(kind!=="missing"){
      await fs.mkdir(source,{recursive:true});
      if(kind==="hardlink")await fs.link(sentinel,path.join(source,"SKILL.md"));
      else if(kind==="symlink")await fs.symlink(sentinel,path.join(source,"SKILL.md"));
      else await fs.writeFile(path.join(source,"SKILL.md"),content,{mode:0o600});
      if(kind==="verification fast path"){
        await fs.mkdir(path.join(source,"references"));await fs.writeFile(path.join(source,"references/example.md"),"reference 1");
      }
    }
    await db.update(companySkills).set({sourceType:"local_path",sourceLocator:source,currentVersionId:kind==="verification fast path"?f.versions[0].id:null}).where(eq(companySkills.id,f.skillId));
    const selectVersions=vi.fn(async(entries:Array<{key:string;versionId:string|null}>)=>{
      await db.update(heartbeatRuns).set({contextSnapshot:{skillVersions:Object.fromEntries(entries.map(e=>[e.key,e.versionId])),skillSelectionSnapshot:true}}).where(eq(heartbeatRuns.id,f.runId));
      return new Set(entries.map(e=>e.key));
    });
    const prepare=()=>withSkillActor(f.actor,()=>companySkillService(db).withRuntimeSkillEntries(f.companyId,{
      onlyKeys:new Set([f.key]),snapshotLatest:true,protectedRunExport:f.binding,selectVersions,
    },entries=>entries));
    return {...f,source,sentinel,selectVersions,prepare};
  }
  it.each(["outside","hardlink","symlink","missing"])("refuses fresh local %s before byte reads, version writes or pins",async kind=>{
    const f=await prepareLocalCapture(kind),before=await db.select().from(companySkillVersions).where(eq(companySkillVersions.companySkillId,f.skillId));
    const watched=kind==="outside"||kind==="verification fast path"?path.join(f.source,"SKILL.md"):f.sentinel;
    const reads=await countSentinelReads(watched);
    const error=await f.prepare().catch(error=>error);
    expect(error).toMatchObject({code:"controller_source_protection_refused"});expect(reads()).toBe(0);expect(f.selectVersions).not.toHaveBeenCalled();
    expect(await db.select().from(companySkillVersions).where(eq(companySkillVersions.companySkillId,f.skillId))).toEqual(before);
    const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));expect(run.contextSnapshot?.skillVersions).toEqual({[f.key]:f.versions[0].id});
    expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  it("refuses a fresh-local parent swap without touching its uncommitted working source",async()=>{
    const f=await prepareLocalCapture("approved"),replacement=path.join(root,"keys/local-replacement");
    await fs.mkdir(replacement);await fs.link(f.sentinel,path.join(replacement,"SKILL.md"));let swapped=false;
    const reads=await countSentinelReads(f.sentinel,async filename=>{
      if(filename===path.join(f.source,"SKILL.md")&&!swapped){swapped=true;await fs.rename(f.source,`${f.source}-old`);await fs.symlink(replacement,f.source);}
    });
    await expect(f.prepare()).rejects.toMatchObject({code:"controller_source_protection_refused"});expect(swapped).toBe(false);
    expect(reads()).toBe(0);expect(f.selectVersions).not.toHaveBeenCalled();expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  it("keeps Git and dependency trees out of fresh local snapshots without reading them",async()=>{
    const f=await prepareLocalCapture("approved");
    await db.update(companySkills).set({currentVersionId:f.versions[0].id}).where(eq(companySkills.id,f.skillId));
    for(const name of [".git","node_modules"]){await fs.mkdir(path.join(f.source,name));await fs.link(f.sentinel,path.join(f.source,name,"private"));}
    const reads=await countSentinelReads(f.sentinel);const entries=await f.prepare();
    expect(reads()).toBe(0);expect(await fs.readdir(entries[0].source)).toEqual(["SKILL.md", "references"]);
    await cleanups[0]();expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  it("does not try to publish an uncommitted linked source during execution",async()=>{
    const f=await prepareLocalCapture("approved"),failure=new Error("synthetic package publication failure");
    vi.spyOn(storageModule.getStorageService(),"putFile").mockRejectedValueOnce(failure);
    await expect(f.prepare()).rejects.toMatchObject({code:"controller_source_protection_refused"});expect(f.selectVersions).not.toHaveBeenCalled();
    expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  it("exports a committed linked-local version through private staging and removes it",async()=>{
    const f=await prepareLocalCapture("approved");await db.update(companySkills).set({currentVersionId:f.versions[0].id}).where(eq(companySkills.id,f.skillId));const entries=await f.prepare();expect(entries).toHaveLength(1);
    expect(await fs.readFile(path.join(entries[0].source,"SKILL.md"),"utf8")).toContain("Pinned 1");expect(f.selectVersions).toHaveBeenCalledOnce();
    expect(await fs.readdir(assets)).toHaveLength(1);await cleanups[0]();expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  describe.each(["managed_local", "local_path"])("protected saved source policy %s", sourceKind => {
  it.each(["latest saved","historical pin"])("uses %s native managed-local content without reading its working copy or reconciling inventory",async kind=>{
    const f=await fixture(),working=path.join(root,"keys/native-working");await fs.mkdir(working);await fs.writeFile(path.join(working,"SKILL.md"),"unpublished protected working content",{mode:0o600});
    await db.update(companySkills).set({sourceType:"local_path",sourceLocator:working,metadata:{sourceKind},currentVersionId:f.versions[0].id}).where(eq(companySkills.id,f.skillId));
    // Saved native edits publish a new immutable version and advance this pointer.
    await db.update(companySkills).set({currentVersionId:f.versions[1].id}).where(eq(companySkills.id,f.skillId));
    const expected=kind==="historical pin"?f.versions[0]:f.versions[1],reads=await countSentinelReads(path.join(working,"SKILL.md"));
    const entries=await withSkillActor(f.actor,()=>companySkillService(db).withRuntimeSkillEntries(f.companyId,{
      selectionConfig:writePaperclipSkillSyncPreference({},[f.key]),includeLegacy:true,snapshotLatest:true,protectedRunExport:f.binding,
      ...(kind==="historical pin"?{versionSelections:new Map([[f.key,expected.id]])}:{}),
      selectVersions:async selected=>{await db.update(heartbeatRuns).set({contextSnapshot:{skillVersions:Object.fromEntries(selected.map(e=>[e.key,e.versionId])),skillSelectionSnapshot:true}}).where(eq(heartbeatRuns.id,f.runId));return new Set(selected.map(e=>e.key));},
    },entries=>entries));
    expect(entries).toHaveLength(1);expect(entries[0].versionId).toBe(expected.id);expect(reads()).toBe(0);
    expect(await fs.readFile(path.join(entries[0].source,"SKILL.md"),"utf8")).toContain(kind==="historical pin"?"Pinned 1":"Pinned 2");
  });
  });
  it("refuses missing committed native content without reading the working copy",async()=>{
    const f=await fixture(),working=path.join(root,"keys/native-uncommitted");await fs.mkdir(working);await fs.writeFile(path.join(working,"SKILL.md"),"not published",{mode:0o600});
    await db.update(companySkills).set({sourceType:"local_path",sourceLocator:working,metadata:{sourceKind:"managed_local"},currentVersionId:null}).where(eq(companySkills.id,f.skillId));
    const reads=await countSentinelReads(path.join(working,"SKILL.md"));
    await expect(withSkillActor(f.actor,()=>companySkillService(db).withRuntimeSkillEntries(f.companyId,{onlyKeys:new Set([f.key]),snapshotLatest:true,protectedRunExport:f.binding},e=>e))).rejects.toMatchObject({code:"controller_source_protection_refused"});
    expect(reads()).toBe(0);expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  it("refuses an uninstalled selected skill before runtime inventory reconciliation",async()=>{
    const f=await fixture(),read=vi.spyOn(fs,"readFile"),walk=vi.spyOn(fs,"readdir"),select=vi.fn();
    await expect(withSkillActor(f.actor,()=>companySkillService(db).withRuntimeSkillEntries(f.companyId,{onlyKeys:new Set([f.key,"missing/selected"]),snapshotLatest:true,protectedRunExport:f.binding,selectVersions:select},e=>e))).rejects.toMatchObject({code:"controller_source_protection_refused"});
    expect(read).not.toHaveBeenCalled();expect(walk).not.toHaveBeenCalled();expect(select).not.toHaveBeenCalled();
    expect(await db.select().from(companySkills).where(eq(companySkills.companyId,f.companyId))).toHaveLength(1);
  });
  it("retains an admitted historical key after a skill rename without inventory refresh",async()=>{
    const f=await fixture();await db.update(companySkills).set({key:`company/${f.companyId}/renamed`,slug:"renamed"}).where(eq(companySkills.id,f.skillId));
    const entries=await withSkillActor(f.actor,()=>companySkillService(db).withRuntimeSkillEntries(f.companyId,{
      onlyKeys:new Set([f.key]),versionSelections:new Map([[f.key,f.versions[0].id]]),snapshotLatest:true,protectedRunExport:f.binding,
    },e=>e));
    expect(entries).toHaveLength(1);expect(entries[0].key).toBe(f.key);expect(entries[0].versionId).toBe(f.versions[0].id);
  });
  it("uses committed external-local content when its original working directory is missing",async()=>{
    const f=await fixture();await db.update(companySkills).set({sourceType:"local_path",sourceLocator:path.join(home,"missing-original"),currentVersionId:f.versions[0].id}).where(eq(companySkills.id,f.skillId));
    const entries=await withSkillActor(f.actor,()=>companySkillService(db).withRuntimeSkillEntries(f.companyId,{onlyKeys:new Set([f.key]),snapshotLatest:true,protectedRunExport:f.binding},e=>e));
    expect(entries).toHaveLength(1);expect(entries[0].versionId).toBe(f.versions[0].id);expect(await fs.readFile(path.join(entries[0].source,"SKILL.md"),"utf8")).toContain("Pinned 1");
  });
  it("delivers an actual pinned native version outside read roots through protected Codex home staging",async()=>{
    const f=await fixture();
    const native=await withSkillActor(f.actor,()=>companySkillService(db).withRuntimeSkillEntries(f.companyId,{
      onlyKeys:new Set([f.key]),snapshotLatest:true,versionSelections:new Map([[f.key,f.versions[0].id]]),
    },entries=>entries));
    expect(native[0].source).toContain(`/skills/${f.companyId}/__versions__/${f.skillId}/${f.versions[0].id}`);
    expect((await fs.lstat(path.join(native[0].source,"SKILL.md"))).isFile()).toBe(true);
    const entries=await withSkillActor(f.actor,()=>companySkillService(db).withRuntimeSkillEntries(f.companyId,{
      onlyKeys:new Set([f.key]),snapshotLatest:true,versionSelections:new Map([[f.key,f.versions[0].id]]),
      protectedRunExport:f.binding,
    },entries=>entries));
    expect(entries).toHaveLength(1);expect(entries[0].versionId).toBe(f.versions[0].id);
    await expect(assertControllerSourcePathAllowed(entries[0].source)).resolves.toBeUndefined();
    const cache=path.join(process.env.PAPERCLIP_HOME!,"instances/default/skills",f.companyId,"__versions__",f.skillId,f.versions[0].id);
    await expect(assertControllerSourcePathAllowed(cache)).rejects.toThrow(/signing-key protection/);
    expect(await fs.readFile(path.join(entries[0].source,"SKILL.md"),"utf8")).toContain("Pinned 1");
    await fs.mkdir(path.join(home,"skills"));await fs.symlink(entries[0].source,path.join(home,"skills/assigned"));await fs.writeFile(path.join(home,"auth.json"),"synthetic-approved-provider-auth");
    const staged=await stageCodexHomeForSync(home);cleanups.push(()=>fs.rm(staged,{recursive:true,force:true}));
    expect(await fs.readFile(path.join(staged,"skills/assigned/references/example.md"),"utf8")).toBe("reference 1");
    expect((await fs.lstat(path.join(staged,"skills/assigned/SKILL.md"))).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(staged,"auth.json"),"utf8")).toBe("synthetic-approved-provider-auth");
    expect(cleanups.length).toBe(2);
    await cleanups[0]();await expect(fs.lstat(entries[0].source)).rejects.toMatchObject({code:"ENOENT"});
    expect(await fs.readFile(path.join(root,"keys/signing.pem"),"utf8")).toBe("synthetic-private-signing-sentinel");
  });
  it.each(["company","agent","run","version","key"])("refuses a mismatched %s without allocating an export",async kind=>{
    const f=await fixture();const binding={...f.binding},selection={...f.selection};
    if(kind==="company")selection.companyId=randomUUID();if(kind==="agent")binding.agentId=randomUUID();if(kind==="run")binding.runId=randomUUID();
    if(kind==="version")selection.versionId=f.versions[1].id;if(kind==="key")selection.key="unassigned/key";
    await expect(withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,binding).exportVersion(selection))).rejects.toMatchObject({code:"controller_source_protection_refused"});
    expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  it("refuses missing actor authority and cancelled run admission",async()=>{
    const f=await fixture();
    await expect(controllerSkillExporter(db,f.companyId,f.binding).exportVersion(f.selection)).rejects.toMatchObject({code:"controller_source_protection_refused"});
    await db.update(heartbeatRuns).set({status:"cancelled"}).where(eq(heartbeatRuns.id,f.runId));
    await expect(withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,f.binding).exportVersion(f.selection))).rejects.toMatchObject({code:"controller_source_protection_refused"});
  });

  it.each([".git/config",".git-credentials","../escape","/absolute",Array(66).fill("deep").join("/")])("refuses unsafe inventory path %s before allocation",async unsafe=>{
    const f=await fixture();await db.update(companySkillVersions).set({fileInventory:[{path:"SKILL.md",kind:"skill",content:"safe"},{path:unsafe,kind:"other",content:"unsafe metadata"}]}).where(eq(companySkillVersions.id,f.versions[0].id));
    await expect(withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,f.binding).exportVersion(f.selection))).rejects.toMatchObject({code:"controller_source_protection_refused"});
    expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  it.each(["duplicate","parent conflict","bare Git","too many"])("refuses %s inventory",async kind=>{
    const f=await fixture();let files=[{path:"SKILL.md",kind:"skill" as const,content:"safe"}];
    if(kind==="duplicate")files.push({...files[0]});
    if(kind==="parent conflict")files.push({path:"SKILL.md/child",kind:"skill",content:"bad"});
    if(kind==="bare Git")files.push({path:"HEAD",kind:"skill",content:"ref: refs/heads/master"},{path:"objects/aa/blob",kind:"skill",content:"bad"});
    if(kind==="too many")files=Array.from({length:10001},(_,n)=>({path:n?`file-${n}`:"SKILL.md",kind:"skill",content:"x"}));
    await db.update(companySkillVersions).set({fileInventory:files}).where(eq(companySkillVersions.id,f.versions[0].id));
    await expect(withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,f.binding).exportVersion(f.selection))).rejects.toMatchObject({code:"controller_source_protection_refused"});
    expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  it.each(["symlink","hardlink"])("exports pinned bytes without reading a poisoned native cache %s",async kind=>{
    const f=await fixture();const service=companySkillService(db);
    const raw=await withSkillActor(f.actor,()=>service.withRuntimeSkillEntries(f.companyId,{onlyKeys:new Set([f.key]),versionSelections:new Map([[f.key,f.versions[0].id]])},e=>e));
    const filename=path.join(raw[0].source,"SKILL.md");await fs.unlink(filename);if(kind==="symlink")await fs.symlink(path.join(root,"keys/signing.pem"),filename);else await fs.link(path.join(root,"keys/signing.pem"),filename);
    const opened=vi.spyOn(fs,"open");
    const exported=await withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,f.binding).exportVersion(f.selection));
    expect(await fs.readFile(path.join(exported,"SKILL.md"),"utf8")).toContain("Pinned 1");
    expect(opened.mock.calls.some(([file])=>String(file).includes("keys/signing.pem"))).toBe(false);
    await expect(assertControllerSourcePathAllowed(filename)).rejects.toThrow(/signing-key protection/);
  });
  it.each(["cancel","pin change","abort"])("rechecks %s before publication and removes partial exports",async kind=>{
    const f=await fixture();const abort=new AbortController();const open=fs.open.bind(fs);
    vi.spyOn(fs,"open").mockImplementationOnce(async(...args:Parameters<typeof fs.open>)=>{
      if(kind==="cancel")await db.update(heartbeatRuns).set({status:"cancelled"}).where(eq(heartbeatRuns.id,f.runId));
      if(kind==="pin change")await db.update(heartbeatRuns).set({contextSnapshot:{skillVersions:{[f.key]:f.versions[1].id},skillSelectionSnapshot:true}}).where(eq(heartbeatRuns.id,f.runId));
      if(kind==="abort")abort.abort();
      return open(...args);
    });
    await expect(withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,{...f.binding,signal:abort.signal}).exportVersion(f.selection))).rejects.toThrow();
    expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  it("removes exports if cleanup registration throws and preserves the unexpected error",async()=>{
    const f=await fixture(),error=new Error("registration failed");
    await expect(withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,{...f.binding,onCleanup:()=>{throw error;}}).exportVersion(f.selection))).rejects.toBe(error);
    expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  it("waits for an active export writer before cleanup and leaves no partial files",async()=>{
    const f=await fixture();let release!:()=>void,entered!:()=>void;
    const wait=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
    const open=fs.open.bind(fs);
    vi.spyOn(fs,"open").mockImplementationOnce(async(...args:Parameters<typeof fs.open>)=>{entered();await wait;return open(...args);});
    const work=withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,f.binding).exportVersion(f.selection));
    const outcome=work.catch(error=>error);
    await ready;let settled=false;const cleanup=cleanups[0]().then(()=>{settled=true;});
    await Promise.resolve();expect(settled).toBe(false);
    release();expect(await outcome).toMatchObject({code:"controller_source_protection_refused"});await cleanup;
    expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  it("holds the native cache lock through publication and releases it after consumption",async()=>{
    const f=await fixture();let release!:()=>void,entered!:()=>void;
    const wait=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
    const preparation=withSkillActor(f.actor,()=>companySkillService(db).withRuntimeSkillEntries(f.companyId,{
      onlyKeys:new Set([f.key]),versionSelections:new Map([[f.key,f.versions[0].id]]),protectedRunExport:f.binding,
    },async entries=>{entered();await wait;return entries;}));
    await ready;
    try{await expect(withSkillVersionCacheLock(db,f.companyId,async()=>"overlap",true)).rejects.toBeInstanceOf(SkillCacheBusy);}
    finally{release();await preparation;}
    await expect(withSkillVersionCacheLock(db,f.companyId,async()=>"released",true)).resolves.toBe("released");
  });
  it.each(["company paused","agent paused","agent pausing"])("refuses %s admission",async kind=>{
    const f=await fixture();
    if(kind==="company paused")await db.update(companies).set({status:"paused"}).where(eq(companies.id,f.companyId));
    if(kind==="agent paused")await db.update(agents).set({status:"paused"}).where(eq(agents.id,f.agentId));
    if(kind==="agent pausing")await db.update(agents).set({lifecycleState:"pausing"}).where(eq(agents.id,f.agentId));
    await expect(withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,f.binding).exportVersion(f.selection))).rejects.toMatchObject({code:"controller_source_protection_refused"});
    expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });

  it("counts directory ancestors before allocating a deep sparse inventory",async()=>{
    const f=await fixture();const files=[{path:"SKILL.md",kind:"skill" as const,content:"safe"},...Array.from({length:200},(_,n)=>({
      path:`branch-${n}/${Array(59).fill("directory").join("/")}/leaf`,kind:"skill" as const,content:"",
    }))];
    await db.update(companySkillVersions).set({fileInventory:files}).where(eq(companySkillVersions.id,f.versions[0].id));
    await expect(withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,f.binding).exportVersion(f.selection))).rejects.toMatchObject({code:"controller_source_protection_refused"});
    expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
  it("makes known access revocation permanent but preserves genuine database failure",async()=>{
    const f=await fixture();accessFaults.set(f.skillId,()=>{throw notFound("Skill not found");});
    await expect(withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,f.binding).exportVersion(f.selection))).rejects.toMatchObject({code:"controller_source_protection_refused"});
    const outage=Object.assign(new Error("synthetic database outage"),{code:"08006"});accessFaults.set(f.skillId,()=>{throw outage;});
    await expect(withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,f.binding).exportVersion(f.selection))).rejects.toBe(outage);
    expect(await fs.readdir(assets).catch(()=>[])).toEqual([]);
  });
});
