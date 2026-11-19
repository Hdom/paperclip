"""Actual immutable packaged CLI under a protected config and strict saved hold.

Synthetic populated TEMPLATE clone; loopback-only owned namespace. Runs the
real packaged CLI and dependencies after UID/GID/group/NNP drop. Systemd manager
installation is deliberately not exercised. No production config/key is read.
"""
import argparse,hashlib,importlib.util,json,os,pathlib,pwd,queue,shutil,signal,stat,subprocess,sys,tarfile,threading,time,urllib.request,uuid
sys.dont_write_bytecode=True
REPO=pathlib.Path(__file__).resolve().parents[2]

def load(file,name):
 spec=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def digest_file(file):
 h=hashlib.sha256()
 with file.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()

class Child:
 def __init__(self,args,**options):
  self.process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,start_new_session=True,**options)
  self.lines=queue.Queue();self.tail=''
  def read(stream):
   for line in iter(stream.readline,''):
    self.tail=(self.tail+line)[-12000:]
    if line.startswith('MAINTENANCE_CLI_FIXTURE:'):self.lines.put(json.loads(line.split(':',1)[1]))
  self.threads=[threading.Thread(target=read,args=(s,),daemon=True) for s in (self.process.stdout,self.process.stderr)]
  for t in self.threads:t.start()
 def result(self,kind,timeout=100):
  end=time.monotonic()+timeout
  while time.monotonic()<end:
   try:
    value=self.lines.get(timeout=.1)
    if value.get('kind')!=kind:raise AssertionError('Unexpected fixture response')
    return value
   except queue.Empty:
    if self.process.poll() is not None:raise AssertionError('Fixture exited: '+self.tail[-4000:])
  raise AssertionError('Fixture response deadline: '+self.tail[-4000:])
 def send(self,value):self.process.stdin.write(json.dumps(value)+'\n');self.process.stdin.flush()
 def settled(self):
  code=self.process.wait(timeout=60)
  for t in self.threads:t.join(timeout=2)
  if code!=0:raise AssertionError('Fixture did not settle successfully: '+self.tail[-4000:])

# Only imported by the fixture's root child. Production entry has no overrides.
def launch_fixture(options):
 root=pathlib.Path(options['root'])
 if os.geteuid()!=0 or root.parent!=pathlib.Path('/var/lib') or not root.name.startswith('paperclip-cli-qualification-'):raise ValueError('Owned root fixture required')
 m=load(REPO/'scripts/operations/maintenance-host.py','host_cli_fixture')
 m.CONFIG=root/'trusted/config.json';m.DOTENV=root/'trusted/.env';m.ENVIRONMENT=root/'trusted/service.env';m.DATA_HOME=root/'data';m.POLICY=root/'private/policy.json';m.EPOCH=root/'private/epoch.json'
 policy=json.loads(m.protected_read(m.POLICY)[0])
 capsule,manifest=m.verify_candidate(policy)
 url,environment=m.load_authority(policy)
 request={k:policy[k] for k in ('identity','expectedGeneration','requestId','approvalReference','operatorNote')}
 request.update(mode='guard',databaseUrl=url,**m.epoch_request(policy,json.loads(m.protected_read(m.EPOCH)[0])))
 observed=m.call_runtime(policy,request)
 if observed['state']!='held':raise AssertionError('Actual independent guard did not verify held')
 m.verify_server_resolution(policy,capsule,manifest)
 m.drop_and_exec(capsule,manifest,environment,service_name=options['user'],working_directory=str(root/'data'),home_directory=str(root/'data/home'))

def exercise(root,args,namespace):
 owner=pwd.getpwnam(args.user);node=pathlib.Path(args.node_bin)/'node'
 for folder in ['data','data/home','data/cwd','data/logs','data/storage','data/secrets','data/instances','data/instances/default','data/build','data/tmp']:
  p=root/folder;p.mkdir(mode=0o700);os.chown(p,owner.pw_uid,owner.pw_gid)
 trusted=root/'trusted';trusted.mkdir(mode=0o750);os.chown(trusted,0,owner.pw_gid)
 private=root/'private';private.mkdir(mode=0o700)
 env={'HOME':str(root/'data/home'),'USER':args.user,'LOGNAME':args.user,'PATH':args.node_bin+':/usr/sbin:/usr/bin:/sbin:/bin','TMPDIR':str(root/'data/tmp'),'COREPACK_ENABLE_NETWORK':'0','PAPERCLIP_TELEMETRY_DISABLED':'1','DO_NOT_TRACK':'1'}
 operatorBuild=root/'data/build/runtime'
 subprocess.run(['runuser','-u',args.user,'--',str(node),str(REPO/'scripts/operations/build-maintenance-runtime.mjs'),str(operatorBuild)],cwd=REPO,env=env,check=True,capture_output=True)
 operator=root/'operator';shutil.copytree(operatorBuild,operator)
 for p in [operator,*operator.rglob('*')]:p.chmod(0o755 if p.is_dir() or p.name=='node' else 0o644)
 operatorManifest=private/'operator.json';shutil.copyfile(str(operatorBuild)+'.manifest.json',operatorManifest);operatorManifest.chmod(0o600)
 capsule=root/'payload';shutil.copyfile(node,capsule/'operator-node');(capsule/'operator-node').chmod(0o755)
 host=load(REPO/'scripts/operations/maintenance-host.py','host_cli_parent');creator=load(REPO/'scripts/operations/manifest-maintenance-capsule.py','cli_manifest')
 manifest=creator.inventory(capsule,args.source)
 capsuleManifest=private/'capsule.json';capsuleManifest.write_text(json.dumps(manifest));capsuleManifest.chmod(0o600)
 host.CONFIG=trusted/'config.json';host.DOTENV=trusted/'.env';host.ENVIRONMENT=trusted/'service.env';host.DATA_HOME=root/'data';host.POLICY=private/'policy.json';host.EPOCH=private/'epoch.json'
 bridge=Child(['runuser','-u',args.user,'--',str(node),str(REPO/'scripts/tests/fixtures/maintenance-cli-database.mjs'),str(capsule)],cwd=root/'data/cwd',env=env,stdin=subprocess.PIPE)
 ready=bridge.result('ready')
 policy={'schema':'paperclip.maintenance-host-policy.v1','operatorRoot':str(operator),'operatorManifest':str(operatorManifest),'operatorManifestSha256':host.digest(operatorManifest.read_bytes()),'capsule':str(capsule),'capsuleManifest':str(capsuleManifest),'capsuleManifestSha256':host.digest(capsuleManifest.read_bytes()),'sourceCommit':args.source,'identity':ready['identity'],'expectedGeneration':0,'requestId':str(uuid.uuid4()),'approvalReference':'synthetic-packaged-cli-only','operatorNote':'Synthetic private fixture note'}
 request={**{k:policy[k] for k in ('identity','expectedGeneration','requestId','approvalReference','operatorNote')},'databaseUrl':ready['databaseUrl'],'mode':'inspect'}
 before=host.call_runtime(policy,request)
 initialized=host.call_runtime(policy,{**request,'mode':'initialize','baseline':before['inventory']})
 if initialized['state']!='held':raise AssertionError('Synthetic clone did not reach strict held')
 policy['baseline']=before['inventory']
 host.POLICY.write_text(json.dumps(policy));host.POLICY.chmod(0o600);host.install_epoch(policy,initialized)
 settings={
  'PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS':json.dumps([str(root/'data/work-source')],separators=(',',':')),
  'PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS':json.dumps([str(root/'data/work-output')],separators=(',',':')),
  'PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS':json.dumps([{'host':'fixture.invalid','user':'synthetic-worker','port':2222}],separators=(',',':')),
  'PAPERCLIP_CONTROLLER_PROTECTED_PATHS':json.dumps([str(trusted),str(private)],separators=(',',':')),
 }
 config={'$meta':{'version':1,'updatedAt':'2026-01-01T00:00:00Z','source':'onboard'},'database':{'mode':'postgres','connectionString':ready['databaseUrl'],'backup':{'enabled':False}},'logging':{'mode':'file','logDir':str(root/'data/logs')},'server':{'deploymentMode':'local_trusted','exposure':'private','host':'127.0.0.1','port':3100,'serveUi':False},'auth':{'baseUrlMode':'auto'},'storage':{'provider':'local_disk','localDisk':{'baseDir':str(root/'data/storage')}},'secrets':{'provider':'local_encrypted','strictMode':False,'localEncrypted':{'keyFilePath':str(root/'data/secrets/master.key')}},'telemetry':{'enabled':False},'updates':{'checkEnabled':False}}
 host.CONFIG.write_text(json.dumps(config));host.DOTENV.write_text('PAPERCLIP_SECRETS_MASTER_KEY='+('47'*32)+'\nPAPERCLIP_AGENT_JWT_SECRET=synthetic-packaged-cli-jwt-not-a-production-secret-123456789\n')
 host.ENVIRONMENT.write_bytes(b'HOST=127.0.0.1\nPORT=3100\nSERVE_UI=false\nPAPERCLIP_DB_BACKUP_ENABLED=false\nPAPERCLIP_TELEMETRY_DISABLED=1\nDO_NOT_TRACK=1\nPAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS=1\n'+host.canonical_policy_assignments(settings))
 for p in (host.CONFIG,host.DOTENV,host.ENVIRONMENT):os.chown(p,0,owner.pw_gid);p.chmod(0o640)
 policy['configDigests']={k:host.digest(p.read_bytes()) for k,p in [('config',host.CONFIG),('dotenv',host.DOTENV),('environment',host.ENVIRONMENT)]}
 host.POLICY.write_text(json.dumps(policy));host.POLICY.chmod(0o600)
 runtime=root/'data/instances/default/runtime-info.json';cli=None;checks=[]
 options={'root':str(root),'user':args.user}
 try:
  # Reproduce the former cutover proposal with the real CLI: protecting
  # its writable instance root makes the atomic runtime-info write fail.
  instance=root/'data/instances/default';os.chown(instance,0,0);instance.chmod(0o755)
  broken=Child(['/usr/bin/python3','-I','-S','-B',str(pathlib.Path(__file__).resolve()),'--fixture-launch',json.dumps(options)],cwd='/',env={'PATH':'/usr/bin:/bin','HOME':'/root'},stdin=subprocess.DEVNULL)
  try:
   code=broken.process.wait(timeout=100)
   if code==0 or 'runtime-info' not in broken.tail or 'EACCES' not in broken.tail:raise AssertionError('Legacy ownership failure not reproduced: '+broken.tail[-4000:])
   if runtime.exists():raise AssertionError('Protected legacy root unexpectedly wrote runtime metadata')
  finally:
   if broken.process.poll() is None:broken.process.send_signal(signal.SIGTERM);broken.process.wait(timeout=60)
   os.chown(instance,owner.pw_uid,owner.pw_gid);instance.chmod(0o700)
  for iteration in range(2):
   command=['/usr/bin/python3','-I','-S','-B',str(pathlib.Path(__file__).resolve()),'--fixture-launch',json.dumps(options)]
   cli=Child(command,cwd='/',env={'PATH':'/usr/bin:/bin','HOME':'/root'},stdin=subprocess.DEVNULL)
   end=time.monotonic()+100
   while time.monotonic()<end:
    if cli.process.poll() is not None:raise AssertionError('Actual packaged CLI failed: '+cli.tail[-5000:])
    if runtime.exists():
     try:
      with urllib.request.urlopen('http://127.0.0.1:3100/api/instance/maintenance',timeout=1) as response:state=json.load(response)
      if state.get('state')=='held':break
     except (OSError,ValueError):pass
    time.sleep(.1)
   else:raise AssertionError('Actual CLI did not become ready: '+cli.tail[-5000:])
   info=json.loads(runtime.read_text());assert info['pid']==cli.process.pid
   proc=pathlib.Path('/proc')/str(cli.process.pid);status=(proc/'status').read_text();assert ('NoNewPrivs:\t1' in status)
   assert all(int(v)==owner.pw_uid for v in next(l for l in status.splitlines() if l.startswith('Uid:')).split()[1:])
   assert next(l for l in status.splitlines() if l.startswith('Groups:')).strip()=='Groups:'
   actual=dict(item.split(b'=',1) for item in (proc/'environ').read_bytes().split(b'\0') if b'=' in item)
   assert all(actual[k.encode()].decode()==v for k,v in settings.items())
   assert actual[b'PAPERCLIP_CONFIG'].decode()==str(host.CONFIG)
   assert runtime.stat().st_uid==owner.pw_uid and host.CONFIG.stat().st_uid==0 and not host.CONFIG.stat().st_mode&0o022
   cli.process.send_signal(signal.SIGTERM);cli.settled();cli=None
   if runtime.exists():raise AssertionError('CLI runtime-info cleanup failed')
   bridge.send({'mode':'verify'});checks.append(bridge.result('verified'))
  # Exact old/incompatible epoch refuses before starting any app/CLI; the
  # held DB and original source/wake/ciphertext records remain untouched.
  original=host.EPOCH.read_bytes();bad=json.loads(original);bad['generation']=0;host.EPOCH.write_text(json.dumps(bad))
  refused=Child(['/usr/bin/python3','-I','-S','-B',str(pathlib.Path(__file__).resolve()),'--fixture-launch',json.dumps(options)],cwd='/',env={'PATH':'/usr/bin:/bin','HOME':'/root'},stdin=subprocess.DEVNULL)
  if refused.process.wait(timeout=60)==0 or runtime.exists():raise AssertionError('Stale epoch admitted actual CLI')
  host.EPOCH.write_bytes(original)
  bridge.send({'mode':'verify'});after=bridge.result('verified')
  assert checks[0]['retainedDigest']==checks[1]['retainedDigest']==after['retainedDigest']
  # Old pre-capability candidate and config tampering stay refused; no launch.
  capfile=(capsule/'node_modules/@paperclipai/server/dist/runtime-capabilities.json').resolve();old=capfile.read_bytes();capfile.write_text('{"schema":"paperclip.runtime-capabilities.v1","instanceMaintenance":0}')
  try:
   try:host.verify_candidate(policy)
   except host.Refusal:pass
   else:raise AssertionError('Unaware old candidate admitted')
  finally:capfile.write_bytes(old)
  bridge.send({'mode':'stop'});bridge.result('stopped');bridge.settled()
  return {'legacyProtectedDataRootFailureReproduced':True,'actualPackagedCliStartupRestart':True,'runtimeInfoCreatedAndRemoved':True,'actualPrivilegeDropAndNnp':True,'strictHoldAcrossRestart':True,'populatedCloneDomainsRetained':9,'effectivePolicyValuesUnchanged':True,'staleEpochAndUnawareRollbackRefused':True,'applicationSource':args.source,'operatorSource':json.loads(operatorManifest.read_text())['sourceCommit'],'systemdManagerInstalled':False,'productionAccess':False}
 finally:
  if cli and cli.process.poll() is None:cli.process.send_signal(signal.SIGTERM);cli.process.wait(timeout=60)
  if bridge.process.poll() is None:
   try:bridge.send({'mode':'stop'});bridge.settled()
   except Exception:raise RuntimeError('Synthetic DB owner did not settle; preserve fixture')

def main():
 p=argparse.ArgumentParser();p.add_argument('--user',required=True);p.add_argument('--node-bin',required=True);p.add_argument('--archive',required=True);p.add_argument('--sha256',required=True);p.add_argument('--source',required=True);args=p.parse_args()
 if os.geteuid()!=0 or pwd.getpwnam(args.user).pw_uid<1000:raise ValueError('Root setup and explicit unprivileged owner required')
 archive=pathlib.Path(args.archive).resolve()
 if not archive.is_file() or archive.stat().st_size>2*1024**3 or digest_file(archive)!=args.sha256:raise ValueError('Pinned bounded native artifact required')
 base=pathlib.Path('/var/lib')
 for x in (base,*base.parents):
  st=x.lstat()
  if x.resolve()!=x or st.st_uid!=0 or st.st_mode&0o022:raise ValueError('Already protected fixture base required')
 root=base/('paperclip-cli-qualification-'+uuid.uuid4().hex);root.mkdir(mode=0o755);identity=root.stat();namespace='pccli'+uuid.uuid4().hex[:8];created=False;ns_identity=None;settled=False
 run=lambda *a:subprocess.check_output(a,stderr=subprocess.PIPE)
 try:
  with tarfile.open(archive) as tar:
   members=tar.getmembers()
   if len(members)>300000 or sum(m.size for m in members)>8*1024**3:raise ValueError('Archive fixture bound exceeded')
   for m in members:
    n=pathlib.PurePosixPath(m.name)
    if n.is_absolute() or '..' in n.parts or not n.parts or n.parts[0]!='payload' or m.islnk() or not (m.isdir() or m.isfile() or m.issym()) or (not m.issym() and m.mode&0o6022):raise ValueError('Unsafe native fixture member')
   if not hasattr(tarfile,'data_filter'):raise ValueError('Safe archive data filter required')
   tar.extractall(root,members=members,filter='data')
  run('ip','netns','add',namespace);created=True;st=os.stat('/var/run/netns/'+namespace);ns_identity=(st.st_dev,st.st_ino)
  run('ip','netns','exec',namespace,'ip','link','set','lo','up')
  routes=json.loads(run('ip','netns','exec',namespace,'ip','-j','route','show','table','all'))
  if any(x.get('dst')=='default' for x in routes):raise ValueError('Owned loopback-only namespace required')
  options={'root':str(root),'args':vars(args),'namespace':namespace}
  result=subprocess.run(['ip','netns','exec',namespace,'/usr/bin/python3','-I','-S','-B',str(pathlib.Path(__file__).resolve()),'--fixture-exercise',json.dumps(options)],env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root'},check=False)
  if result.returncode:raise AssertionError('Actual packaged CLI qualification failed')
 finally:
  if created:
   st=os.stat('/var/run/netns/'+namespace)
   if (st.st_dev,st.st_ino)!=ns_identity:raise RuntimeError('Owned namespace changed; retained for inspection')
   for sig in (signal.SIGTERM,signal.SIGKILL):
    pids=[int(v) for v in run('ip','netns','pids',namespace).split()]
    if len(pids)>1000:raise RuntimeError('Fixture process bound exceeded')
    for pid in pids:
     fd=None
     try:
      fd=os.pidfd_open(pid);st=os.stat('/proc/'+str(pid)+'/ns/net')
      if (st.st_dev,st.st_ino)==ns_identity:signal.pidfd_send_signal(fd,sig)
     except (FileNotFoundError,ProcessLookupError):pass
     finally:
      if fd is not None:os.close(fd)
    end=time.monotonic()+3
    while run('ip','netns','pids',namespace).strip() and time.monotonic()<end:time.sleep(.05)
    if not run('ip','netns','pids',namespace).strip():break
   if run('ip','netns','pids',namespace).strip():raise RuntimeError('Owned fixture processes remain')
   run('ip','netns','delete',namespace);settled=True
  else:settled=True
  actual=root.lstat()
  if not settled or (actual.st_dev,actual.st_ino)!=(identity.st_dev,identity.st_ino) or not stat.S_ISDIR(actual.st_mode):raise RuntimeError('Owned fixture changed; no recursive cleanup')
  shutil.rmtree(root)
  print(json.dumps({'actualCliNamespaceRemoved':True,'fixtureFilesRemoved':True,'productionAccess':False}))

if __name__=='__main__':
 if len(sys.argv)==3 and sys.argv[1]=='--fixture-launch':launch_fixture(json.loads(sys.argv[2]))
 elif len(sys.argv)==3 and sys.argv[1]=='--fixture-exercise':
  o=json.loads(sys.argv[2]);print(json.dumps(exercise(pathlib.Path(o['root']),argparse.Namespace(**o['args']),o['namespace'])))
 else:main()
