import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { extractControllerWorkspaceArchive } from "./controller-workspace-archive.js";
let root: string, target: string, archive: string;
beforeEach(async () => { root=await mkdtemp(path.join(os.tmpdir(),"checked-workspace-archive-")); target=path.join(root,"tree"); archive=path.join(root,"download.tar"); await mkdir(target); });
afterEach(async () => { await rm(root,{recursive:true,force:true}); });
async function make(kind: string) {
  await promisify(execFile)("python3",["-c",String.raw`
import io,sys,tarfile
archive,kind=sys.argv[1:]
with tarfile.open(archive,'w',format=tarfile.GNU_FORMAT if kind=='gnu' else tarfile.PAX_FORMAT) as tar:
    def add(name,contents=b'fixture',mode=0o644):
        entry=tarfile.TarInfo(name);entry.size=len(contents);entry.mode=mode;tar.addfile(entry,io.BytesIO(contents))
    if kind in ('valid','gnu'): add('nested/'+('long-name-'*20)+'/quoted name.txt',mode=0o755)
    elif kind=='duplicate': add('duplicate');add('duplicate')
    elif kind=='sparse_names':
        for n in range(200): add('root'+str(n)+'/'+'/'.join('sub'+str(i) for i in range(60))+'/file',b'')
    elif kind=='ancestor': add('file');add('file/child')
    elif kind in ('link','symlink','fifo','sparse'):
        entry=tarfile.TarInfo('unsafe');entry.type={'link':tarfile.LNKTYPE,'symlink':tarfile.SYMTYPE,'fifo':tarfile.FIFOTYPE,'sparse':tarfile.GNUTYPE_SPARSE}[kind];entry.linkname='../outside';tar.addfile(entry)
    elif kind=='oversize':
        entry=tarfile.TarInfo('huge');entry.size=64*1024*1024+1;tar.fileobj.write(entry.tobuf());tar.offset+=512
    elif kind=='privileged': add('privileged',mode=0o4755)
    else: add({'traversal':'../outside','absolute':'/tmp/unsafe-workspace-archive','git':'.git/config','backslash':'folder\\escape'}[kind])
`,archive,kind]);
}
it.each(["valid","gnu"])("extracts validated long %s names and safe permissions",async kind=>{
  await make(kind); await extractControllerWorkspaceArchive(archive,target);
  expect(await readFile(path.join(target,"nested",'long-name-'.repeat(20),'quoted name.txt'),"utf8")).toBe("fixture");
});
it.each(["sparse_names","duplicate","ancestor","link","symlink","fifo","sparse","oversize","privileged","traversal","absolute","git","backslash"])("refuses %s before any extraction",async kind=>{
  await make(kind); await expect(extractControllerWorkspaceArchive(archive,target)).rejects.toMatchObject({code:"WORKSPACE_RESTORE_UNSAFE_ARCHIVE"});
  expect(await readdir(target)).toEqual([]);
});
