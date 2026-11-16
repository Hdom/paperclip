import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The controller uses isolated Python 3 and its standard tar parser. Validate
// the whole plain archive before writing; tar's extraction side effects never
// run against controller paths. No links, sparse files, devices or overrides.
const EXTRACT = String.raw`
import os,pathlib,sys,tarfile
archive,destination=sys.argv[1:]
root=pathlib.Path(destination)
if not root.is_dir() or root.is_symlink() or list(root.iterdir()): raise ValueError('destination')
# Bound raw extension headers before tarfile can allocate their payload.
with open(archive,'rb') as wire:
    physical=os.fstat(wire.fileno()).st_size
    if physical>280*1024*1024: raise ValueError('archive size')
    headers=0; extensionBytes=0
    while True:
        header=wire.read(512)
        if not header or header==bytes(512): break
        if len(header)!=512: raise ValueError('header')
        headers+=1
        if headers>20002: raise ValueError('headers')
        sizefield=header[124:136].strip(b'\0 ')
        if any(c not in b'01234567' for c in sizefield): raise ValueError('size encoding')
        size=int(sizefield or b'0',8);kind=header[156:157]
        if kind in (b'x',b'L'):
            extensionBytes+=size
            if size>65536 or extensionBytes>8*1024*1024: raise ValueError('extension')
        elif kind in (b'0',b'\0',b'5'):
            if size>64*1024*1024: raise ValueError('file size')
        else: raise ValueError('type')
        offset=wire.tell()+((size+511)//512)*512
        if offset>physical: raise ValueError('truncated')
        wire.seek(offset)
with tarfile.open(archive,mode='r:') as source:
    entries=[]; seen=set(); materialized={"."}; total=0; count=0
    for member in source:
        count+=1
        if count>10000: raise ValueError('count')
        name=member.name
        name.encode('utf-8',errors='strict')
        while name.startswith('./'): name=name[2:]
        if name in ('','.'):
            if not member.isdir(): raise ValueError('root')
            continue
        parts=name.rstrip('/').split('/')
        if name.startswith('/') or '\\' in name or len(name)>4096 or len(parts)>64 or any(ord(c)<32 for c in name): raise ValueError('path')
        if any(p in ('','.','..','.git','.paperclip-runtime') for p in parts): raise ValueError('path')
        # Count implicit mkdir parents too, before any extraction or unbounded expansion.
        for depth in range(1,len(parts)+1):
            prefix='/'.join(parts[:depth])
            if prefix not in materialized:
                if len(materialized)>=10000: raise ValueError('materialized count')
                materialized.add(prefix)
        name='/'.join(parts)
        if name in seen or member.type not in (tarfile.REGTYPE,tarfile.AREGTYPE,tarfile.DIRTYPE) or member.sparse or member.mode & ~0o777: raise ValueError('type')
        if any(k.startswith('GNU.sparse') for k in member.pax_headers): raise ValueError('sparse')
        if member.size<0 or member.size>64*1024*1024: raise ValueError('file size')
        total+=member.size
        if total>256*1024*1024: raise ValueError('total')
        seen.add(name); entries.append((member,root.joinpath(*parts)))
    # An explicit file may not be an ancestor of any other entry.
    files={str(target) for member,target in entries if member.isfile()}
    if any(any(str(parent) in files for parent in target.parents) for _,target in entries): raise ValueError('ancestor')
    for member,target in entries:
        if member.isdir(): target.mkdir(parents=True,exist_ok=True,mode=0o700)
        else:
            target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            with source.extractfile(member) as incoming,open(target,'xb') as output:
                remaining=member.size
                while remaining:
                    chunk=incoming.read(min(65536,remaining))
                    if not chunk: raise ValueError('truncated')
                    output.write(chunk);remaining-=len(chunk)
            os.chmod(target,member.mode & 0o777)
`;

export async function extractControllerWorkspaceArchive(archive: string, directory: string): Promise<void> {
  try { await promisify(execFile)("python3", ["-I", "-B", "-c", EXTRACT, archive, directory], { maxBuffer: 65536 }); }
  catch (cause) { throw Object.assign(new Error("Protected workspace archive refused", { cause }), { code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" }); }
}
