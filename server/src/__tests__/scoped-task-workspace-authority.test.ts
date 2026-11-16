import { controllerSkillExporter } from "../services/controller-skill-export.js";
import { withSkillActor } from "../services/skill-access.js";
import { skillPackageStore } from "../services/skill-package-store.js";
import * as storageModule from "../storage/index.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { agents, companies, companySkills, companySkillVersions, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { withScopedTaskWorkspaceAuthority } from "../services/scoped-task-workspace-authority.js";
import { materializeIsolatedTaskDirectory } from "../services/isolated-task-directory.js";
import { hasPendingRunCleanup } from "../services/execution-blocker.js";
import { assertControllerWorkspacePublication, withControllerWorkspaceOperation } from "@paperclipai/adapter-utils/controller-workspace-authority";
import { controllerSshWorkspaceTarget } from "@paperclipai/adapter-utils/controller-ssh-workspace";
import { assertControllerSourcePathAllowed } from "@paperclipai/adapter-utils/controller-source-protection";
import { prepareRemoteManagedRuntime } from "@paperclipai/adapter-utils/remote-managed-runtime";
import { buildSshEnvLabFixtureConfig, startSshEnvLabFixture, stopSshEnvLabFixture, probeSshRunScope,
  prepareSshRunScope, stopSshRunScope, runSshCommand, shellQuote, type SshRemoteExecutionSpec, type SshEnvLabFixtureState } from "@paperclipai/adapter-utils/ssh";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("scoped-task-workspace-"); db = createDb(database.connectionString); }, 90000);
afterAll(async () => { await database?.cleanup(); });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "native-task-authority-"));
  vi.stubEnv("PAPERCLIP_HOME", root); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", "1"); vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", "");
  vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS", JSON.stringify([path.join(root, "snapshots")]));
  vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS", JSON.stringify([path.join(root, "legacy")]));
  vi.stubEnv("PAPERCLIP_CONTROLLER_ASSET_SNAPSHOT_ROOT", path.join(root, "snapshots"));
  await mkdir(path.join(root, "synthetic-secrets")); await writeFile(path.join(root, "synthetic-secrets/key"), "synthetic-key-never-transfer");
  vi.stubEnv("PAPERCLIP_CONTROLLER_PROTECTED_PATHS", JSON.stringify([path.join(root, "synthetic-secrets")]));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function seed() {
  const companyId=randomUUID(), agentId=randomUUID(), issueId=randomUUID(), runId=randomUUID(), workspaceId=randomUUID(), environmentId=randomUUID(), leaseId=randomUUID();
  await db.insert(companies).values({id:companyId,name:"Scoped task fixture",issuePrefix:"T"+companyId.replaceAll("-", "")});
  await db.insert(agents).values({id:agentId,companyId,name:"Fixture agent",role:"engineer",adapterType:"codex_local",lifecycleState:"ready",lifecycleHolds:[]});
  await db.insert(issues).values({id:issueId,companyId,title:"Synthetic task",status:"in_progress",assigneeAgentId:agentId});
  const cwd=await materializeIsolatedTaskDirectory({companyId,issueId,attemptId:runId});
  await db.insert(executionWorkspaces).values({id:workspaceId,companyId,sourceIssueId:issueId,mode:"isolated_workspace",strategyType:"project_primary",name:"Attempt",cwd,providerType:"local_fs"});
  await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,issueId,status:"running",runtimeMode:"legacy",contextSnapshot:{issueId,executionWorkspaceId:workspaceId}});
  await db.update(issues).set({executionRunId:runId,executionWorkspaceId:workspaceId}).where(eq(issues.id,issueId));
  await db.insert(environments).values({id:environmentId,name:"Synthetic SSH "+environmentId,driver:"ssh",config:{host:"192.0.2.124",port:22,username:"worker",remoteWorkspacePath:"/workspace"}});
  const scope={schema:"paperclip.ssh-run-scope.v1" as const,companyId,runId,leaseId,generation:randomUUID(),bootId:randomUUID()};
  const spec={host:"192.0.2.124",port:22,username:"worker",remoteCwd:"/workspace",remoteWorkspacePath:"/workspace",privateKey:null,knownHosts:null,strictHostKeyChecking:true,runScope:scope};
  const target={kind:"remote" as const,transport:"ssh" as const,environmentId,leaseId,remoteCwd:spec.remoteCwd,spec};
  await db.insert(environmentLeases).values({id:leaseId,companyId,environmentId,executionWorkspaceId:workspaceId,issueId,heartbeatRunId:runId,status:"active",provider:"ssh",providerLeaseId:`ssh://${spec.username}@${spec.host}:${spec.port}${spec.remoteCwd}`,metadata:{host:spec.host,port:spec.port,username:spec.username,remoteWorkspacePath:spec.remoteWorkspacePath,remoteCwd:spec.remoteCwd,remoteExecutionScope:scope,remoteExecutionScopeRequired:true}});
  const input={companyId,agentId,issueId,runId,workspaceId,workspaceCwd:cwd,target,signal:new AbortController().signal};
  const remoteDir=path.posix.join(spec.remoteCwd,".paperclip-runtime/runs",runId,"workspace");
  const read=()=>withControllerWorkspaceOperation(cwd,controllerSshWorkspaceTarget(spec,runId,remoteDir),"read",()=>assertControllerSourcePathAllowed(cwd));
  return {input,cwd,scope,read,remoteDir};
}

it("admits only the exact persisted native attempt; no static root expansion",async()=>{
  const f=await seed(); await expect(assertControllerSourcePathAllowed(f.cwd)).rejects.toThrow();
  await withScopedTaskWorkspaceAuthority(db,f.input,f.read);
  await expect(assertControllerSourcePathAllowed(f.cwd,true)).rejects.toThrow();
});
it.each(["companyId","agentId","issueId","runId","workspaceId"] as const)("denies a mismatched %s",async field=>{
  const f=await seed(); await expect(withScopedTaskWorkspaceAuthority(db,{...f.input,[field]:randomUUID()},f.read)).rejects.toThrow();
});
it.each(["environmentId","leaseId"] as const)("denies mismatched target %s",async field=>{
  const f=await seed(); await expect(withScopedTaskWorkspaceAuthority(db,{...f.input,target:{...f.input.target,[field]:randomUUID()}},f.read)).rejects.toThrow();
});
it("revokes admission when generation or task owner changes",async()=>{
  const f=await seed();
  await withScopedTaskWorkspaceAuthority(db,f.input,async()=>{
    await db.update(environmentLeases).set({metadata:{remoteExecutionScopeRequired:true,remoteExecutionScope:{...f.scope,generation:randomUUID()}}}).where(eq(environmentLeases.id,f.scope.leaseId));
    await expect(f.read()).rejects.toThrow();
  });
});

it.each(["normal", "cancelled", "stale_generation"])("protected native real SSH transfer, scoped publication and physical stop: %s",async mode=>{
  const f=await seed(); let fixture:SshEnvLabFixtureState|undefined; let spec:SshRemoteExecutionSpec=f.input.target.spec;
  const cleanups:Array<()=>Promise<void>>=[];
  try {
    fixture=await startSshEnvLabFixture({statePath:path.join(root,"ssh-state.json")});
    const config=await buildSshEnvLabFixtureConfig(fixture), probe=await probeSshRunScope(config);
    const scope={...f.scope,bootId:probe.bootId}; await prepareSshRunScope(config,scope);
    // The production environment parser trims public known-host text before building the target.
    spec={...config,knownHosts:config.knownHosts?.trim() || null,remoteCwd:probe.remoteCwd,runScope:scope};
    const target={...f.input.target,spec,remoteCwd:spec.remoteCwd};
    await db.update(environmentLeases).set({providerLeaseId:`ssh://${spec.username}@${spec.host}:${spec.port}${spec.remoteCwd}`,metadata:{host:spec.host,port:spec.port,username:spec.username,remoteWorkspacePath:spec.remoteWorkspacePath,remoteCwd:spec.remoteCwd,remoteExecutionScope:scope,remoteExecutionScopeRequired:true}}).where(eq(environmentLeases.id,scope.leaseId));
    await db.update(environments).set({config:{host:spec.host,port:spec.port,username:spec.username,remoteWorkspacePath:spec.remoteWorkspacePath,knownHosts:spec.knownHosts,strictHostKeyChecking:spec.strictHostKeyChecking}}).where(eq(environments.id,target.environmentId));
    await writeFile(path.join(f.cwd,"input.txt"),"synthetic input");
    await writeFile(path.join(f.cwd,"delete.txt"),"delete",{mode:0o644});
    await writeFile(path.join(f.cwd,"chmod.txt"),"chmod",{mode:0o644});
    await writeFile(path.join(f.cwd,"executable.sh"),"executable",{mode:0o755});
    await mkdir(path.join(f.cwd,".git")); await writeFile(path.join(f.cwd,".git/config"),"excluded synthetic Git metadata");
    const skillId=randomUUID(), key=`company/${f.input.companyId}/synthetic-assigned`;
    await db.insert(companySkills).values({id:skillId,companyId:f.input.companyId,key,slug:"synthetic-assigned",name:"Synthetic assigned",markdown:"# Synthetic",sourceType:"managed"});
    const storage=createStorageService(createLocalDiskStorageProvider(path.join(root,"synthetic-objects")));
    vi.spyOn(storageModule,"getStorageService").mockReturnValue(storage);
    const store=skillPackageStore(db,storage);
    const packageSnapshotId=await store.prepare(f.input.companyId,[{path:"SKILL.md",kind:"skill",content:"---\nname: synthetic-assigned\ndescription: Synthetic fixture\n---\n# Synthetic pinned skill\n"}]);
    const [version]=await db.insert(companySkillVersions).values({companyId:f.input.companyId,companySkillId:skillId,revisionNumber:1,packageSnapshotId,fileInventory:[]}).returning();
    await db.update(companySkills).set({currentVersionId:version.id}).where(eq(companySkills.id,skillId));
    await db.update(heartbeatRuns).set({contextSnapshot:{issueId:f.input.issueId,executionWorkspaceId:f.input.workspaceId,skillSelectionSnapshot:true,skillVersions:{[key]:version.id}}}).where(eq(heartbeatRuns.id,f.input.runId));
    const exporter=controllerSkillExporter(db,f.input.companyId,{agentId:f.input.agentId,runId:f.input.runId,onCleanup:cleanup=>cleanups.push(cleanup)});
    const exported=await withSkillActor({type:"agent",companyId:f.input.companyId,agentId:f.input.agentId,runId:f.input.runId,source:"agent_jwt"},()=>exporter.exportVersion({companyId:f.input.companyId,skillId,key,versionId:version.id}));
    await withScopedTaskWorkspaceAuthority(db,{...f.input,target},async()=>{
      const runtime=await prepareRemoteManagedRuntime({spec,runId:scope.runId,adapterKey:"synthetic-provider",workspaceLocalDir:f.cwd,assets:[{key:"assigned-skill",localDir:exported}]});
      const command=`cd ${shellQuote(runtime.workspaceRemoteDir)} && test ! -e .git && test "$(cat input.txt)" = 'synthetic input' && rm delete.txt executable.sh && chmod 755 chmod.txt && printf 'synthetic output' > output.txt`;
      await runSshCommand(spec,command);
      expect((await runSshCommand(spec,`cat ${shellQuote(path.posix.join(runtime.assetDirs["assigned-skill"],"SKILL.md"))}`)).stdout).toContain("Synthetic pinned skill");
      if (mode !== "normal") {
        if (mode === "cancelled") {
          await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.id,scope.runId));
          await stopSshRunScope(spec,scope);
        } else await db.update(environmentLeases).set({metadata:{remoteExecutionScopeRequired:true,remoteExecutionScope:{...scope,generation:randomUUID()}}}).where(eq(environmentLeases.id,scope.leaseId));
        await expect(runtime.restoreWorkspace()).rejects.toThrow();
        await expect(readFile(path.join(f.cwd,"output.txt"))).rejects.toMatchObject({code:"ENOENT"});
        const [stored]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,scope.runId));
        expect(stored.resultJson).toMatchObject({workspaceRestoreFailure:"restore_failed",workspaceRestoreRecovery:{schema:"paperclip.workspace-restore-recovery.v1",leaseIds:[scope.leaseId]}});
        expect(stored.status).toBe(mode === "cancelled" ? "cancelled" : "running");
        expect(await readFile(path.join(runtime.workspaceRemoteDir,"output.txt"),"utf8")).toBe("synthetic output");
        return;
      }
      await Promise.all([runtime.restoreWorkspace(),runtime.restoreWorkspace()]);
      expect(await readFile(path.join(f.cwd,"output.txt"),"utf8")).toBe("synthetic output");
      expect(await readFile(path.join(f.cwd,".git/config"),"utf8")).toContain("excluded");
      await expect(lstat(path.join(f.cwd,"delete.txt"))).rejects.toMatchObject({code:"ENOENT"});
      await expect(lstat(path.join(f.cwd,"executable.sh"))).rejects.toMatchObject({code:"ENOENT"});
      expect((await lstat(path.join(f.cwd,"chmod.txt"))).mode & 0o777).toBe(0o755);
    });
    for(const cleanup of cleanups.splice(0)) await cleanup();
    const proof=await stopSshRunScope(spec,scope);
    expect(proof).toEqual({owner:scope,phase:"stopped",waitProof:"ECHILD_WALL",admissionClosed:true});
    await expect(runSshCommand(spec,"true")).rejects.toMatchObject({code:125});
    expect(await readdir(path.join(root,"snapshots"))).toEqual([]);
  } finally {
    for(const cleanup of cleanups.splice(0)) await cleanup();
    if(spec.runScope && fixture) {
      await stopSshRunScope(spec,spec.runScope);
      await rm(path.join(os.homedir(),".local/state/paperclip/ssh-scopes-v1",spec.runScope.leaseId),{recursive:true,force:true});
    }
    if(fixture) await stopSshEnvLabFixture(fixture);
  }
},60000);

it("denies a forged SSH endpoint even with a self-consistent fingerprint", async () => {
  const f=await seed(); const spec={...f.input.target.spec,host:"192.0.2.125"};
  await expect(withScopedTaskWorkspaceAuthority(db,{...f.input,target:{...f.input.target,spec}},async()=>{})).rejects.toThrow();
});
it("denies expiry and cancellation markers before provider admission", async () => {
  const f=await seed();
  await db.update(environmentLeases).set({expiresAt:new Date(0)}).where(eq(environmentLeases.id,f.scope.leaseId));
  await expect(withScopedTaskWorkspaceAuthority(db,f.input,f.read)).rejects.toThrow();
  await db.update(environmentLeases).set({expiresAt:null}).where(eq(environmentLeases.id,f.scope.leaseId));
  await db.update(heartbeatRuns).set({resultJson:{startupCancellation:{requestedAt:new Date().toISOString()}}}).where(eq(heartbeatRuns.id,f.input.runId));
  await expect(withScopedTaskWorkspaceAuthority(db,f.input,f.read)).rejects.toThrow();
});

it("supports the existing authoritative retained namespace without granting other tasks", async () => {
  const f=await seed(); const cwd=await materializeIsolatedTaskDirectory({companyId:f.input.companyId,issueId:f.input.issueId});
  await db.update(executionWorkspaces).set({cwd}).where(eq(executionWorkspaces.id,f.input.workspaceId));
  const target=controllerSshWorkspaceTarget(f.input.target.spec,f.input.runId,f.remoteDir);
  await withScopedTaskWorkspaceAuthority(db,{...f.input,workspaceCwd:cwd},()=>withControllerWorkspaceOperation(cwd,target,"read",()=>assertControllerSourcePathAllowed(cwd)));
  await expect(withScopedTaskWorkspaceAuthority(db,{...f.input,workspaceCwd:f.cwd},async()=>{})).rejects.toThrow();
});

it("keeps durable ownership after publication connection loss until filesystem work joins", async () => {
  const f=await seed(); let entered!:()=>void, release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}); const gate=new Promise<void>(resolve=>{release=resolve;});
  const target=controllerSshWorkspaceTarget(f.input.target.spec,f.input.runId,f.remoteDir);
  const pending=withScopedTaskWorkspaceAuthority(db,f.input,()=>withControllerWorkspaceOperation(f.cwd,target,"publish",async()=>{
    await assertControllerWorkspacePublication(); await writeFile(path.join(f.cwd,"first.txt"),"first");
    entered(); await gate;
    await assertControllerWorkspacePublication(); await writeFile(path.join(f.cwd,"must-not-write.txt"),"stale");
  }));
  const outcome=pending.then(()=>null,error=>error);
  try {
    await started;
    const [backend]=await db.execute<{pid:number}>(sql`select distinct l.pid from pg_locks l
      join pg_stat_activity a on a.pid=l.pid where a.datname=current_database() and l.relation='issues'::regclass
      and l.mode='RowShareLock' and l.granted and l.pid <> pg_backend_pid()`);
    expect(backend?.pid).toBeGreaterThan(0);
    await db.execute(sql`select pg_terminate_backend(${backend.pid})`);
    await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.input.runId));
    expect(await hasPendingRunCleanup(db,f.input.companyId,f.input.runId)).toBe(true);
    const [owned]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.input.runId));
    expect(owned.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toBeTruthy();
  } finally { release(); }
  expect(await outcome).toBeInstanceOf(Error);
  await expect(readFile(path.join(f.cwd,"must-not-write.txt"))).rejects.toMatchObject({code:"ENOENT"});
  const [joined]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.input.runId));
  expect(joined.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toBeUndefined();
},60000);

it("publishes with a single ordinary connection and a small database idle timeout", async () => {
  const f=await seed(); const databaseName=decodeURIComponent(new URL(database.connectionString).pathname.slice(1));
  await db.execute(sql`alter database ${sql.identifier(databaseName)} set idle_in_transaction_session_timeout = '150ms'`);
  const single=createDb(database.connectionString,{maxConnections:1,applicationName:"scoped-workspace-max-one"});
  try {
    const target=controllerSshWorkspaceTarget(f.input.target.spec,f.input.runId,f.remoteDir);
    await withScopedTaskWorkspaceAuthority(single,f.input,()=>withControllerWorkspaceOperation(f.cwd,target,"publish",async()=>{
      await new Promise(resolve=>setTimeout(resolve,500));
      await assertControllerWorkspacePublication();
      await writeFile(path.join(f.cwd,"single-pool.txt"),"published");
    }));
    expect(await readFile(path.join(f.cwd,"single-pool.txt"),"utf8")).toBe("published");
  } finally {
    await single.$client.end({timeout:1});
    await db.execute(sql`alter database ${sql.identifier(databaseName)} reset idle_in_transaction_session_timeout`);
  }
},60000);

it("resolves a trusted configured home alias while refusing descendant workspace aliases", async () => {
  const f=await seed(); const alias=path.join(root,"trusted-home-alias"); await symlink(root,alias);
  vi.stubEnv("PAPERCLIP_HOME",alias);
  await withScopedTaskWorkspaceAuthority(db,f.input,f.read);
  const escaped=path.join(root,"other-directory"); await mkdir(escaped,{mode:0o700});
  await rm(f.cwd,{recursive:true}); await symlink(escaped,f.cwd);
  await expect(withScopedTaskWorkspaceAuthority(db,f.input,f.read)).rejects.toThrow();
});
it("denies a finished run even if its status still says running", async () => {
  const f=await seed(); await db.update(heartbeatRuns).set({finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.input.runId));
  await expect(withScopedTaskWorkspaceAuthority(db,f.input,f.read)).rejects.toThrow();
});
