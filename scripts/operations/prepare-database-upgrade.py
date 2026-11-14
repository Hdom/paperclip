"""Make a controller-only pre-upgrade backup and restored clone, without starting Paperclip.
Use a reviewed non-secret options JSON file. Root execution is intentional and explicit.
"""
import hashlib,json,os,pathlib,re,shutil,stat,subprocess,sys,pwd
TABLES=('companies','agents','projects','issues','issue_comments','company_secrets','company_secret_versions')
def database_name(value):
 if not re.fullmatch(r'[a-z][a-z0-9_]{0,62}',value):raise ValueError('Invalid database identifier')
 return value
SNAPSHOT_PATHS={
 '/etc/paperclip/paperclip.env':'environment',
 '/opt/paperclip-data/instances/default/config.json':'json',
 '/opt/paperclip-data/cli/install.json':'json',
 '/var/lib/paperclip/github-project-apps/config.json':'json',
}
def allowed_snapshot(file):
 p=pathlib.Path(file)
 return str(p) in SNAPSHOT_PATHS and p.is_absolute() and not any(x.lower() in ('keys','secrets','.ssh') for x in p.parts)
def validate_snapshot_content(data,kind):
 text=data.decode('utf8')
 if re.search(r'-----BEGIN [^-]*PRIVATE KEY-----',text,re.I) or re.search(r'(?im)^\s*(?:export\s+)?(?:PAPERCLIP_SECRETS_MASTER_KEY|PAPERCLIP_\w*PRIVATE_KEY)\s*=',text):raise ValueError('Key material is not a configuration snapshot')
 if kind=='json':
  value=json.loads(text)
  if not isinstance(value,dict):raise ValueError('Expected a configuration object')
  def inspect(value):
   if isinstance(value,dict):
    for key,item in value.items():
     if key.lower().replace('_','') in ('masterkey','privatekey','signingkey'):raise ValueError('Literal key property refused')
     inspect(item)
   elif isinstance(value,list):
    for item in value:inspect(item)
  inspect(value)
 elif kind!='environment':raise ValueError('Unknown snapshot kind')
 return data
def read_snapshot(file):
 p=pathlib.Path(file)
 if not allowed_snapshot(file) or p.resolve()!=p:raise ValueError('Snapshot path is not in the fixed controller policy')
 owners={0,os.geteuid()}
 try:owners.add(pwd.getpwnam('paperclip').pw_uid)
 except KeyError:pass
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before=os.fstat(fd)
  if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_uid not in owners or before.st_mode&0o022 or before.st_size>1048576:raise ValueError('Unsafe configuration source')
  data=os.read(fd,1048577);after=os.fstat(fd)
  if len(data)>1048576 or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError('Configuration changed during snapshot')
  return validate_snapshot_content(data,SNAPSHOT_PATHS[str(p)])
 finally:os.close(fd)
def prepare(options):
 if os.geteuid()!=0:raise PermissionError('Controller root operator required')
 os.umask(0o077)
 database=database_name(options['database']);clone=database_name(options['cloneDatabase'])
 if database==clone or not re.fullmatch(r'paperclip_(gitops|upgrade|qualify)_[a-z0-9_]+',clone):raise ValueError('Separate qualification clone required')
 base=pathlib.Path(options['backupDirectory'])
 if not base.is_absolute() or base.exists() or base.parent.resolve()!=base.parent:raise ValueError('New physical backup directory required')
 parent=base.parent.stat()
 if parent.st_uid!=0 or parent.st_mode&0o022 or shutil.disk_usage(base.parent).free<options.get('minimumFreeBytes',5_000_000_000):raise ValueError('Unsafe backup parent or insufficient disk')
 requested=options.get('configurationSnapshots',[])
 if not isinstance(requested,list) or len(requested)>4 or len(set(requested))!=len(requested):raise ValueError('Invalid snapshot selection')
 snapshot_bytes={file:read_snapshot(file) for file in requested}
 base.mkdir(mode=0o700)
 def postgres(*args,**kwargs):return subprocess.run(['runuser','-u','postgres','--',*args],check=True,**kwargs)
 dump=base/'pre-upgrade.dump'
 with dump.open('xb') as f:postgres('pg_dump','-Fc','--dbname',database,stdout=f,stderr=subprocess.PIPE)
 with dump.open('rb') as f:postgres('pg_restore','--list',stdin=f,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 snapshots=[]
 for index,file in enumerate(requested):
  target=base/(str(index)+'-'+pathlib.Path(file).name);target.write_bytes(snapshot_bytes[file]);target.chmod(0o600);snapshots.append({'originalPath':file,'backupFile':target.name})
 postgres('createdb','--owner',database_name(options['databaseOwner']),clone,stderr=subprocess.PIPE)
 with dump.open('rb') as f:postgres('pg_restore','--exit-on-error','--dbname',clone,stdin=f,stderr=subprocess.PIPE)
 invariants={}
 for name in TABLES:
  command=['runuser','-u','postgres','--','psql','-X','--dbname',clone,'-At','-c']
  columns=subprocess.check_output(command+[f"SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='{name}' ORDER BY ordinal_position"],text=True).splitlines()
  if not columns or 'id' not in columns or any(not re.fullmatch('[a-z][a-z0-9_]*',x) for x in columns):raise ValueError('Unexpected retained columns')
  projection=','.join('"'+x+'"' for x in columns)
  query=f'''SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id),''))) FROM (SELECT {projection} FROM "{name}") t'''
  invariants[name]={'columns':columns,**json.loads(subprocess.check_output(command+[query],text=True))}
 (base/'clone-original-invariants.json').write_text(json.dumps(invariants,indent=2)+'\n')
 h=hashlib.sha256()
 with dump.open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 result={'backup':str(dump),'bytes':dump.stat().st_size,'sha256':h.hexdigest(),'sourceDatabase':database,'cloneDatabase':clone,'restoreVerified':True,'configurationSnapshots':snapshots,'keyCopiesMade':False,'liveDatabaseModified':False}
 (base/'preflight-receipt.json').write_text(json.dumps(result,indent=2)+'\n')
 return result
if __name__=='__main__':
 try:
  if len(sys.argv)!=2:raise ValueError('Expected options JSON file')
  print(json.dumps(prepare(json.loads(pathlib.Path(sys.argv[1]).read_text()))))
 except Exception as error:
  print(json.dumps({'error':'Protected backup/clone preparation failed','type':type(error).__name__}));sys.exit(1)
