"""Build a pinned test-only Git binary without installing a system package.

For generated local fixtures on hosts whose Git lacks merge-tree --write-tree.
No root, credentials, service operations or global PATH changes. The SHA-256 is
published at https://www.kernel.org/pub/software/scm/git/sha256sums.asc; TLS is
validated. This does not claim independent OpenPGP trust verification.
"""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, tarfile, urllib.request, posixpath

VERSION='2.43.7'
SHA256='657e2374455d9e62f6cdb3e7c55d867b6db5404d744e97e112cc5b0db687a19f'
URL=f'https://www.kernel.org/pub/software/scm/git/git-{VERSION}.tar.xz'

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True)
    args=parser.parse_args();out=pathlib.Path(args.output)
    if os.geteuid()==0 or not out.is_absolute() or out.exists() or out.parent.resolve()!=out.parent:
        raise ValueError('New physical absolute output under an owned test directory, without root, required')
    out.mkdir(mode=0o700);archive=out/'source.tar.xz';downloaded=0
    with urllib.request.urlopen(URL,timeout=30) as response,archive.open('wb') as target:
        if response.url!=URL:raise ValueError('Unexpected download redirect')
        while block:=response.read(65536):
            downloaded+=len(block)
            if downloaded>12*1024*1024:raise ValueError('Archive exceeds download bound')
            target.write(block)
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=SHA256:raise ValueError('Publisher checksum mismatch')
    total=0;materialized=[]
    with tarfile.open(archive,'r:xz') as package:
        members=package.getmembers()
        if len(members)>20000:raise ValueError('Source member bound exceeded')
        for member in members:
            relative=pathlib.PurePosixPath(member.name)
            if relative.is_absolute() or '..' in relative.parts or not relative.parts or relative.parts[0]!=f'git-{VERSION}' or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError('Unsafe source archive member')
            content=member
            if member.issym() or member.islnk():
                name=posixpath.normpath(posixpath.join(str(relative.parent),member.linkname) if member.issym() else member.linkname)
                resolved=pathlib.PurePosixPath(name)
                if resolved.is_absolute() or '..' in resolved.parts or resolved.parts[0]!=f'git-{VERSION}':raise ValueError('Escaping archive link')
                content=package.getmember(name)
                if not content.isfile():raise ValueError('Archive link must name one ordinary in-archive file')
                materialized.append(member.name)
            total+=content.size
            if content.size>16*1024*1024 or total>120*1024*1024:raise ValueError('Source size bound exceeded')
            target=out.joinpath(*relative.parts)
            if member.isdir():target.mkdir(mode=0o700,parents=True,exist_ok=True)
            else:
                target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                with package.extractfile(content) as source,target.open('xb') as destination:shutil.copyfileobj(source,destination)
                target.chmod(0o700 if member.mode&0o111 else 0o600)
    source=out/f'git-{VERSION}'
    with (out/'build.log').open('w') as log:
        subprocess.run(['make','-j2','prefix=/usr','NO_CURL=YesPlease','NO_OPENSSL=YesPlease','NO_GETTEXT=YesPlease',
            'NO_TCLTK=YesPlease','NO_PERL=YesPlease','git'],cwd=source,stdout=log,stderr=subprocess.STDOUT,check=True)
    binary=out/'bin';binary.mkdir(mode=0o700);shutil.copy2(source/'git',binary/'git')
    version=subprocess.check_output([str(binary/'git'),'--version'],text=True).strip()
    if version!=f'git version {VERSION}':raise ValueError('Built version mismatch')
    (out/'receipt.json').write_text(json.dumps({'url':URL,'archiveSha256':SHA256,'version':version,'sourceBytes':total,
        'downloadBytes':downloaded,'materializedTarLinks':materialized,'systemInstallation':False,'scope':'generated test fixtures only'},indent=2)+'\n')
    print(json.dumps({'version':version,'binary':str(binary/'git'),'systemInstallation':False}),flush=True)

if __name__=='__main__':main()
