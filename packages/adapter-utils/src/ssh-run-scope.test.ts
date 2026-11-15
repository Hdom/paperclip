import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SSH_RUN_SUPERVISOR_SOURCE, parseSshRunScope, sshRunScopeControl,
  sshRunScopeProbe, supervisedSshCommand, verifiedSshRunScopeStop, type SshRunScope } from "./ssh-run-scope.js";

const exec = promisify(execFile);
const owner = (): SshRunScope => ({ schema: "paperclip.ssh-run-scope.v1", companyId: randomUUID(),
  runId: randomUUID(), leaseId: randomUUID(), generation: randomUUID(), bootId: randomUUID() });
const stopped = (scope: SshRunScope) => ({owner:scope, phase:"stopped",waitProof:"ECHILD_WALL",admissionClosed:true});
describe("SSH stop acknowledgement boundary", () => {
  it("requires exact typed scope and positive closed-gate proof", () => {
    const scope=owner();
    expect(verifiedSshRunScopeStop(scope,stopped(scope))).toEqual(stopped(scope));
    for(const value of [null,{}, {error:"ssh_run_scope_stop_pending"}, {...stopped(scope),admissionClosed:1},
      {...stopped(scope),extra:true}, {...stopped(scope),waitProof:"pid_absent"},
      {...stopped(scope),owner:{...scope,generation:randomUUID()}}]) {
      expect(()=>verifiedSshRunScopeStop(scope,value)).toThrow("ssh_run_scope_unverified");
    }
    expect(()=>parseSshRunScope({...scope,runId:undefined})).toThrow();
    expect(()=>parseSshRunScope({...scope,leaseId:"../foreign"})).toThrow();
  });
});

const fixtures: Array<{scope:SshRunScope;temp:string;children:ChildProcess[]}> = [];
async function shell(command:string) {return exec("sh",["-c",command],{timeout:25000,maxBuffer:1024*1024});}
async function fixture(source?:string|((temp:string)=>string)){
  const temp=await mkdtemp(path.join(os.tmpdir(),"ssh-scope-kernel-"));
  const probe=JSON.parse((await shell(sshRunScopeProbe(temp))).stdout);
  const scope={...owner(),bootId:probe.bootId};
  const item={scope,temp,children:[] as ChildProcess[]};fixtures.push(item);
  const code=typeof source==="function"?source(temp):source;
  const prepared=JSON.parse((code ? await exec("python3",["-c",code,"prepare",JSON.stringify(scope)],{timeout:5000}) : await shell(sshRunScopeControl("prepare",scope))).stdout);
  expect(prepared).toEqual({owner:scope,phase:"open"});
  return item;
}
async function eventually<T>(read:()=>Promise<T>,matches:(value:T)=>boolean):Promise<T>{
  const end=Date.now()+4000;
  while(Date.now()<end){try{const value=await read();if(matches(value))return value;}catch{}
    await new Promise(resolve=>setTimeout(resolve,20));}
  throw Error("fixture did not become ready");
}
function launch(f:Awaited<ReturnType<typeof fixture>>,script:string){
  const child=spawn("sh",["-c","exec "+supervisedSshCommand(f.scope,script)],{stdio:"ignore"});
  f.children.push(child);return child;
}
function exited(child:ChildProcess){return new Promise<number|null>((resolve,reject)=>{
  if(child.exitCode!==null||child.signalCode!==null)return resolve(child.exitCode);
  child.once("error",reject);child.once("close",resolve);
});}
async function stop(f:Awaited<ReturnType<typeof fixture>>){
  const ack=JSON.parse((await shell(sshRunScopeControl("stop",f.scope))).stdout);
  return verifiedSshRunScopeStop(f.scope,ack);
}
afterEach(async()=>{
  for(const f of fixtures.splice(0)){
    // No deletion until the exact fixture's owned descendant tree is proven stopped.
    await stop(f);
    await Promise.all(f.children.map(exited));
    const root=path.join(os.homedir(),".local/state/paperclip/ssh-scopes-v1",f.scope.leaseId);
    expect(path.basename(root)).toBe(f.scope.leaseId);
    await rm(root,{recursive:true});await rm(f.temp,{recursive:true});
  }
});

describe.skipIf(process.platform!=="linux")("SSH supervised Linux descendant ownership",()=>{
  it.skipIf(process.arch!=="x64")("waits for a raw clone child with zero exit signal",async()=>{
    // Change only the fixture's fork producer, not the waiter/gate/stop logic.
    // Unlike CLONE_PARENT, this truly creates a supervisor child with signal0.
    // execve resets exit_signal to SIGCHLD; keep this fixture child before exec.
    const f=await fixture(temp=>SSH_RUN_SUPERVISOR_SOURCE.replace("pid = os.fork()",
      `pid = ctypes.CDLL(None).syscall(56, 0, 0, 0, 0, 0)\n                        if pid == 0:\n                            pathlib.Path(${JSON.stringify(path.join(temp,"clone-pid"))}).write_text(str(os.getpid()))\n                            time.sleep(60)`));
    const marker=path.join(f.temp,"clone-pid");
    const client=launch(f,"true");
    const pid=Number(await eventually(()=>readFile(marker,"utf8"),x=>/^\d+$/.test(x)));
    const fields=(await readFile(`/proc/${pid}/stat`,"utf8")).split(")").at(-1)!.trim().split(/\s+/);
    expect(Number(fields[35])).toBe(0);
    const started=Date.now();await stop(f);
    expect(Date.now()-started).toBeLessThan(5000);
    expect(()=>process.kill(pid,0)).toThrow();await exited(client);
  },30000);

  it("reaps setsid/double-fork descendants and leaves unrelated work intact",async()=>{
    const f=await fixture(),marker=path.join(f.temp,"detached");
    const unrelated=spawn("sleep",["60"],{stdio:"ignore"});
    try{
      const program=`import os,time,pathlib\nif os.fork():os._exit(0)\nos.setsid()\nif os.fork():os._exit(0)\npathlib.Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))\ntime.sleep(60)`;
      const programPath=path.join(f.temp,"detached.py");await writeFile(programPath,program);
      const client=launch(f,`python3 '${programPath}'`);
      const pid=Number(await eventually(()=>readFile(marker,"utf8"),x=>/^\d+$/.test(x)));
      expect(await exited(client)).toBe(0);
      process.kill(pid,0);
      expect(await stop(f)).toEqual(stopped(f.scope));
      expect(()=>process.kill(pid,0)).toThrow();
      expect(unrelated.exitCode).toBeNull();process.kill(unrelated.pid!,0);
      await expect(shell(supervisedSshCommand(f.scope,"touch '"+path.join(f.temp,"late")+"'"))).rejects.toMatchObject({code:125});
      await expect(shell(sshRunScopeControl("prepare",f.scope))).rejects.toMatchObject({code:125});
      expect(await stop(f)).toEqual(stopped(f.scope));
    }finally{unrelated.kill("SIGTERM");await exited(unrelated);}
  },30000);

  it("keeps ownership after the transport client disappears",async()=>{
    const f=await fixture(),marker=path.join(f.temp,"pid");
    const programPath=path.join(f.temp,"work.py");
    await writeFile(programPath,`import os,time,pathlib\npathlib.Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))\ntime.sleep(60)`);
    const client=launch(f,`exec python3 '${programPath}'`);
    const pid=Number(await eventually(()=>readFile(marker,"utf8"),x=>/^\d+$/.test(x)));
    client.kill("SIGKILL");await exited(client);process.kill(pid,0);
    await stop(f);expect(()=>process.kill(pid,0)).toThrow();
  },30000);

  it("serializes concurrent commands with Stop and permanently closes admission",async()=>{
    const f=await fixture();
    const clients=Array.from({length:12},(_,index)=>launch(f,`sleep 0.1; touch '${path.join(f.temp,String(index))}'`));
    await stop(f);await Promise.all(clients.map(exited));
    for(let i=0;i<3;i++)await expect(shell(supervisedSshCommand(f.scope,"true"))).rejects.toMatchObject({code:125});
    expect(await stop(f)).toEqual(stopped(f.scope));
  },30000);

  it("preserves argv, profile shell quoting and stdin without persisting command data",async()=>{
    const f=await fixture();
    const payload="literal 'quote' $(printf unsafe) `printf unsafe`";
    // Exercise FD transfer directly; command data must never enter state files.
    const child=spawn("sh",["-c",supervisedSshCommand(f.scope,"cat")],{stdio:["pipe","pipe","pipe"]});f.children.push(child);
    let output="";child.stdout!.on("data",chunk=>{output+=String(chunk);});child.stdin!.end(payload);
    expect(await exited(child)).toBe(0);expect(output).toBe(payload);
    await stop(f);
    const state=await readFile(path.join(os.homedir(),".local/state/paperclip/ssh-scopes-v1",f.scope.leaseId,"state.json"),"utf8");
    expect(state).not.toContain(payload);expect(state).not.toContain("cat");
  },30000);

  it("distinguishes trusted transport startup from supervised runtime profiles",async()=>{
    const f=await fixture(),marker=path.join(f.temp,"outside.pid"),program=path.join(f.temp,"outside.py"),rc=path.join(f.temp,"bootstrap.rc");
    await writeFile(program,`import os,pathlib,time\npathlib.Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))\ntime.sleep(60)`);
    await writeFile(rc,`python3 '${program}' </dev/null >/dev/null 2>&1 &\n`);
    let pid=0;
    try{
      // Controlled noninteractive shell-rc fixture. SSHD's real login startup
      // has the same outside-owner ancestry; never edit the operator's rc file.
      // A socket stdin makes Bash take its remote-shell .bashrc branch and
      // ignore BASH_ENV. Use /dev/null so this fixture tests the stated rc.
      const startup=spawn("bash",["-c",supervisedSshCommand(f.scope,"true")],
        {env:{...process.env,BASH_ENV:rc},stdio:"ignore"});
      f.children.push(startup);expect(await exited(startup)).toBe(0);
      pid=Number(await eventually(()=>readFile(marker,"utf8"),x=>/^\d+$/.test(x)));
      await stop(f);process.kill(pid,0);
      // This is an unsupported spawning bootstrap, not whole-host stop proof.
      // Clean only the fixture's exact process through a verified pidfd.
    }finally{
      if(pid)await exec("python3",["-c","import os,pathlib,signal,sys; p=int(sys.argv[1]); fd=os.pidfd_open(p); assert sys.argv[2].encode() in pathlib.Path('/proc/'+str(p)+'/cmdline').read_bytes(); signal.pidfd_send_signal(fd,signal.SIGKILL); os.close(fd)",String(pid),program]);
    }
  },30000);
});
