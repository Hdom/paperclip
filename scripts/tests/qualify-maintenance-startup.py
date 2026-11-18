"""Run actual server startup tests in an owned loopback-only network namespace.

Root sets up the fixture; Vitest, PostgreSQL and Paperclip run as the explicit
unprivileged test owner. This shares the host filesystem, not strong isolation.
Never receives production credentials or changes a service/unit/firewall.
"""
import argparse, json, os, pathlib, pwd, signal, subprocess, time, uuid

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--user',required=True);parser.add_argument('--node-bin',required=True)
    args=parser.parse_args();owner=pwd.getpwnam(args.user);node=pathlib.Path(args.node_bin).resolve()
    if os.geteuid()!=0 or owner.pw_uid<1000 or not (node/'node').is_file() or not (node/'corepack').is_file():
        raise ValueError('Root fixture setup, explicit unprivileged owner and supported cached Node required')
    if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):raise ValueError('Identity-bound cleanup required')
    namespace='pcmaint'+uuid.uuid4().hex[:8];created=False;identity=None
    run=lambda *argv:subprocess.check_output(argv,stderr=subprocess.PIPE)
    try:
        run('ip','netns','add',namespace);created=True
        stat=os.stat('/var/run/netns/'+namespace);identity=(stat.st_dev,stat.st_ino)
        run('ip','netns','exec',namespace,'ip','link','set','lo','up')
        routes=json.loads(run('ip','netns','exec',namespace,'ip','-j','route','show','table','all'))
        if any(r.get('dst')=='default' for r in routes):raise ValueError('Fixture must have no default route')
        env={'HOME':owner.pw_dir,'USER':args.user,'LOGNAME':args.user,'PATH':str(node)+':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
             'COREPACK_ENABLE_NETWORK':'0','PAPERCLIP_TEST_MAINTENANCE_STARTUP_ISOLATED':'1','PAPERCLIP_TELEMETRY_DISABLED':'1','DO_NOT_TRACK':'1'}
        repo=pathlib.Path(__file__).resolve().parents[2]
        result=subprocess.run(['ip','netns','exec',namespace,'runuser','-u',args.user,'--',str(node/'corepack'),'pnpm','exec','vitest','run',
            'server/src/__tests__/maintenance-startup-integration.test.ts','--maxWorkers=1'],cwd=repo,env=env)
        return result.returncode
    finally:
        if created:
            stat=os.stat('/var/run/netns/'+namespace)
            if (stat.st_dev,stat.st_ino)!=identity:raise RuntimeError('Owned namespace changed; refusing cleanup')
            def members():return [int(p) for p in run('ip','netns','pids',namespace).split()]
            for sig in (signal.SIGTERM,signal.SIGKILL):
                pids=members()
                if len(pids)>1000:raise RuntimeError('Unexpected fixture process count')
                for pid in pids:
                    fd=None
                    try:
                        fd=os.pidfd_open(pid);stat=os.stat('/proc/'+str(pid)+'/ns/net')
                        if (stat.st_dev,stat.st_ino)==identity:signal.pidfd_send_signal(fd,sig)
                    except (ProcessLookupError,FileNotFoundError):pass
                    finally:
                        if fd is not None:os.close(fd)
                deadline=time.monotonic()+2
                while members() and time.monotonic()<deadline:time.sleep(.05)
                if not members():break
            if members():raise RuntimeError('Fixture processes remain; namespace retained for inspection')
            run('ip','netns','delete',namespace)
            print(json.dumps({'maintenanceFixtureNamespaceRemoved':True,'productionAccess':False}))

if __name__=='__main__':raise SystemExit(main())
