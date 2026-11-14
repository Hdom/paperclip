"""Receive, verify and stage Hdom release assets. Never changes current/install metadata.
Run only as an approved controller operator. Non-secret options JSON is the sole input.
"""
import hashlib,json,os,pathlib,pwd,re,shutil,stat,sys,tarfile,tempfile,ctypes

def digest(file):
 h=hashlib.sha256()
 with file.open('rb') as stream:
  for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def expected_names(sha,operators=False):
 names={'manifest.json','SHA256SUMS','resolved-package-lock.json','paperclip-'+sha[:12]+'-linux-x64.tar.gz'}
 if operators:names.add('paperclip-'+sha[:12]+'-operator-tools.tar.gz')
 return names
def cache(options):
 sha=options['sourceCommit']
 if not re.fullmatch('[a-f0-9]{40}',sha):raise ValueError('Exact source commit required')
 root=pathlib.Path(options['cacheDirectory'])
 if not root.is_absolute() or root.resolve()!=root or root.name!=sha[:12]:raise ValueError('Physical source-specific cache required')
 if not root.is_dir():raise ValueError('Create the approved protected cache directory first')
 info=root.stat()
 if info.st_uid!=os.geteuid() or info.st_mode&0o077:raise ValueError('Cache must be operator-only')
 return root
def receive(options,stream):
 root=cache(options);name=options['assetName'];sha=options['sourceCommit'];expected=options['assetSha256'];size=options['assetSizeBytes']
 if name not in expected_names(sha,True) or not re.fullmatch('[a-f0-9]{64}',expected) or not isinstance(size,int) or not 0<size<=2*1024**3:raise ValueError('Invalid approved release asset')
 target=root/name
 if target.exists() or target.is_symlink():raise ValueError('Release asset already exists; inspect before retry')
 fd,temporary=tempfile.mkstemp(prefix='.receive-',dir=root);temporary=pathlib.Path(temporary);h=hashlib.sha256();count=0
 try:
  with os.fdopen(fd,'wb') as output:
   while True:
    chunk=stream.read(1024*1024)
    if not chunk:break
    count+=len(chunk)
    if count>size:raise ValueError('Release asset exceeds approved size')
    h.update(chunk);output.write(chunk)
   output.flush();os.fsync(output.fileno())
  if count!=size or h.hexdigest()!=expected:raise ValueError('Received asset differs from GitHub release digest')
  # An exclusive hardlink commit cannot overwrite an existing asset.
  os.link(temporary,target,follow_symlinks=False);temporary.unlink()
  return {'received':name,'bytes':count,'sha256':expected,'activated':False}
 finally:
  if temporary.exists():temporary.unlink()
def verify(options):
 root=cache(options);sha=options['sourceCommit'];manifest=root/'manifest.json';api=options['assetDigests']
 for file in root.iterdir():
  if file.name.startswith('.receive-'):continue
  if file.name in ('stage-receipt.json',):continue
  if file.name not in expected_names(sha,True):raise ValueError('Unexpected cached release file')
  info=file.lstat()
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_mode&0o077 or info.st_uid!=os.geteuid():raise ValueError('Unsafe cached asset')
  if api.get(file.name)!='sha256:'+digest(file):raise ValueError('Cached asset differs from authenticated GitHub digest')
 value=json.loads(manifest.read_text())
 if value.get('repository')!='Hdom/paperclip' or value.get('sourceCommit')!=sha or value.get('workflowCommit')!=sha or str(value.get('workflowRun'))!=str(options['workflowRun']) or value.get('platform')!='linux' or value.get('architecture')!='x64':raise ValueError('Release workflow identity mismatch')
 expected=expected_names(sha,bool(value.get('operatorTools')))
 if set(api)!=expected:raise ValueError('GitHub asset inventory differs from release manifest')
 checks={}
 for line in (root/'SHA256SUMS').read_text().splitlines():
  match=re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_.-]+)',line)
  if not match or match[2] in checks:raise ValueError('Invalid release checksum list')
  checks[match[2]]=match[1]
 if set(checks)!=expected-{'SHA256SUMS'}:raise ValueError('Incomplete release checksum list')
 for name,expected_digest in checks.items():
  if digest(root/name)!=expected_digest:raise ValueError('Release checksum mismatch')
 return value
def validate_members(members):
 if len(members)>200000:raise ValueError('Archive member limit exceeded')
 size=0
 for member in members:
  parts=pathlib.PurePosixPath(member.name).parts
  if not parts or parts[0]!='payload' or any(p in ('..','') for p in parts) or member.name.startswith('/') or '\\' in member.name:raise ValueError('Archive path escapes payload')
  if not (member.isdir() or member.isfile() or member.issym() or member.islnk()):raise ValueError('Special archive member refused')
  if member.issym() or member.islnk():
   target=member.linkname if member.islnk() else str(pathlib.PurePosixPath(member.name).parent/member.linkname)
   target=os.path.normpath(target)
   if member.linkname.startswith('/') or target!='payload' and not target.startswith('payload/'):raise ValueError('Archive link escapes payload')
  if not isinstance(member.size,int) or member.size<0:raise ValueError('Invalid archive member size')
  size+=member.size
  if size>8*1024**3:raise ValueError('Archive expansion limit exceeded')
 return size
def publish_new_directory(source,target):
 libc=ctypes.CDLL(None,use_errno=True)
 rename=libc.renameat2
 rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];rename.restype=ctypes.c_int
 if rename(-100,os.fsencode(source),-100,os.fsencode(target),1)!=0:
  code=ctypes.get_errno();raise OSError(code,os.strerror(code))
def stage(options,owner=None):
 manifest=verify(options);root=cache(options);sha=options['sourceCommit'];store=pathlib.Path(options['payloadStore']);target=store/sha[:12]
 if not store.is_absolute() or store.resolve()!=store or not store.is_dir() or target.exists() or target.is_symlink() or (root/'stage-receipt.json').exists():raise ValueError('New physical payload target required')
 archive=root/('paperclip-'+sha[:12]+'-linux-x64.tar.gz')
 with tarfile.open(archive,'r:gz') as tar:
  members=[]
  for member in tar:
   if len(members)>=200000:raise ValueError('Archive member limit exceeded')
   members.append(member)
  size=validate_members(members)
  remaining=options.get('minimumRemainingBytes',1_500_000_000)
  if type(remaining) is not int or remaining<1_500_000_000:raise ValueError('A minimum 1.5 GB staging reserve is required')
  if shutil.disk_usage(store).free<size+remaining:raise ValueError('Insufficient bounded staging space')
  temporary=pathlib.Path(tempfile.mkdtemp(prefix='.release-'+sha[:12]+'-',dir=store))
  # Keep any failed staging directory for inspection; never delete another install.
  tar.extractall(temporary,members=members,filter='data')
 payload=temporary/'payload'
 if json.loads((payload/'node_modules/@paperclipai/server/dist/build-info.json').read_text()).get('commit')!=sha:raise ValueError('Payload build stamp differs')
 if json.loads((payload/'node_modules/paperclipai/package.json').read_text()).get('version')!=manifest.get('packageVersion'):raise ValueError('Payload version differs')
 uid,gid=owner if owner else (pwd.getpwnam('paperclip').pw_uid,pwd.getpwnam('paperclip').pw_gid)
 for parent,dirs,files in os.walk(payload,followlinks=False):
  os.chown(parent,uid,gid,follow_symlinks=False)
  for name in dirs+files:os.chown(pathlib.Path(parent)/name,uid,gid,follow_symlinks=False)
 publish_new_directory(payload,target);temporary.rmdir()
 receipt={'sourceCommit':sha,'workflowRun':str(options['workflowRun']),'payload':str(target),'archiveSha256':digest(archive),'activated':False,'keysRead':False}
 file=root/'stage-receipt.json'
 with file.open('x') as output:os.chmod(file,0o600);json.dump(receipt,output,indent=2);output.flush();os.fsync(output.fileno())
 return receipt
def assert_controller_paths(options,action):
 root=pathlib.Path(options['cacheDirectory'])
 if root.parent!=pathlib.Path('/var/cache/paperclip-releases') or root.resolve()!=root:raise ValueError('Cache is outside the controller policy')
 for directory in (root,*root.parents):
  info=directory.lstat()
  if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise ValueError('Untrusted release cache ancestor')
 if action=='stage' and pathlib.Path(options['payloadStore'])!=pathlib.Path('/opt/paperclip-data/cli/installs/git'):raise ValueError('Payload store is outside the controller policy')
if __name__=='__main__':
 try:
  os.umask(0o077)
  if os.geteuid()!=0 or len(sys.argv)!=3:raise ValueError('Controller root operator, action and non-secret JSON options required')
  options=json.loads(sys.argv[2]);action=sys.argv[1];assert_controller_paths(options,action)
  if action=='receive':result=receive(options,sys.stdin.buffer)
  elif action=='verify':verify(options);result={'verified':True,'sourceCommit':options['sourceCommit'],'activated':False}
  elif action=='stage':result=stage(options)
  else:raise ValueError('Unsupported release action')
  print(json.dumps(result))
 except Exception as error:print(json.dumps({'error':'Verified release staging failed','type':type(error).__name__}));sys.exit(1)
