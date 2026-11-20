import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
export function verifiedArchive(file,expected) {
 if(process.platform!=='linux')throw Error('management_archive_platform_refused');
 if(!/^[a-f0-9]{64}$/.test(expected))throw Error('management_archive_expected_digest_refused');
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|constants.O_NOATIME);
 try{
  const a=fstatSync(fd,{bigint:true});if(!a.isFile()||a.nlink!==1n||(a.mode&0o022n)||a.size<=0n||a.size>32n*1024n*1024n)throw Error('management_archive_file_refused');
  const bytes=Buffer.alloc(Number(a.size));let at=0;while(at<bytes.length){const n=readSync(fd,bytes,at,bytes.length-at,null);if(n<=0)throw Error('management_archive_short_read');at+=n}
  for(const b of [fstatSync(fd,{bigint:true}),lstatSync(file,{bigint:true})])for(const key of ['dev','ino','uid','gid','mode','size','nlink','mtimeNs','ctimeNs'])if(a[key]!==b[key])throw Error('management_archive_changed');
  if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('management_archive_digest_refused');
  const tar=gunzipSync(bytes,{maxOutputLength:32*1024*1024});return {tar,archiveBytes:bytes.length};
 }finally{closeSync(fd)}
}
