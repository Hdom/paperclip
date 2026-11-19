"""Actual immutable packaged CLI under a protected config and strict saved hold.

Synthetic populated TEMPLATE clone; loopback-only owned namespace. Runs the
real packaged CLI and dependencies after UID/GID/group/NNP drop. Systemd manager
installation is deliberately not exercised. No production config/key is read.
"""
import argparse,hashlib,importlib.util,json,os,pathlib,posixpath,pwd,queue,shutil,signal,stat,subprocess,sys,tarfile,threading,time,urllib.request,uuid
sys.dont_write_bytecode=True
REPO=pathlib.Path(__file__).resolve().parents[2]

def load(file,name):
 spec=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def digest_file(file):
 h=hashlib.sha256()
 with file.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()

def extract_native_capsule(archive,root):
 # Materialize in phases so no archive-controlled symlink can redirect a
 # file write. Some Python3.10 data filters incorrectly interpret symlinks
 # relative to the archive root. Ordinary members still use data_filter;
 # link validation is explicit, relative to each link's physical parent.
 root=pathlib.Path(root)
 if root.resolve()!=root or not root.is_dir() or any(root.iterdir()):raise ValueError('New empty physical fixture required')
 with tarfile.open(archive) as tar:
  members=tar.getmembers();indexed={m.name.rstrip('/'):m for m in members}
  if len(members)>300000 or len(indexed)!=len(members):raise ValueError('Native member bound/uniqueness required')
  total=sum(m.size for m in members)
  for m in members:
   name=m.name.rstrip('/');n=pathlib.PurePosixPath(name)
   if n.is_absolute() or '..' in n.parts or not n.parts or n.parts[0]!='payload' or str(n)!=name or not (m.isdir() or m.isfile() or m.issym() or m.islnk()) or (not m.issym() and m.mode&0o6022):raise ValueError('Unsafe native fixture member')
   if m.issym():
    target=posixpath.normpath(posixpath.join(posixpath.dirname(name),m.linkname))
    if posixpath.isabs(m.linkname) or not (target=='payload' or target.startswith('payload/')):raise ValueError('Escaping native symlink')
   if m.islnk():
    target=indexed.get(m.linkname)
    if not target or not target.isfile() or target.islnk():raise ValueError('Hardlink target must be an authenticated ordinary member')
    total+=target.size
  if total>8*1024**3:raise ValueError('Expanded capsule bound exceeded')
  if not hasattr(tarfile,'data_filter'):raise ValueError('Safe ordinary-member filter required')
  tar.extractall(root,members=[m for m in members if not (m.issym() or m.islnk())],filter='data')
  for m in members:
   if not m.islnk():continue
   target=(root/m.linkname).resolve(strict=True);destination=root/m.name
   if not target.is_relative_to(root) or not target.is_file() or destination.parent.resolve(strict=True)!=destination.parent:raise ValueError('Unsafe hardlink materialization')
   with target.open('rb') as source,destination.open('xb') as output:shutil.copyfileobj(source,output,1024*1024)
   destination.chmod(m.mode&0o777)
  for m in members:
   if not m.issym():continue
   destination=root/m.name
   if destination.parent.resolve(strict=True)!=destination.parent:raise ValueError('Alias parent cannot receive archive members')
   destination.symlink_to(m.linkname)
  for m in members:
   if m.issym() and not (root/m.name).resolve(strict=True).is_relative_to(root/'payload'):raise ValueError('Resolved symlink escapes capsule')

class Child:
 def __init__(self,args,**options):
  self.process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,start_new_session=True,**options)
  self.lines=queue.Queue(maxsize=64);self.tail='';self.reader_errors=[]
  def read(stream):
   try:
    for line in iter(lambda:stream.readline(1024*1024+1),''):
     if len(line)>1024*1024:raise ValueError('Fixture output line bound exceeded')
     self.tail=(self.tail+line)[-12000:]
     if line.startswith('MAINTENANCE_CLI_FIXTURE:'):self.lines.put_nowait(json.loads(line.split(':',1)[1]))
   except Exception as error:self.reader_errors.append(type(error).__name__)
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
    if self.process.poll() is not None and not any(t.is_alive() for t in self.threads):raise AssertionError('Fixture exited: '+self.tail[-4000:])
  raise AssertionError('Fixture response deadline: '+self.tail[-4000:])
 def send(self,value):
  if self.process.stdin.closed:raise ValueError('Fixture input already closed')
  self.process.stdin.write(json.dumps(value)+'\n');self.process.stdin.flush()
  if value.get('mode')=='stop':self.process.stdin.close()
 def settled(self):
  code=self.process.wait(timeout=60)
  for t in self.threads:t.join(timeout=2)
  if any(t.is_alive() for t in self.threads) or self.reader_errors:raise AssertionError('Fixture output readers did not settle')
  for stream in (self.process.stdin,self.process.stdout,self.process.stderr):
   if stream:stream.close()
  if code!=0:raise AssertionError('Fixture did not settle successfully: '+self.tail[-4000:])

# Only imported by the fixture's root child. Production entry has no overrides.
def launch_fixture(options):
 root=pathlib.Path(options['root'])
 if os.geteuid()!=0 or root.parent!=pathlib.Path('/var/lib') or not root.name.startswith('paperclip-cli-qualification-'):raise ValueError('Owned root fixture required')
 m=load(root/'operator-transport/runtime/maintenance-host.py','host_cli_fixture')
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
 for folder in ['data','data/home','data/cwd','data/logs','data/storage','data/secrets','data/instances','data/instances/default','data/instances/default/secrets','data/build','data/tmp']:
  p=root/folder;p.mkdir(mode=0o700);os.chown(p,owner.pw_uid,owner.pw_gid)
 trusted=root/'trusted';trusted.mkdir(mode=0o750);os.chown(trusted,0,owner.pw_gid)
 private=root/'private';private.mkdir(mode=0o700)
 env={'HOME':str(root/'data/home'),'USER':args.user,'LOGNAME':args.user,'PATH':args.node_bin+':/usr/sbin:/usr/bin:/sbin:/bin','TMPDIR':str(root/'data/tmp'),'COREPACK_ENABLE_NETWORK':'0','PAPERCLIP_TELEMETRY_DISABLED':'1','DO_NOT_TRACK':'1'}
 operatorBuild=root/'data/build/runtime'
 subprocess.run(['runuser','-u',args.user,'--',str(node),str(REPO/'scripts/operations/build-maintenance-runtime.mjs'),str(operatorBuild)],cwd=REPO,env=env,check=True,capture_output=True)
 # Bind qualification to an actual local operator archive, then use its
 # extracted runtime/host/Node bytes. This is not a hosted release archive.
 operatorArchive=root/'local-operator-runtime.tar.gz'
 with tarfile.open(operatorArchive,'w:gz') as tar:
  tar.add(operatorBuild,arcname='runtime');tar.add(pathlib.Path(str(operatorBuild)+'.manifest.json'),arcname='runtime.manifest.json')
 operatorDigest=digest_file(operatorArchive);operatorExtract=root/'operator-transport';operatorExtract.mkdir(mode=0o755)
 with tarfile.open(operatorArchive) as tar:
  members=tar.getmembers()
  if len(members)>1000 or sum(m.size for m in members)>512*1024*1024:raise ValueError('Bounded independent operator archive required')
  for m in members:
   n=pathlib.PurePosixPath(m.name)
   if n.is_absolute() or '..' in n.parts or not (n.parts[0]=='runtime' or str(n)=='runtime.manifest.json') or not (m.isdir() or m.isfile()):raise ValueError('Unsafe independent operator member')
  tar.extractall(operatorExtract,members=members,filter='data')
 operator=operatorExtract/'runtime';operatorManifest=operatorExtract/'runtime.manifest.json'
 for p in [operator,*operator.rglob('*')]:p.chmod(0o755 if p.is_dir() or p.name=='node' else 0o644)
 operatorManifest.chmod(0o600)
 capsule=root/'payload';shutil.copyfile(operator/'node',capsule/'operator-node');(capsule/'operator-node').chmod(0o755)
 host=load(operator/'maintenance-host.py','host_cli_parent');creator=load(REPO/'scripts/operations/manifest-maintenance-capsule.py','cli_manifest')
 manifest=creator.inventory(capsule,args.source)
 capsuleManifest=private/'capsule.json';capsuleManifest.write_text(json.dumps(manifest));capsuleManifest.chmod(0o600)
 meta=capsuleManifest.stat();print(json.dumps({'actualCapsuleManifestMetadata':{'bytes':meta.st_size,'uid':meta.st_uid,'mode':oct(stat.S_IMODE(meta.st_mode)),'links':meta.st_nlink,'files':len(manifest['files']),'symlinks':len(manifest['links'])}}),flush=True)
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
   # Bind the changed capability to a self-consistent alternate manifest.
   # A stale original digest would only test generic tamper rejection.
   incompatible=json.loads(json.dumps(manifest));relative=capfile.relative_to(capsule).as_posix()
   incompatible['files'][relative]=host.digest(capfile.read_bytes())
   external=private/'incompatible-candidate.json';external.write_text(json.dumps(incompatible));external.chmod(0o600)
   alternate={**policy,'capsuleManifest':str(external),'capsuleManifestSha256':host.digest(external.read_bytes())}
   try:host.verify_candidate(alternate)
   except host.Refusal as error:
    if str(error)!='Candidate cannot honor persisted maintenance':raise
   else:raise AssertionError('Self-consistent unaware candidate admitted')
  finally:capfile.write_bytes(old)
  original_config=host.CONFIG.read_bytes();host.CONFIG.write_bytes(original_config+b'\n')
  try:
   try:host.load_authority(policy)
   except host.Refusal as error:
    if str(error)!='Service configuration changed':raise
   else:raise AssertionError('Changed trusted configuration admitted')
  finally:host.CONFIG.write_bytes(original_config)
  bridge.send({'mode':'stop'});bridge.result('stopped');bridge.settled()
  return {'legacyProtectedDataRootFailureReproduced':True,'actualPackagedCliStartupRestart':True,'runtimeInfoCreatedAndRemoved':True,'actualPrivilegeDropAndNnp':True,'strictHoldAcrossRestart':True,'populatedCloneDomainsRetained':9,'effectivePolicyValuesUnchanged':True,'staleEpochAndUnawareRollbackRefused':True,'applicationSource':args.source,'applicationArchiveSha256':args.sha256,'applicationArchiveBytes':pathlib.Path(args.archive).stat().st_size,'operatorSource':json.loads(operatorManifest.read_text())['sourceCommit'],'operatorArchiveProvenance':'locally built from clean exact source; not a GitHub release','operatorArchiveSha256':operatorDigest,'operatorArchiveBytes':operatorArchive.stat().st_size,'operatorManifestSha256':host.digest(operatorManifest.read_bytes()),'operatorNodeSha256':digest_file(operator/'node'),'protectedCapsuleManifestBytes':capsuleManifest.stat().st_size,'protectedCapsuleManifestSha256':host.digest(capsuleManifest.read_bytes()),'realCapsuleInventoryAndVerifier':True,'exactApplicationArchivePayloadPreserved':True,'preparedPayloadChanges':['independent physical copies of contained transport hardlinks','operator-node added from extracted pinned operator archive'],'systemdManagerInstalled':False,'productionAccess':False}
 finally:
  if cli and cli.process.poll() is None:cli.process.send_signal(signal.SIGTERM);cli.process.wait(timeout=60)
  if bridge.process.poll() is None:
   try:
    if not bridge.process.stdin.closed:bridge.send({'mode':'stop'})
    bridge.settled()
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
 root=base/('paperclip-cli-qualification-'+uuid.uuid4().hex);root.mkdir(mode=0o755);identity=root.stat();namespace='pccli'+uuid.uuid4().hex[:8];created=False;ns_identity=None;settled=False;success=False;forced_cleanup=False
 run=lambda *a:subprocess.check_output(a,stderr=subprocess.PIPE)
 try:
  extract_native_capsule(archive,root)
  run('ip','netns','add',namespace);created=True;st=os.stat('/var/run/netns/'+namespace);ns_identity=(st.st_dev,st.st_ino)
  run('ip','netns','exec',namespace,'ip','link','set','lo','up')
  routes=json.loads(run('ip','netns','exec',namespace,'ip','-j','route','show','table','all'))
  if any(x.get('dst')=='default' for x in routes):raise ValueError('Owned loopback-only namespace required')
  options={'root':str(root),'args':vars(args),'namespace':namespace}
  result=subprocess.run(['ip','netns','exec',namespace,'/usr/bin/python3','-I','-S','-B',str(pathlib.Path(__file__).resolve()),'--fixture-exercise',json.dumps(options)],env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root'},check=False)
  if result.returncode:raise AssertionError('Actual packaged CLI qualification failed')
  success=True
 finally:
  if created:
   st=os.stat('/var/run/netns/'+namespace)
   if (st.st_dev,st.st_ino)!=ns_identity:raise RuntimeError('Owned namespace changed; retained for inspection')
   initial_members=run('ip','netns','pids',namespace).strip()
   forced_cleanup=bool(initial_members)
   for sig in (() if not initial_members else (signal.SIGTERM,signal.SIGKILL)):
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
  print(json.dumps({'actualCliNamespaceRemoved':True,'fixtureFilesRemoved':True,'forcedFixtureCleanupRequired':forced_cleanup,'productionAccess':False}))
  if success and forced_cleanup:raise RuntimeError('Successful qualification leaked namespace processes')

if __name__=='__main__':
 if len(sys.argv)==3 and sys.argv[1]=='--fixture-launch':launch_fixture(json.loads(sys.argv[2]))
 elif len(sys.argv)==3 and sys.argv[1]=='--fixture-exercise':
  o=json.loads(sys.argv[2]);print(json.dumps(exercise(pathlib.Path(o['root']),argparse.Namespace(**o['args']),o['namespace'])))
 else:main()
