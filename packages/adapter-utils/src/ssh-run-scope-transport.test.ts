import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { buildSshEnvLabFixtureConfig, createSshCommandManagedRuntimeRunner, getSshEnvLabSupport,
  ensureSshWorkspaceReady, prepareSshRunScope, probeSshRunScope, runSshCommand, startSshEnvLabFixture, stopSshEnvLabFixture,
  stopSshRunScope, type SshEnvLabFixtureState } from "./ssh.js";
import { runChildProcess, runningProcesses, signalRunningProcess } from "./server-utils.js";
import type { SshRunScope } from "./ssh-run-scope.js";

it("stops a detached workload through real authenticated SSH after its local client is killed",async()=>{
  const support=await getSshEnvLabSupport();
  // Qualification explicitly requires this dependency; it must never silently skip.
  expect(support.supported,support.reason??"SSH fixture unavailable").toBe(true);
  const root=await mkdtemp(path.join(os.tmpdir(),"ssh-owned-transport-"));
  let fixture:SshEnvLabFixtureState|undefined,scope:SshRunScope|undefined;
  let invocation:Promise<unknown>|undefined;
  let config:Awaited<ReturnType<typeof buildSshEnvLabFixtureConfig>>|undefined;
  try{
    fixture=await startSshEnvLabFixture({statePath:path.join(root,"state.json")});
    const base=await buildSshEnvLabFixtureConfig(fixture);
    const alias=path.join(root,"workspace-alias");await symlink(fixture.workspaceDir,alias);
    config={...base,remoteWorkspacePath:alias};
    expect(config.strictHostKeyChecking).toBe(true);
    const probe=await probeSshRunScope(config);
    expect(probe.remoteCwd).toBe(alias);
    scope={schema:"paperclip.ssh-run-scope.v1",companyId:randomUUID(),runId:randomUUID(),leaseId:randomUUID(),generation:randomUUID(),bootId:probe.bootId};
    await prepareSshRunScope(config,scope);
    const spec={...config,remoteCwd:probe.remoteCwd,runScope:scope};
    expect((await ensureSshWorkspaceReady(spec)).remoteCwd).toBe(probe.remoteCwd);
    const native=createSshCommandManagedRuntimeRunner({spec});
    const sentinel="literal 'quote' $(printf unsafe) `printf unsafe`";
    const basic=await native.execute({command:"printenv",args:["SCOPED_SENTINEL"],env:{SCOPED_SENTINEL:sentinel},timeoutMs:5000});
    expect(basic.exitCode).toBe(0);expect(basic.stdout).toBe(sentinel+"\n");
    const marker=path.join(root,"remote-child.pid"),program=path.join(root,"remote-work.py");
    await writeFile(program,`import os,pathlib,time\nif os.fork():os._exit(0)\nos.setsid()\npathlib.Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))\ntime.sleep(60)`);
    invocation=runChildProcess(scope.runId!,"python3",[program],{cwd:root,env:{},timeoutSec:0,graceSec:1,onLog:async()=>{},remoteExecution:spec});
    const end=Date.now()+8000;let pid=0;
    while(Date.now()<end){try{pid=Number(await readFile(marker,"utf8"));if(pid>0)break;}catch{}await new Promise(r=>setTimeout(r,20));}
    expect(pid).toBeGreaterThan(0);
    const local=runningProcesses.get(scope.runId!);expect(local).toBeDefined();
    signalRunningProcess(local!,"SIGKILL");await invocation;
    // Client exit is deliberately insufficient; the owned remote child is alive.
    process.kill(pid,0);
    const proof=await stopSshRunScope(config,scope);
    expect(proof).toEqual({owner:scope,phase:"stopped",waitProof:"ECHILD_WALL",admissionClosed:true});
    expect(()=>process.kill(pid,0)).toThrow();
    const late=await native.execute({command:"touch",args:[path.join(root,"must-not-exist")],timeoutMs:5000});
    expect(late.exitCode).toBe(125);
    await expect(readFile(path.join(root,"must-not-exist"))).rejects.toMatchObject({code:"ENOENT"});
    await expect(runSshCommand(spec,"true")).rejects.toMatchObject({message:"ssh_run_scope_command_failed",code:125});
    expect(await stopSshRunScope(config,scope)).toEqual(proof);
  }finally{
    if(config&&scope){await stopSshRunScope(config,scope);await invocation;
      const state=path.join(os.homedir(),".local/state/paperclip/ssh-scopes-v1",scope.leaseId);
      expect(path.basename(state)).toBe(scope.leaseId);await rm(state,{recursive:true});}
    if(fixture)await stopSshEnvLabFixture(fixture);
    await rm(root,{recursive:true,force:true});
  }
},60000);
