#!/usr/bin/python3
"""Protected maintenance host mechanism; installing this file grants nothing.

Production entry requires root, isolated/no-site Python and the fixed protected
policy. No path, unit, database, owner, skip-check or shell-command override.
Importable primitives are exercised only with synthetic fixtures in tests.
Never prints input, environment, SQL errors, private notes or credentials.
"""
import ctypes, fcntl, hashlib, json, os, pathlib, pwd, re, stat, subprocess, sys, uuid

POLICY=pathlib.Path('/etc/paperclip/maintenance/host-policy.json')
EPOCH=POLICY.parent/'epoch.json'
ENVIRONMENT=pathlib.Path('/etc/paperclip/paperclip.env')
CONFIG=pathlib.Path('/etc/paperclip/instance/config.json')
DATA_HOME=pathlib.Path('/opt/paperclip-data')
DOTENV=CONFIG.parent/'.env'
CAPSULE_MANIFEST_LIMIT=16*1024*1024
UNIT='paperclip.service'
SAFE_ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','HOME':'/root'}
class Refusal(Exception):pass
def digest(data):return hashlib.sha256(data).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def require(value,message):
    if not value:raise Refusal(message)

def protected_read(path, *, uid=0, limit=4*1024*1024):
    """Walk every component with nofollow dirfds, then bind read to identity."""
    path=pathlib.Path(path);require(path.is_absolute() and '..' not in path.parts,'Noncanonical protected path')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for component in path.parts[1:-1]:
            child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=child;st=os.fstat(fd)
            require(st.st_uid in (0,uid) and not st.st_mode&0o022,'Writable protected ancestor')
        child=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        try:
            before=os.fstat(child)
            require(stat.S_ISREG(before.st_mode) and before.st_uid==uid and before.st_nlink==1 and not before.st_mode&0o022 and before.st_size<=limit,'Unsafe protected file')
            chunks=[];remaining=limit+1
            while remaining:
                piece=os.read(child,min(65536,remaining))
                if not piece:break
                chunks.append(piece);remaining-=len(piece)
            data=b''.join(chunks);after=os.fstat(child)
            stable=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
            require(len(data)<=limit and stable(before)==stable(after),'Protected file changed while reading')
            return data,before
        finally:os.close(child)
    finally:os.close(fd)

def parse_environment(data):
    """Only the common unambiguous systemd/dotenv subset; never shell eval."""
    values={}
    for line in data.decode('utf-8').splitlines():
        if not line.strip() or line.lstrip().startswith('#'):continue
        match=re.fullmatch(r'([A-Z][A-Z0-9_]*)=(.*)',line)
        require(match is not None,'Ambiguous environment grammar')
        key,value=match.groups();require(key not in values,'Duplicate environment authority')
        if value.startswith(('"',"'")):
            require(len(value)>=2 and value[-1]==value[0] and value[0] not in value[1:-1],'Ambiguous quoted environment value');value=value[1:-1]
        require(not any(c in value for c in ('\\','\x00','\r','\n')),'Escaped environment value needs reviewed parser')
        require(not re.match(r'^(NODE_|LD_|DYLD_|PYTHON)',key),'Interpreter injection variable refused')
        values[key]=value
    return values

POLICY_SETTINGS=frozenset(('PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS','PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS',
    'PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS','PAPERCLIP_CONTROLLER_PROTECTED_PATHS'))
def canonical_policy_assignments(values):
    require(isinstance(values,dict) and set(values)==POLICY_SETTINGS,'Exact policy settings required')
    require(all(isinstance(value,str) and "'" not in value for value in values.values()),'Unsupported canonical policy value')
    raw=''.join(key+"='"+values[key]+"'\n" for key in sorted(values)).encode('utf-8')
    require(parse_environment(raw)==values,'Policy serialization changed effective values')
    return raw

def verified_tree(root,manifest, *, uid=0):
    """Complete immutable dependency closure; internal symlinks are recorded."""
    root=pathlib.Path(root)
    require(root.is_absolute() and root.resolve()==root,'Physical release root required')
    expected=manifest.get('files');links=manifest.get('links',{})
    require(isinstance(expected,dict) and expected and isinstance(links,dict),'Complete release manifest required')
    seen=set();seen_links=set()
    for parent,dirs,files in os.walk(root,followlinks=False):
        p=pathlib.Path(parent);st=p.lstat()
        require(st.st_uid==uid and not st.st_mode&0o022,'Writable release directory')
        for name in list(dirs)+files:
            target=p/name;relative=target.relative_to(root).as_posix();st=target.lstat()
            if stat.S_ISLNK(st.st_mode):
                # Link mode 0777 has no write authority; its parent is protected.
                require(st.st_uid==uid and os.readlink(target)==links.get(relative),'Unmanifested release link')
                resolved=target.resolve(strict=True);require(resolved.is_relative_to(root),'Dependency escapes release capsule')
                seen_links.add(relative)
                if name in dirs:dirs.remove(name)
            elif stat.S_ISREG(st.st_mode):
                require(st.st_uid==uid and not st.st_mode&0o022 and not st.st_mode&0o6000,'Unsafe release owner/mode')
                require('security.capability' not in os.listxattr(target,follow_symlinks=False),'File capability in release')
                require(st.st_nlink==1 and relative in expected,'Unmanifested release file')
                data,_=protected_read(target,uid=uid,limit=512*1024*1024)
                require(digest(data)==expected[relative],'Release content differs');seen.add(relative)
            else:require(stat.S_ISDIR(st.st_mode) and st.st_uid==uid and not st.st_mode&0o022 and not st.st_mode&0o6000,'Special or writable release directory')
    require(seen==set(expected) and seen_links==set(links),'Incomplete release closure')
    # Also protect ancestors: a service-owned parent could replace the capsule.
    first=next(iter(expected));protected_read(root/first,uid=uid,limit=512*1024*1024)

def verify_candidate(policy,*,uid=0):
    raw,_=protected_read(policy['capsuleManifest'],uid=uid,limit=CAPSULE_MANIFEST_LIMIT);require(digest(raw)==policy['capsuleManifestSha256'],'Release manifest identity changed')
    manifest=json.loads(raw)
    require(manifest.get('schema')=='paperclip.protected-release.v1' and manifest.get('sourceCommit')==policy['sourceCommit'],'Unrecognized candidate provenance')
    root=pathlib.Path(policy['capsule']);verified_tree(root,manifest,uid=uid)
    def read(relative):
        resolved=(root/relative).resolve(strict=True)
        require(resolved.is_relative_to(root) and resolved.relative_to(root).as_posix() in manifest['files'],'Missing authenticated candidate member')
        return json.loads(protected_read(resolved,uid=uid)[0])
    caps=read('node_modules/@paperclipai/server/dist/runtime-capabilities.json')
    stamp=read('node_modules/@paperclipai/server/dist/build-info.json')
    require(caps=={'schema':'paperclip.runtime-capabilities.v1','instanceMaintenance':1} and stamp.get('commit')==policy['sourceCommit'],'Candidate cannot honor persisted maintenance')
    for key in ('node','entry'):
        relative=manifest[key];require(relative in manifest['files'] and not pathlib.PurePosixPath(relative).is_absolute(),'Unverified executable entry')
    require(manifest['node']=='operator-node' and (root/'node_modules/paperclipai/dist/index.js').resolve(strict=True)==root/manifest['entry'],'Unexpected fixed Node/CLI entry')
    require(not any(name.endswith('/server/src/index.ts') or name=='server/src/index.ts' for name in manifest['files']),'Development candidate cannot be a protected production capsule')
    return root,manifest

def verify_server_resolution(policy,root,manifest):
    # Resolve metadata with the authenticated independent Node; no candidate
    # module is imported/evaluated. Match the real CLI's ESM package lookup,
    # including contained pnpm package directories, before dropping to exec.
    expected=(root/'node_modules/@paperclipai/server/dist/index.js').resolve(strict=True)
    require(expected.is_relative_to(root) and expected.relative_to(root).as_posix() in manifest['files'],'Server entry not in protected closure')
    development=(root/manifest['entry']).parent/'../../../server/src/index.ts'
    require(not development.exists(),'CLI would select a development entry')
    bridge="import{pathToFileURL,fileURLToPath}from'node:url';console.log(fileURLToPath(import.meta.resolve('@paperclipai/server',pathToFileURL(process.argv[1]).href)))"
    result=subprocess.run([str(pathlib.Path(policy['operatorRoot'])/'node'),'--experimental-import-meta-resolve','--input-type=module','--eval',bridge,str(root/manifest['entry'])],cwd='/',env=SAFE_ENV,capture_output=True,text=True)
    require(result.returncode==0 and result.stdout.strip()==str(expected),'CLI package resolution escapes verified server entry')

def verify_interlock(properties,jobs,cgroup):
    require(properties.get('ActiveState')=='inactive' and properties.get('SubState')=='dead' and properties.get('MainPID')=='0','Service is not physically inactive')
    require(properties.get('Restart')=='no' and properties.get('ExecStartPath')=='/usr/bin/false','Deny-start interlock not effective')
    for key in ('ExecCondition','ExecStartPre','ExecStartPost','ExecStop','ExecStopPost','OnFailure','OnSuccess'):
        require(not properties.get(key),'Unreviewed service lifecycle action')
    require(not jobs and not cgroup,'Service jobs or cgroup members remain')

def persistent_unit_files(policy,properties,phase):
    files=policy[phase+'ServiceFiles']
    require(isinstance(files,dict) and '/etc/systemd/system/paperclip.service' in files,'Persistent unit provenance required')
    require(properties.get('FragmentPath')=='/etc/systemd/system/paperclip.service','Unexpected service fragment')
    dropins=properties.get('DropInPaths','').split()
    expected=sorted(p for p in files if p!='/etc/systemd/system/paperclip.service')
    require(sorted(dropins)==expected and len(set(dropins))==len(dropins),'Loaded drop-in inventory changed')
    for name,expected_hash in files.items():
        require(name=='/etc/systemd/system/paperclip.service' or re.fullmatch(r'/etc/systemd/system/paperclip\.service\.d/[a-zA-Z0-9_-]+\.conf',name),'Only persistent exact service files are supported')
        require(re.fullmatch('[a-f0-9]{64}',expected_hash) is not None,'Invalid reviewed unit digest')
        require(digest(protected_read(name)[0])==expected_hash,'Persistent service file differs')

def service_properties():
    names=['ActiveState','SubState','MainPID','Restart','ExecStart','ExecCondition','ExecStartPre','ExecStartPost','ExecStop','ExecStopPost','OnFailure','OnSuccess','ControlGroup','FragmentPath','DropInPaths']
    names+=['User','Group','EnvironmentFiles','Environment','NoNewPrivileges','AmbientCapabilities','CapabilityBoundingSet','WorkingDirectory']
    result=subprocess.run(['/usr/bin/systemctl','show',UNIT,'--no-pager',*['--property='+p for p in names]],env=SAFE_ENV,capture_output=True,check=True)
    properties=dict(line.split('=',1) for line in result.stdout.decode().splitlines() if '=' in line)
    return properties

def service_interlock(policy):
    properties=service_properties();persistent_unit_files(policy,properties,'interlock')
    require(re.fullmatch(r'\{ path=/usr/bin/false ; argv\[\]=/usr/bin/false ; .*\}',properties.get('ExecStart','')) is not None,'Unexpected effective start command')
    properties['ExecStartPath']='/usr/bin/false'
    raw=subprocess.run(['/usr/bin/systemctl','list-jobs','--no-legend','--no-pager'],env=SAFE_ENV,capture_output=True,check=True).stdout.decode()
    jobs=[line for line in raw.splitlines() if UNIT in line.split()]
    group=properties.get('ControlGroup','');members=[]
    if group:
        require(group.startswith('/system.slice/') and '..' not in group,'Unexpected service cgroup')
        base=pathlib.Path('/sys/fs/cgroup')/group.lstrip('/')
        if base.exists():
            for p in base.rglob('cgroup.procs'):members.extend(p.read_text().split())
    verify_interlock(properties,jobs,members)
    return {'effectivePropertiesDigest':digest(canonical(properties)),'interlockVerified':True}

def guarded_service(policy):
    properties=service_properties();persistent_unit_files(policy,properties,'guarded')
    expected=str(pathlib.Path(policy['operatorRoot'])/'maintenance-host.py')
    require(str(pathlib.Path(__file__).resolve())==expected,'Wrong protected host launcher')
    command=properties.get('ExecStart','')
    require(command.startswith('{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -I -S '+expected+' launch ; '),'Guarded start command changed')
    for key in ('ExecCondition','ExecStartPre','ExecStartPost','ExecStop','ExecStopPost','OnFailure','OnSuccess','EnvironmentFiles','AmbientCapabilities'):
        require(not properties.get(key),'Unreviewed guarded service authority')
    require(properties.get('User')=='root' and properties.get('Group')=='root' and properties.get('NoNewPrivileges')=='yes'
        and properties.get('WorkingDirectory')=='/' and properties.get('Restart')=='no','Protected launch service contract differs')
    require(properties.get('CapabilityBoundingSet')=='cap_setgid cap_setuid','Guarded service capabilities differ')
    require(properties.get('Environment')=='','Unexpected root launcher environment')

def load_authority(policy):
    service_raw,_=protected_read(ENVIRONMENT);config_raw,_=protected_read(CONFIG);dotenv_raw,_=protected_read(DOTENV)
    for name,raw in [('environment',service_raw),('config',config_raw),('dotenv',dotenv_raw)]:require(digest(raw)==policy['configDigests'][name],'Service configuration changed')
    env=parse_environment(service_raw);extra=parse_environment(dotenv_raw)
    for key,value in extra.items():env.setdefault(key,value)
    config=json.loads(config_raw)
    require(config.get('database',{}).get('mode')=='postgres','Only the verified external PostgreSQL configuration is supported')
    require(not any(k.startswith('PAPERCLIP_CLOUD_') or k=='PAPERCLIP_MANAGED' for k in env),'Managed-cloud authority is outside this cutover')
    url=env.get('DATABASE_URL',config['database'].get('connectionString'))
    require(isinstance(url,str) and url and env.get('DATABASE_MIGRATION_URL',url)==url,'Distinct migration database authority refused')
    for key,value in {'PAPERCLIP_CONFIG':str(CONFIG),'PAPERCLIP_HOME':str(DATA_HOME),'PAPERCLIP_INSTANCE_ID':'default'}.items():
        require(key not in env or env[key]==value,'Unexpected instance configuration authority');env[key]=value
    env['DATABASE_URL']=url;env['DISABLE_AUTOUPDATER']='1'
    return url,env

def assert_no_service_processes():
    service_uid=pwd.getpwnam('paperclip').pw_uid
    require(service_uid!=0,'Dedicated unprivileged service identity required')
    for process in pathlib.Path('/proc').iterdir():
        if not process.name.isdecimal():continue
        try:
            status=(process/'status').read_text()
            match=re.search(r'^Uid:\s+(.+)$',status,re.M)
            require(match is not None,'Process identity unavailable')
            require(service_uid not in [int(v) for v in match[1].split()],'Another service-identity process remains')
        except FileNotFoundError:pass

def epoch_request(policy,receipt):
    require(receipt.get('schema')=='paperclip.maintenance-epoch.v1' and receipt.get('identity')==policy['identity']
        and receipt.get('requestId')==policy['requestId'] and receipt.get('generation')==policy['expectedGeneration']+1
        and receipt.get('state')=='held' and receipt.get('policy')=='requires_readiness_decision'
        and isinstance(receipt.get('ownerId'),str),'Protected epoch receipt differs from approved initialization')
    return {'expectedGeneration':receipt['generation'],'expectedOwnerId':receipt['ownerId']}

def install_epoch(policy,result):
    # Called only after canonical initialization, settled blockers, unchanged
    # retained domains and a second verified service interlock. Never force a
    # database state or replace a prior receipt with different authority.
    receipt={'schema':'paperclip.maintenance-epoch.v1',**{key:result[key] for key in ('identity','generation','ownerId','state','policy','inventoryDigest')},'requestId':policy['requestId']}
    epoch_request(policy,receipt)
    if EPOCH.exists():
        require(json.loads(protected_read(EPOCH)[0])==receipt,'A different protected epoch already exists');return receipt
    require(POLICY.parent.resolve()==POLICY.parent,'Protected epoch parent changed')
    parent=os.open(POLICY.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    temporary='.epoch-'+uuid.uuid4().hex+'.json'
    try:
        st=os.fstat(parent);require(st.st_uid==0 and not st.st_mode&0o077,'Private root-owned epoch parent required')
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
        try:
            data=canonical(receipt)+b'\n';written=0
            while written<len(data):written+=os.write(fd,data[written:])
            os.fsync(fd)
        finally:os.close(fd)
        # Linux atomic no-replace rename avoids a crash window with a two-link
        # receipt. No weaker replacement or hard-link fallback is permitted.
        libc=ctypes.CDLL(None,use_errno=True)
        rename=getattr(libc,'renameat2',None);require(rename is not None,'Atomic no-replace rename unavailable')
        rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];rename.restype=ctypes.c_int
        require(rename(parent,temporary.encode(),parent,EPOCH.name.encode(),1)==0,'Protected epoch publication refused')
        os.fsync(parent)
    finally:
        try:os.unlink(temporary,dir_fd=parent)
        except FileNotFoundError:pass
        os.close(parent)
    return receipt

def drop_and_exec(root,manifest,env,*,service_name='paperclip',working_directory='/opt/paperclip-data',home_directory=None):
    # Alternate identities/directories are only an importable fixture seam;
    # the production CLI always calls the fixed defaults and accepts no flags.
    service=pwd.getpwnam(service_name)
    require(service.pw_uid!=0 and service.pw_gid!=0,'Unprivileged service identity required')
    home=service.pw_dir if home_directory is None else home_directory
    env={**env,'HOME':home,'USER':service.pw_name,'LOGNAME':service.pw_name,
        'PATH':'/home/paperclip/.local/bin:/usr/local/bin:/usr/bin:/bin','CODEX_HOME':'/home/paperclip/.codex' if home_directory is None else str(pathlib.Path(home)/'.codex')}
    require(not any(re.match(r'^(NODE_|LD_|DYLD_|PYTHON)',key) for key in env),'Unsafe app environment')
    # Root executes only this protected operator mechanism. App/CLI/provider
    # imports occur after all real/effective/saved IDs and groups are dropped.
    os.setgroups([]);os.setresgid(service.pw_gid,service.pw_gid,service.pw_gid);os.setresuid(service.pw_uid,service.pw_uid,service.pw_uid)
    require(os.getresuid()==(service.pw_uid,)*3 and os.getresgid()==(service.pw_gid,)*3 and os.getgroups()==[],'Privilege drop incomplete')
    require(ctypes.CDLL(None,use_errno=True).prctl(38,1,0,0,0)==0,'NoNewPrivileges could not be established')
    os.chdir(working_directory)
    os.execve(root/manifest['node'],[str(root/manifest['node']),str(root/manifest['entry']),'run','--no-repair'],env)

def call_runtime(policy,request):
    raw,_=protected_read(policy['operatorManifest']);require(digest(raw)==policy['operatorManifestSha256'],'Operator manifest identity changed')
    manifest=json.loads(raw);require(manifest.get('schema')=='paperclip.maintenance-operator-bundle.v1' and manifest.get('qualificationOnly') is False,'Qualification runtime cannot operate production')
    root=pathlib.Path(policy['operatorRoot']);verified_tree(root,{'files':manifest['files'],'links':{}})
    # manifest is a separately authenticated metadata file, not part of its own
    # digest closure; production packaging keeps it outside operatorRoot.
    bridge='import {operate} from "./runtime.mjs";let b="";for await(const c of process.stdin){b+=c;if(b.length>8000000)process.exit(2)};try{console.log(JSON.stringify(await operate(JSON.parse(b))))}catch{process.exit(3)}'
    result=subprocess.run([str(root/'node'),'--input-type=module','--eval',bridge],cwd=root,env=SAFE_ENV,input=canonical(request),capture_output=True)
    require(result.returncode==0 and len(result.stdout)<8*1024*1024,'Independent runtime refused; keep service contained')
    return json.loads(result.stdout)

def main():
    require(os.geteuid()==0 and sys.flags.isolated and sys.flags.no_site,'Root isolated/no-site interpreter required')
    require(len(sys.argv)==2 and sys.argv[1] in ('inspect','initialize','guard','launch'),'Expected inspect, initialize, guard or launch')
    raw,_=protected_read(POLICY);policy=json.loads(raw)
    require(policy.get('schema')=='paperclip.maintenance-host-policy.v1','Unsupported host policy')
    mode=sys.argv[1]
    offline=mode in ('inspect','initialize')
    if offline:service_interlock(policy);assert_no_service_processes()
    if mode=='launch':guarded_service(policy)
    root,manifest=verify_candidate(policy)
    url,environment=load_authority(policy)
    request={k:policy[k] for k in ('identity','expectedGeneration','requestId','approvalReference','operatorNote')}
    request.update(mode='guard' if mode=='launch' else mode,databaseUrl=url)
    if mode=='initialize':request['baseline']=policy['baseline']
    if not offline:request.update(epoch_request(policy,json.loads(protected_read(EPOCH)[0])))
    result=call_runtime(policy,request)
    if offline:service_interlock(policy);assert_no_service_processes()
    if mode=='initialize':install_epoch(policy,result)
    if mode=='launch':
        # Immutable root-protected closure was verified above; app selection
        # never re-resolves the managed current symlink after this point.
        verify_server_resolution(policy,root,manifest)
        drop_and_exec(root,manifest,environment)
    print(json.dumps(result,sort_keys=True))

if __name__=='__main__':
    try:
        # Nonblocking, root-owned operation serialization; no lease timeout.
        require(os.geteuid()==0 and sys.flags.isolated and sys.flags.no_site,'Protected interpreter required')
        lock=os.open('/run/lock/paperclip-maintenance.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        st=os.fstat(lock);require(stat.S_ISREG(st.st_mode) and st.st_uid==0 and st.st_nlink==1 and not st.st_mode&0o077,'Unsafe host lock')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        # CLOEXEC releases this operator lock on the app exec, not before the
        # fixed-path guard/drop sequence. It grants no application authority.
        main()
    except Exception:
        print('Maintenance verification refused. Preserve service containment and inspect protected evidence.',file=sys.stderr)
        raise SystemExit(1)
