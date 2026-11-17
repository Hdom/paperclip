"""Synthetic SSH qualification with a separate network namespace, no Docker.
Run as root with --user <unprivileged test owner> --node-bin <supported Node bin>.
The worker has no default route; production target admission remains unchanged.
This is network separation only: both processes still share this test host's FS.
"""
import argparse, ipaddress, json, os, pathlib, pwd, shutil, signal, subprocess, tempfile, uuid, time, threading

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--user',required=True);parser.add_argument('--node-bin',required=True);parser.add_argument('--case',choices=['all','coordinator','recovery','workflow','chain','faults','ownership','guards'],default='all');parser.add_argument('--handoff-pool-max',type=int,choices=[1,10],default=10)
 args=parser.parse_args();owner=pwd.getpwnam(args.user)
 if os.geteuid()!=0 or owner.pw_uid<1000 or not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):raise ValueError('Root fixture setup and unprivileged test owner required')
 node=pathlib.Path(args.node_bin).resolve();repo=pathlib.Path(__file__).resolve().parents[2]
 if not node.is_absolute() or not (node/'node').is_file() or not (node/'corepack').exists():raise ValueError('Supported Node and pnpm required')
 root=pathlib.Path(tempfile.mkdtemp(prefix='paperclip-isolated-ssh-'));root.chmod(0o700)
 token=uuid.uuid4().hex[:8];namespace='pcq'+token;hostlink='pcqh'+token;peer='pcqw'+token
 daemon=None;daemon_reader=None;daemon_tail=bytearray();daemon_reader_errors=[];namespace_created=False;link_created=False;namespace_identity=None
 def run(*argv,**kwargs):return subprocess.run(argv,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)
 try:
  subnet=ipaddress.ip_network('192.0.2.0/30')
  routes=json.loads(run('ip','-j','-4','route','show','table','all').stdout)
  addresses=json.loads(run('ip','-j','-4','addr','show').stdout)
  prefixes=[entry['dst'] for entry in routes if entry.get('dst') not in (None,'default','0.0.0.0/0')]
  prefixes += [str(entry['local'])+'/'+str(entry['prefixlen']) for interface in addresses for entry in interface.get('addr_info',[]) if entry.get('family')=='inet']
  if any(subnet.overlaps(ipaddress.ip_network(prefix,strict=False)) for prefix in prefixes):raise ValueError('Reserved synthetic test subnet overlaps an existing route/address')
  runtime=pathlib.Path('/run/sshd')
  if not runtime.exists():runtime.mkdir(mode=0o755)
  info=runtime.lstat()
  if runtime.resolve()!=runtime or not runtime.is_dir() or info.st_uid!=0 or info.st_mode&0o022:raise ValueError('Safe fixed SSH runtime directory required')
  run('ip','netns','add',namespace);namespace_created=True
  info=os.stat('/var/run/netns/'+namespace);namespace_identity=(info.st_dev,info.st_ino)
  run('ip','link','add',hostlink,'type','veth','peer','name',peer);link_created=True
  run('ip','link','set',peer,'netns',namespace)
  run('ip','addr','add','192.0.2.1/30','dev',hostlink);run('ip','link','set',hostlink,'up')
  run('ip','netns','exec',namespace,'ip','addr','add','192.0.2.2/30','dev',peer)
  run('ip','netns','exec',namespace,'ip','link','set',peer,'up');run('ip','netns','exec',namespace,'ip','link','set','lo','up')
  for name in ('client_key','host_key'):run('ssh-keygen','-q','-t','ed25519','-N','','-f',str(root/name))
  (root/'authorized_keys').write_bytes((root/'client_key.pub').read_bytes())
  public=run('ssh-keygen','-y','-f',str(root/'host_key')).stdout.decode().strip()
  (root/'known_hosts').write_text('[192.0.2.2]:2222 '+public+'\n')
  (root/'workspace').mkdir(mode=0o700)
  # Hosted runners can have a locked password field. PAM performs its normal
  # account/session checks while authentication remains generated-public-key
  # only. Never unlock or otherwise modify the ambient runner account.
  account=run('passwd','-S',args.user).stdout.decode().split()
  print(json.dumps({'fixtureAccountPasswordState':account[1] if len(account)>1 else 'unknown'}),flush=True)
  (root/'sshd_config').write_text('\n'.join([
   'Port 2222','ListenAddress 192.0.2.2','HostKey '+str(root/'host_key'),'PidFile '+str(root/'sshd.pid'),
   'AuthorizedKeysFile '+str(root/'authorized_keys'),'PasswordAuthentication no','KbdInteractiveAuthentication no',
   'PubkeyAuthentication yes','PermitRootLogin no','UsePAM yes','StrictModes no','AllowUsers '+args.user,'LogLevel INFO'])+'\n')
  for file in root.iterdir():
   os.chown(file,owner.pw_uid,owner.pw_gid);file.chmod(0o700 if file.is_dir() else 0o600)
  os.chown(root,owner.pw_uid,owner.pw_gid)
  daemon=subprocess.Popen(['ip','netns','exec',namespace,'/usr/sbin/sshd','-D','-e','-f',str(root/'sshd_config')],
   stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,start_new_session=True)
  # Keep draining throughout the suite: an unread stderr PIPE eventually
  # blocks sshd and turns larger matrices into false lease-acquisition errors.
  # Retain only a bounded synthetic diagnostic tail, never an unbounded log.
  def drain_daemon():
   try:
    while True:
     chunk=os.read(daemon.stderr.fileno(),4096)
     if not chunk:break
     daemon_tail.extend(chunk)
     if len(daemon_tail)>2000:del daemon_tail[:-2000]
   except Exception as error:daemon_reader_errors.append(type(error).__name__)
  daemon_reader=threading.Thread(target=drain_daemon,daemon=True);daemon_reader.start()
  config={'host':'192.0.2.2','port':2222,'username':args.user,'remoteWorkspacePath':str(root/'workspace'),
   'privateKeyPath':str(root/'client_key'),'knownHostsPath':str(root/'known_hosts'),'strictHostKeyChecking':True}
  fixture=root/'fixture.json';fixture.write_text(json.dumps(config));fixture.chmod(0o600);os.chown(fixture,owner.pw_uid,owner.pw_gid)
  environment={'HOME':owner.pw_dir,'USER':args.user,'LOGNAME':args.user,'PATH':str(node)+':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
   'COREPACK_ENABLE_NETWORK':'0','PAPERCLIP_TEST_ISOLATED_SSH_FIXTURE':str(fixture)}
  if args.handoff_pool_max==1:environment['PAPERCLIP_TEST_HANDOFF_DB_POOL_MAX']='1'
  result=subprocess.run(['runuser','-u',args.user,'--',str(node/'corepack'),'pnpm','exec','vitest','run',
   'server/src/__tests__/retained-ssh-workspace-integration.test.ts']+([] if args.case=='all' else ['-t',{'coordinator':'fresh Coordinator','recovery':'preserves immutable','workflow':'actual Codex adapter','chain':'actual Codex adapter.*chain','faults':'actual Codex adapter.*(cancel|provider_failed|doc_changed|unsafe_link|restart|drain)','ownership':'actual Codex adapter.*(older_writer|db_disconnect)','guards':'actual Codex adapter.*(doc_changed|unsupported_workspace)'}[args.case]]),cwd=repo,env=environment)
  return result.returncode
 finally:
  errors=[];empty=not namespace_created
  if namespace_created:
   try:
    info=os.stat('/var/run/netns/'+namespace)
    if (info.st_dev,info.st_ino)!=namespace_identity:raise RuntimeError('Owned network namespace identity changed')
    def members():
     pids=[int(value) for value in run('ip','netns','pids',namespace).stdout.split()]
     if len(pids)>1000:raise RuntimeError('Unexpected fixture process count')
     return pids
    for sig in (signal.SIGTERM,signal.SIGKILL):
     for pid in members():
      descriptor=None
      try:
       descriptor=os.pidfd_open(pid)
       identity=os.stat('/proc/'+str(pid)+'/ns/net')
       if (identity.st_dev,identity.st_ino)==namespace_identity:signal.pidfd_send_signal(descriptor,sig)
      except ProcessLookupError:pass
      except FileNotFoundError:pass
      finally:
       if descriptor is not None:os.close(descriptor)
     deadline=time.monotonic()+2
     while members() and time.monotonic()<deadline:time.sleep(0.05)
     if not members():break
    empty=not members()
    if not empty:raise RuntimeError('Owned fixture processes remain; retained namespace for inspection')
   except Exception as error:errors.append(type(error).__name__+': '+str(error))
  if daemon:
   try:
    daemon.wait(timeout=5)
    if daemon_reader:
     daemon_reader.join(timeout=5)
     if daemon_reader.is_alive():raise RuntimeError('Fixture diagnostic reader did not settle')
    if daemon_reader_errors:raise RuntimeError('Fixture diagnostic reader failed: '+daemon_reader_errors[0])
    if daemon_tail:print(daemon_tail.decode(errors='replace'))
   except Exception as error:errors.append('Fixture daemon join: '+type(error).__name__)
   finally:daemon.stderr.close()
  if link_created:
   try:run('ip','link','del',hostlink)
   except Exception as error:errors.append('Fixture link cleanup: '+type(error).__name__)
  if namespace_created and empty:
   try:run('ip','netns','del',namespace)
   except Exception as error:errors.append('Fixture namespace cleanup: '+type(error).__name__)
  if empty and root.parent==pathlib.Path('/tmp') and root.name.startswith('paperclip-isolated-ssh-') and root.resolve()==root:shutil.rmtree(root)
  if errors:raise RuntimeError('; '.join(errors))
if __name__=='__main__':raise SystemExit(main())
