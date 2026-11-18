"""Inventory a prepared immutable release capsule; never installs/chowns it.

Before use the operator must verify the original release asset/provenance,
stage a complete standalone payload (all dependencies), and copy the reviewed
Node executable into `operator-node`. This manifest is external to the capsule
and must later be retained under protected storage with its reviewed digest.
No service, live DB, config, key or current symlink is accessed.
"""
import argparse, hashlib, json, os, pathlib, re, stat
def inventory(root,source):
    root=pathlib.Path(root)
    if not root.is_absolute() or root.resolve()!=root or not re.fullmatch('[a-f0-9]{40}',source):raise ValueError('Physical prepared capsule and exact source required')
    files={};links={}
    for parent,dirs,names in os.walk(root,followlinks=False):
        for name in dirs+names:
            path=pathlib.Path(parent)/name;relative=path.relative_to(root).as_posix();s=path.lstat()
            if stat.S_ISLNK(s.st_mode):
                target=os.readlink(path)
                if pathlib.PurePosixPath(target).is_absolute() or not path.resolve(strict=True).is_relative_to(root):raise ValueError('Escaping dependency link')
                links[relative]=target
            elif stat.S_ISREG(s.st_mode):
                if s.st_nlink!=1 or s.st_mode&0o6022 or 'security.capability' in os.listxattr(path,follow_symlinks=False):raise ValueError('Unsafe prepared file mode/link/capability')
                h=hashlib.sha256()
                with path.open('rb') as stream:
                    while b:=stream.read(1024*1024):h.update(b)
                files[relative]=h.hexdigest()
            elif not stat.S_ISDIR(s.st_mode):raise ValueError('Special release member')
    entry='node_modules/paperclipai/dist/index.js';node='operator-node'
    if (root/node).is_symlink():raise ValueError('Node executable must be a physical capsule file')
    for required in (entry,node,'node_modules/@paperclipai/server/dist/runtime-capabilities.json','node_modules/@paperclipai/server/dist/build-info.json'):
        resolved=(root/required).resolve(strict=True)
        if not resolved.is_relative_to(root) or resolved.relative_to(root).as_posix() not in files:raise ValueError('Incomplete standalone candidate')
    # Entry itself must be a physical file so a later launch does not choose
    # through a symlink. Package directory links may be contained dependencies.
    entry=(root/entry).resolve().relative_to(root).as_posix()
    stamp=json.loads((root/'node_modules/@paperclipai/server/dist/build-info.json').read_text())
    caps=json.loads((root/'node_modules/@paperclipai/server/dist/runtime-capabilities.json').read_text())
    if stamp.get('commit')!=source or caps!={'schema':'paperclip.runtime-capabilities.v1','instanceMaintenance':1}:raise ValueError('Candidate stamp/capability differs')
    return {'schema':'paperclip.protected-release.v1','sourceCommit':source,'node':node,'entry':entry,'files':dict(sorted(files.items())),'links':dict(sorted(links.items()))}
def main():
    p=argparse.ArgumentParser();p.add_argument('--capsule',required=True);p.add_argument('--source',required=True);p.add_argument('--output',required=True);args=p.parse_args()
    output=pathlib.Path(args.output)
    if not output.is_absolute() or output.is_relative_to(pathlib.Path(args.capsule)):raise ValueError('New external manifest path required')
    result=inventory(args.capsule,args.source)
    with output.open('x') as f:os.chmod(output,0o600);json.dump(result,f,sort_keys=True,indent=2);f.write('\n')
    print(json.dumps({'files':len(result['files']),'links':len(result['links']),'sourceCommit':args.source,'serviceChanged':False}))
if __name__=='__main__':main()
