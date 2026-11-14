import hashlib,io,json,os,pathlib,tarfile,tempfile,unittest
from operator_safety_test import load
release=load('stage_release','stage-release.py')
SHA='c'*40
class ReleaseSafety(unittest.TestCase):
 def fixture(self):
  temp=tempfile.TemporaryDirectory();root=pathlib.Path(temp.name);cache=root/SHA[:12];cache.mkdir(mode=0o700);store=root/'store';store.mkdir()
  manifest={'repository':'Hdom/paperclip','sourceCommit':SHA,'workflowCommit':SHA,'workflowRun':'123','platform':'linux','architecture':'x64','packageVersion':'1.0.0'}
  (cache/'manifest.json').write_text(json.dumps(manifest));(cache/'resolved-package-lock.json').write_text('{}')
  archive=cache/('paperclip-'+SHA[:12]+'-linux-x64.tar.gz')
  with tarfile.open(archive,'w:gz') as tar:
   for name,data in [('payload/node_modules/@paperclipai/server/dist/build-info.json',json.dumps({'commit':SHA}).encode()),('payload/node_modules/paperclipai/package.json',b'{"version":"1.0.0"}')]:
    member=tarfile.TarInfo(name);member.size=len(data);member.mode=0o644;tar.addfile(member,io.BytesIO(data))
  sums=''.join(release.digest(p)+'  '+p.name+'\n' for p in sorted(cache.iterdir()))
  (cache/'SHA256SUMS').write_text(sums)
  for p in cache.iterdir():p.chmod(0o600)
  options={'sourceCommit':SHA,'workflowRun':'123','cacheDirectory':str(cache),'payloadStore':str(store),'assetDigests':{p.name:'sha256:'+release.digest(p) for p in cache.iterdir()}}
  return temp,cache,store,options
 def test_cli_policy_rejects_untrusted_cache_roots(self):
  with self.assertRaises(ValueError):release.assert_controller_paths({'cacheDirectory':'/tmp/'+SHA[:12]},'receive')
 def test_receive_uses_approved_size_digest_and_exclusive_commit(self):
  with tempfile.TemporaryDirectory() as folder:
   cache=pathlib.Path(folder)/SHA[:12];cache.mkdir(mode=0o700);data=b'public-asset'
   options={'sourceCommit':SHA,'cacheDirectory':str(cache),'assetName':'manifest.json','assetSizeBytes':len(data),'assetSha256':hashlib.sha256(data).hexdigest()}
   with self.assertRaises(ValueError):release.receive(options,io.BytesIO(b'wrong-data'))
   self.assertEqual(list(cache.iterdir()),[])
   release.receive(options,io.BytesIO(data));self.assertEqual((cache/'manifest.json').read_bytes(),data)
   with self.assertRaises(ValueError):release.receive(options,io.BytesIO(data))
 def test_release_source_and_authenticated_asset_digests_are_required(self):
  temp,cache,store,options=self.fixture()
  try:
   self.assertEqual(release.verify(options)['sourceCommit'],SHA)
   (cache/'manifest.json').write_text('{"repository":"wrong"}')
   with self.assertRaises(ValueError):release.verify(options)
  finally:temp.cleanup()
 def test_escaping_links_paths_specials_and_expansion_are_refused(self):
  cases=[]
  member=tarfile.TarInfo('payload/../../outside');cases.append(member)
  member=tarfile.TarInfo('payload/link');member.type=tarfile.SYMTYPE;member.linkname='../../outside';cases.append(member)
  member=tarfile.TarInfo('payload/fifo');member.type=tarfile.FIFOTYPE;cases.append(member)
  member=tarfile.TarInfo('payload/huge');member.size=9*1024**3;cases.append(member)
  for member in cases:
   with self.assertRaises(ValueError):release.validate_members([member])
 def test_publication_cannot_replace_a_concurrent_target(self):
  with tempfile.TemporaryDirectory() as folder:
   source=pathlib.Path(folder)/'source';source.mkdir();target=pathlib.Path(folder)/'target';target.mkdir();(target/'canary').write_text('retained')
   with self.assertRaises(OSError):release.publish_new_directory(source,target)
   self.assertEqual((target/'canary').read_text(),'retained');self.assertTrue(source.is_dir())
 def test_staging_reserve_cannot_be_negative_or_disabled(self):
  temp,cache,store,options=self.fixture()
  try:
   for value in [-1,0,False,'1500000000']:
    options['minimumRemainingBytes']=value
    with self.assertRaises(ValueError):release.stage(options,(os.geteuid(),os.getegid()))
  finally:temp.cleanup()
 def test_staging_is_new_only_and_does_not_change_current_selection(self):
  temp,cache,store,options=self.fixture()
  try:
   old=store/'old';old.mkdir();current=store.parent/'current';current.symlink_to(old)
   receipt=release.stage(options,(os.geteuid(),os.getegid()));self.assertFalse(receipt['activated']);self.assertEqual(current.resolve(),old);self.assertTrue((store/SHA[:12]).is_dir())
   with self.assertRaises(ValueError):release.stage(options,(os.geteuid(),os.getegid()))
  finally:temp.cleanup()
if __name__=='__main__':unittest.main()
