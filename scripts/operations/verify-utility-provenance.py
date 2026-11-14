import argparse,hashlib,json,pathlib,stat,sys

def verify(manifest,root,surface=None):
 rows=json.loads(manifest.read_text())['files']; checked=[]; missing=[]
 for row in rows:
  if surface and row['surface']!=surface:continue
  name=row['path'].lstrip('/') if surface else row.get('source')
  if name is None:missing.append({'path':row['path'],'status':row['status']});continue
  file=root/name
  if not file.resolve().is_relative_to(root.resolve()) or file.is_symlink() or not file.is_file():raise ValueError('Missing or escaping source')
  if hashlib.sha256(file.read_bytes()).hexdigest()!=row['sha256']:raise ValueError('Source hash differs: '+name)
  if surface:
   info=file.stat()
   if oct(stat.S_IMODE(info.st_mode))!=row['mode'] or info.st_uid!=row['uid'] or info.st_gid!=row['gid']:raise ValueError('Ownership or mode differs: '+name)
  checked.append(row['path'])
 return {'verified':checked,'unmatched':missing,'scope':'deployed-'+surface if surface else 'repository-source','mutations':False}
if __name__=='__main__':
 p=argparse.ArgumentParser(description='Compare non-secret deployed utility source with the committed inventory; never installs files.')
 p.add_argument('--manifest',type=pathlib.Path,default=pathlib.Path(__file__).with_name('observed-deployment-inventory.json'))
 p.add_argument('--root',type=pathlib.Path,required=True);p.add_argument('--surface',choices=['controller','worker','gateway']);args=p.parse_args()
 try:print(json.dumps(verify(args.manifest,args.root,args.surface),indent=2))
 except (OSError,ValueError,KeyError):print(json.dumps({'error':'Utility provenance verification failed'}));sys.exit(1)
