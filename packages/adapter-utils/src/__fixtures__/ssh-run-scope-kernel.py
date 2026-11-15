"""Independent disposable Linux kernel boundary fixtures; no Paperclip tasks."""
import json, os, pathlib, pwd, signal, socket, struct, subprocess, sys, tempfile, time, uuid

source = pathlib.Path(__file__).with_name('ssh-run-supervisor.py')
root = pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir)/'.local/state/paperclip/ssh-scopes-v1'
C = r'''
#define _GNU_SOURCE
#include <sched.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc,char **argv) {
 long pid=syscall(SYS_clone, CLONE_PARENT|atoi(argv[2]),0,0,0,0);
 if(pid<0) return 80;
 if(pid==0) {FILE *f=fopen(argv[1],"w"); if(!f)_exit(81);fprintf(f,"%d",getpid());fclose(f);sleep(atoi(argv[3]));_exit(0);}
 return 0;
}
'''

def wait_for(fn, seconds=4):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if fn():return
        time.sleep(.02)
    raise AssertionError('fixture condition timed out')

def owner():
    return dict(schema='paperclip.ssh-run-scope.v1',companyId=str(uuid.uuid4()),runId=str(uuid.uuid4()),leaseId=str(uuid.uuid4()),generation=str(uuid.uuid4()),bootId=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip())

def rpc(o, mode, argv=None):
    args=[sys.executable,str(source),mode,json.dumps(o)]
    if argv is not None:args.append(json.dumps(argv))
    return subprocess.run(args,capture_output=True,text=True,timeout=25)

def close_fixture(o):
    result=rpc(o,'stop')
    assert result.returncode==0,result.stderr
    folder=root/o['leaseId']
    for p in folder.iterdir():p.unlink()
    folder.rmdir()

with tempfile.TemporaryDirectory(prefix='paperclip-scope-independent-') as d:
    d=pathlib.Path(d); (d/'clone.c').write_text(C)
    subprocess.run(['gcc','-Wall','-Wextra','-o',str(d/'clone'),str(d/'clone.c')],check=True,capture_output=True)
    for sig in (0,signal.SIGUSR1):
        for lifetime in (1,60):
            o=owner(); marker=d/o['leaseId']; pidfd=None
            try:
                assert rpc(o,'prepare').returncode==0
                client=subprocess.Popen([sys.executable,str(source),'exec',json.dumps(o),json.dumps([str(d/'clone'),str(marker),str(int(sig)),str(lifetime)])],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                wait_for(marker.exists);pid=int(marker.read_text());pidfd=os.pidfd_open(pid)
                effective_signal=int(pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[35])
                assert client.wait(timeout=4)==0
                if lifetime==1:time.sleep(1.2)
                # Successful prepare pings the same existing owner; no new daemon.
                assert rpc(o,'prepare').returncode==0,'notification killed/closed supervisor'
                before=time.monotonic(); result=rpc(o,'stop')
                assert result.returncode==0,result.stderr
                assert json.loads(result.stdout)==dict(owner=o,phase='stopped',waitProof='ECHILD_WALL',admissionClosed=True)
                wait_for(lambda:not pathlib.Path('/proc/'+str(pid)).exists())
                assert rpc(o,'exec',['/bin/true']).returncode==125
                assert rpc(o,'prepare').returncode==125
                assert rpc(o,'stop').stdout==result.stdout
                print(json.dumps(dict(case='clone_parent',exitSignal=int(sig),effectiveExitSignal=effective_signal,lifetime=lifetime,stoppedSeconds=round(time.monotonic()-before,3),passed=True)),flush=True)
            finally:
                if pidfd is not None:
                    try:signal.pidfd_send_signal(pidfd,signal.SIGKILL)
                    except ProcessLookupError:pass
                    os.close(pidfd)
                close_fixture(o)

    # Crash cannot be upgraded to positive proof or an implicitly reopened gate.
    o=owner();marker=d/o['leaseId'];pidfd=None;client=None
    try:
        assert rpc(o,'prepare').returncode==0
        connection=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET)
        connection.connect(str(root/o['leaseId']/'control.sock'))
        supervisor,uid,gid=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));connection.close()
        supervisor_fd=os.pidfd_open(supervisor)
        program='import os,pathlib,time;pathlib.Path('+repr(str(marker))+').write_text(str(os.getpid()));time.sleep(60)'
        client=subprocess.Popen([sys.executable,str(source),'exec',json.dumps(o),json.dumps([sys.executable,'-c',program])],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        wait_for(marker.exists);pidfd=os.pidfd_open(int(marker.read_text()))
        signal.pidfd_send_signal(supervisor_fd,signal.SIGKILL);os.close(supervisor_fd)
        assert client.wait(timeout=4)==125
        assert rpc(o,'stop').returncode==125
        assert rpc(o,'prepare').returncode==125
        assert json.loads((root/o['leaseId']/'state.json').read_text())['phase']=='open'
        print(json.dumps(dict(case='supervisor_crash',noStopProof=True,noReopen=True,passed=True)),flush=True)
    finally:
        if pidfd is not None:
            try:signal.pidfd_send_signal(pidfd,signal.SIGKILL)
            except ProcessLookupError:pass
            os.close(pidfd)
        if client:client.wait(timeout=4)
        # Only this unique fixture's files; the supervisor is confirmed killed.
        folder=root/o['leaseId']
        for p in folder.iterdir():p.unlink()
        folder.rmdir()
