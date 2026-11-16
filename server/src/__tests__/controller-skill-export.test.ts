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
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

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
    expect(await fs.readdir(assets)).toEqual([]);
  });
  it("removes exports if cleanup registration throws and preserves the unexpected error",async()=>{
    const f=await fixture(),error=new Error("registration failed");
    await expect(withSkillActor(f.actor,()=>controllerSkillExporter(db,f.companyId,{...f.binding,onCleanup:()=>{throw error;}}).exportVersion(f.selection))).rejects.toBe(error);
    expect(await fs.readdir(assets)).toEqual([]);
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
    expect(await fs.readdir(assets)).toEqual([]);
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
