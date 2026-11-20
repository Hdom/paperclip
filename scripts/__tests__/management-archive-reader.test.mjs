import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports}from'node:module';
import {gzipSync}from'node:zlib';
import {createHash}from'node:crypto';
import path from'node:path';
import {fixture}from'./management-test-fixture.mjs';
import {verifiedArchive}from'../management-archive-reader.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('verified archive uses an immutable bounded buffer after descriptor validation',()=>{
 const f=fixture();try{const file=path.join(f.root,'candidate.gz'),raw=Buffer.from('synthetic tar bytes'),compressed=gzipSync(raw);fs.writeFileSync(file,compressed,{mode:0o600});const result=verifiedArchive(file,sha(compressed));fs.writeFileSync(file,'changed');assert.deepEqual(result.tar,raw);assert.equal(result.archiveBytes,compressed.length)}finally{f.cleanup()}
});
test('archive digest, symlink, hardlink and raw decompression bounds fail closed',()=>{
 const f=fixture();try{const file=path.join(f.root,'candidate.gz'),bytes=gzipSync(Buffer.from('synthetic'));fs.writeFileSync(file,bytes,{mode:0o600});assert.throws(()=>verifiedArchive(file,'0'.repeat(64)));fs.symlinkSync(file,path.join(f.root,'alias'));assert.throws(()=>verifiedArchive(path.join(f.root,'alias'),sha(bytes)));fs.linkSync(file,path.join(f.root,'linked'));assert.throws(()=>verifiedArchive(file,sha(bytes)));const bomb=gzipSync(Buffer.alloc(32*1024*1024+1));const large=path.join(f.root,'bounded.gz');fs.writeFileSync(large,bomb,{mode:0o600});assert.throws(()=>verifiedArchive(large,sha(bomb)))}finally{f.cleanup()}
});
for(const mode of ['replace','mutate'])test('archive '+mode+' during FD read refuses before extracted execution',()=>{
 const f=fixture(),file=path.join(f.root,'candidate.gz'),bytes=gzipSync(Buffer.from('synthetic'));fs.writeFileSync(file,bytes,{mode:0o600});const original=fs.readSync;let changed=false;
 fs.readSync=function(fd,...args){const n=original(fd,...args);if(!changed){changed=true;if(mode==='replace'){fs.renameSync(file,file+'.old');fs.writeFileSync(file,bytes,{mode:0o600})}else fs.appendFileSync(file,'change')}return n};syncBuiltinESMExports();
 try{assert.throws(()=>verifiedArchive(file,sha(bytes)));assert.equal(changed,true)}finally{fs.readSync=original;syncBuiltinESMExports();f.cleanup()}
});
