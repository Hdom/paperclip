"""Synthetic filesystem/manager qualification. No systemctl, DB or live files."""
import importlib.util, json, os, pathlib, shutil, tempfile, unittest, sys
from unittest.mock import patch
sys.dont_write_bytecode=True
module=pathlib.Path(__file__).resolve().parents[1]/'operations/maintenance-host.py'
spec=importlib.util.spec_from_file_location('maintenance_host',module);host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
class HostContract(unittest.TestCase):
    def setUp(self):
        self.root=pathlib.Path(tempfile.mkdtemp(prefix='.maintenance-host-fixture-',dir=pathlib.Path.home()));self.root.chmod(0o700)
        self.capsule=self.root/'capsule';self.capsule.mkdir(mode=0o700)
        self.a=self.capsule/'a';self.a.write_bytes(b'authenticated candidate');self.a.chmod(0o600)
        self.manifest={'files':{'a':host.digest(self.a.read_bytes())},'links':{}}
    def tearDown(self):shutil.rmtree(self.root)
    def tree(self):host.verified_tree(self.capsule,self.manifest,uid=os.getuid())
    def test_complete_closure_and_internal_link(self):
        self.tree();(self.capsule/'internal').symlink_to('a');self.manifest['links']['internal']='a';self.tree()
    def test_tampered_file_refused(self):
        self.a.write_bytes(b'tampered')
        with self.assertRaises(host.Refusal):self.tree()
    def test_atime_only_change_does_not_revoke_read(self):
        original=host.os.fstat;calls=0
        def fstat(fd):
            nonlocal calls
            current=original(fd)
            if stat_is_regular(current.st_mode):
                calls+=1
                if calls==2:
                    values=list(current);values[7]=current.st_atime+60
                    # stat_result nanosecond fields are absent on a manually
                    # constructed object, so preserve stable ones explicitly.
                    class ChangedAtime:
                        def __getattr__(self,key):return getattr(current,key)
                    changed=ChangedAtime();changed.st_atime=current.st_atime+60;return changed
            return current
        from stat import S_ISREG as stat_is_regular
        with patch.object(host.os,'fstat',fstat):self.assertEqual(host.protected_read(self.a,uid=os.getuid())[0],b'authenticated candidate')
    def test_extra_file_refused(self):
        (self.capsule/'extra').write_bytes(b'unmanifested')
        with self.assertRaises(host.Refusal):self.tree()
    def test_escaped_link_refused(self):
        (self.root/'outside').write_bytes(b'private synthetic');(self.capsule/'escape').symlink_to('../outside');self.manifest['links']['escape']='../outside'
        with self.assertRaises(host.Refusal):self.tree()
    def test_hardlink_refused(self):
        os.link(self.a,self.root/'alias')
        with self.assertRaises(host.Refusal):self.tree()
    def test_parent_replacement_authority_refused(self):
        self.root.chmod(0o777)
        with self.assertRaises(host.Refusal):self.tree()
        self.root.chmod(0o700)
    def test_writable_file_and_privileged_file_refused(self):
        for mode in (0o666,0o4600,0o2600):
            self.a.chmod(mode)
            with self.assertRaises(host.Refusal):self.tree()
    def test_symlink_protected_file_refused(self):
        link=self.root/'link';link.symlink_to(self.a)
        with self.assertRaises(OSError):host.protected_read(link,uid=os.getuid())
    def test_parser_no_eval(self):
        self.assertEqual(host.parse_environment(b"A='$(no shell)'\nB=https://example.test/#value\n"),{'A':'$(no shell)','B':'https://example.test/#value'})
        for raw in (b'A=x\nA=y',b'NODE_OPTIONS=--import=evil',b'LD_PRELOAD=x',b'PYTHONPATH=x',b'export A=x',b'A="unterminated',b'A=x\\ny'):
            with self.assertRaises(host.Refusal):host.parse_environment(raw)
    def test_trusted_configuration_is_outside_writable_instance_data(self):
        self.assertEqual(host.CONFIG,pathlib.Path('/etc/paperclip/instance/config.json'))
        self.assertEqual(host.DOTENV,pathlib.Path('/etc/paperclip/instance/.env'))
        self.assertEqual(host.DATA_HOME,pathlib.Path('/opt/paperclip-data'))
        self.assertFalse(host.CONFIG.is_relative_to(host.DATA_HOME))
    def test_canonical_policy_serialization_preserves_exact_synthetic_values(self):
        values={
            'PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS':json.dumps(['/synthetic/source','/synthetic/$(literal)'],separators=(',',':')),
            'PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS':json.dumps(['/synthetic/work'],separators=(',',':')),
            'PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS':json.dumps([{'host':'fixture.invalid','port':2222,'user':'synthetic-worker'}],separators=(',',':')),
            'PAPERCLIP_CONTROLLER_PROTECTED_PATHS':json.dumps(['/synthetic/private'],separators=(',',':')),
        }
        expected=''.join(key+"='"+values[key]+"'\n" for key in sorted(values)).encode()
        encoded=host.canonical_policy_assignments(values)
        self.assertEqual(encoded,expected)
        self.assertEqual(host.parse_environment(encoded),values)
        self.assertEqual(host.canonical_policy_assignments(dict(reversed(list(values.items())))),encoded)
        legacy='PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS='+json.dumps(values['PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS'])+'\n'
        with self.assertRaises(host.Refusal):host.parse_environment(legacy.encode())
        for changed in ({**values,'UNREVIEWED_ROOT':'/synthetic'}, {k:v for k,v in values.items() if k!=next(iter(values))},
                        {**values,next(iter(values)):'bad\nvalue'}, {**values,next(iter(values)):r'bad\value'},
                        {**values,next(iter(values)):"contains'apostrophe"}, {**values,next(iter(values)):None}):
            with self.assertRaises(host.Refusal):host.canonical_policy_assignments(changed)
    def candidate_manifest(self):
        cli=self.capsule/'node_modules/paperclipai/dist';cli.mkdir(parents=True,mode=0o700)
        server=self.capsule/'node_modules/@paperclipai/server/dist';server.mkdir(parents=True,mode=0o700)
        for file,data in [(cli/'index.js',b'synthetic CLI'),(self.capsule/'operator-node',b'synthetic Node'),
                          (server/'build-info.json',json.dumps({'commit':'a'*40}).encode()),
                          (server/'runtime-capabilities.json',json.dumps({'schema':'paperclip.runtime-capabilities.v1','instanceMaintenance':1}).encode())]:
            file.write_bytes(data);file.chmod(0o600)
        creator_path=module.parent/'manifest-maintenance-capsule.py';spec=importlib.util.spec_from_file_location('large_capsule_manifest',creator_path);creator=importlib.util.module_from_spec(spec);spec.loader.exec_module(creator)
        return creator.inventory(self.capsule,'a'*40)
    def test_capsule_manifest_specific_bound_and_generic_reader_unchanged(self):
        manifest=self.candidate_manifest();manifest['syntheticPadding']='';external=self.root/'large-manifest.json'
        empty=json.dumps(manifest,separators=(',',':')).encode()
        for size,accepted in ((4*1024*1024,True),(4*1024*1024+1,True),(16*1024*1024-1,True),(16*1024*1024,True),(16*1024*1024+1,False)):
            manifest['syntheticPadding']='x'*(size-len(empty));raw=json.dumps(manifest,separators=(',',':')).encode();self.assertEqual(len(raw),size)
            external.write_bytes(raw);external.chmod(0o600)
            policy={'capsule':str(self.capsule),'capsuleManifest':str(external),'capsuleManifestSha256':host.digest(raw),'sourceCommit':'a'*40}
            if accepted:host.verify_candidate(policy,uid=os.getuid())
            else:
                with self.assertRaises(host.Refusal):host.verify_candidate(policy,uid=os.getuid())
            if size>4*1024*1024:
                with self.assertRaises(host.Refusal):host.protected_read(external,uid=os.getuid())
        manifest['syntheticPadding']='x'*(4*1024*1024+1-len(empty));raw=json.dumps(manifest,separators=(',',':')).encode();external.write_bytes(raw)
        policy={'capsule':str(self.capsule),'capsuleManifest':str(external),'capsuleManifestSha256':host.digest(raw),'sourceCommit':'a'*40}
        with self.assertRaisesRegex(host.Refusal,'identity changed'):host.verify_candidate({**policy,'capsuleManifestSha256':'0'*64},uid=os.getuid())
        external.chmod(0o666)
        with self.assertRaises(host.Refusal):host.verify_candidate(policy,uid=os.getuid())
        external.chmod(0o600);os.link(external,self.root/'manifest-alias')
        with self.assertRaises(host.Refusal):host.verify_candidate(policy,uid=os.getuid())
        (self.root/'manifest-alias').unlink();self.a.write_bytes(b'changed dependency')
        with self.assertRaisesRegex(host.Refusal,'content differs'):host.verify_candidate(policy,uid=os.getuid())
    def test_effective_interlock_not_file_presence(self):
        p={'ActiveState':'inactive','SubState':'dead','MainPID':'0','Restart':'no','ExecStartPath':'/usr/bin/false'}
        host.verify_interlock(p,[],[])
        for key,value in (('ActiveState','activating'),('SubState','failed'),('MainPID','123'),('Restart','on-failure'),('ExecStartPath','/old/current'),('ExecStartPre','unreviewed'),('OnFailure','another.service')):
            with self.assertRaises(host.Refusal):host.verify_interlock({**p,key:value},[],[])
        for jobs,processes in ((['pending start'],[]),([],['123'])):
            with self.assertRaises(host.Refusal):host.verify_interlock(p,jobs,processes)
    def test_runtime_only_unit_override_refused(self):
        unit='/etc/systemd/system/paperclip.service';drop='/etc/systemd/system/paperclip.service.d/90-maintenance.conf'
        policy={'interlockServiceFiles':{unit:'a'*64,drop:'b'*64}}
        for fragment,dropins in ((unit,'/run/systemd/system/paperclip.service.d/90-maintenance.conf'),('/run/systemd/system/paperclip.service',drop),(unit,'')):
            with self.assertRaises(host.Refusal):host.persistent_unit_files(policy,{'FragmentPath':fragment,'DropInPaths':dropins},'interlock')
    def test_epoch_binding_and_old_generation_refused(self):
        policy={'identity':{'database':'synthetic','databaseOid':42,'instanceId':'synthetic-instance'},'requestId':'request','expectedGeneration':3}
        receipt={'schema':'paperclip.maintenance-epoch.v1','identity':policy['identity'],'requestId':'request','generation':4,'state':'held','policy':'requires_readiness_decision','ownerId':'owner'}
        self.assertEqual(host.epoch_request(policy,receipt),{'expectedGeneration':4,'expectedOwnerId':'owner'})
        for key,value in (('generation',3),('state','released'),('policy','review_all'),('requestId','another'),('identity',{'database':'another'})):
            with self.assertRaises(host.Refusal):host.epoch_request(policy,{**receipt,key:value})
    def test_pnpm_package_directory_metadata_and_unaware_candidate(self):
        physical=self.capsule/'.store/server/dist';physical.mkdir(parents=True,mode=0o700)
        packages=self.capsule/'node_modules/@paperclipai';packages.mkdir(parents=True,mode=0o700)
        (packages/'server').symlink_to('../../.store/server')
        cli=self.capsule/'node_modules/paperclipai/dist';cli.mkdir(parents=True,mode=0o700)
        (cli/'index.js').write_bytes(b'synthetic CLI entry');(cli/'index.js').chmod(0o600)
        (self.capsule/'operator-node').write_bytes(b'synthetic Node');(self.capsule/'operator-node').chmod(0o600)
        source='a'*40
        caps=physical/'runtime-capabilities.json';stamp=physical/'build-info.json'
        stamp.write_text(json.dumps({'commit':source}));stamp.chmod(0o600)
        for protocol in (1,0):
            caps.write_text(json.dumps({'schema':'paperclip.runtime-capabilities.v1','instanceMaintenance':protocol}));caps.chmod(0o600)
            files={p.relative_to(self.capsule).as_posix():host.digest(p.read_bytes()) for p in self.capsule.rglob('*') if p.is_file() and not p.is_symlink()}
            if protocol==1:
                creator_path=module.parent/'manifest-maintenance-capsule.py';creator_spec=importlib.util.spec_from_file_location('capsule_creator',creator_path);creator=importlib.util.module_from_spec(creator_spec);creator_spec.loader.exec_module(creator)
                manifest=creator.inventory(self.capsule,source)
            else:manifest={'schema':'paperclip.protected-release.v1','sourceCommit':source,'files':files,'links':{'node_modules/@paperclipai/server':'../../.store/server'},'node':'operator-node','entry':'node_modules/paperclipai/dist/index.js'}
            external=self.root/'manifest.json';external.write_text(json.dumps(manifest));external.chmod(0o600)
            policy={'capsule':str(self.capsule),'capsuleManifest':str(external),'capsuleManifestSha256':host.digest(external.read_bytes()),'sourceCommit':source}
            if protocol==1:host.verify_candidate(policy,uid=os.getuid())
            else:
                with self.assertRaises(host.Refusal):host.verify_candidate(policy,uid=os.getuid())
class CapsuleTransport(unittest.TestCase):
    def setUp(self):
        import io,tarfile
        self.io=io;self.tarfile=tarfile;self.root=pathlib.Path(tempfile.mkdtemp(prefix='.maintenance-archive-',dir=pathlib.Path.home()))
        self.destination=self.root/'extracted';self.destination.mkdir();self.archive=self.root/'fixture.tar'
        p=module.parents[0].parent/'tests/qualify-maintenance-cli.py';spec=importlib.util.spec_from_file_location('cli_qualification',p);self.driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.driver)
    def tearDown(self):shutil.rmtree(self.root)
    def create(self,entries):
        with self.tarfile.open(self.archive,'w') as tar:
            for name,kind,value in entries:
                info=self.tarfile.TarInfo(name);info.mode=0o755 if kind=='dir' else 0o644
                if kind=='file':info.size=len(value);tar.addfile(info,self.io.BytesIO(value))
                else:
                    info.type={'dir':self.tarfile.DIRTYPE,'symlink':self.tarfile.SYMTYPE,'hardlink':self.tarfile.LNKTYPE,'fifo':self.tarfile.FIFOTYPE}[kind];info.linkname=value;tar.addfile(info)
    def extract(self):self.driver.extract_native_capsule(self.archive,self.destination)
    def test_relative_symlink_and_hardlink_are_contained_independent_files(self):
        self.create([('payload','dir',''),('payload/bin','dir',''),('payload/library','dir',''),('payload/library/tool','file',b'synthetic'),('payload/bin/tool','symlink','../library/tool'),('payload/copy','hardlink','payload/library/tool')]);self.extract()
        original=self.destination/'payload/library/tool';copy=self.destination/'payload/copy'
        self.assertEqual(copy.read_bytes(),b'synthetic');self.assertNotEqual(copy.stat().st_ino,original.stat().st_ino);self.assertEqual(original.stat().st_nlink,1)
        self.assertEqual((self.destination/'payload/bin/tool').resolve(),original)
    def test_escape_and_special_entry_refused_before_extract(self):
        for entry in [('payload/link','symlink','../../outside'),('payload/link','symlink','/etc/passwd'),('../outside','file',b'bad'),('payload/fifo','fifo','')]:
            self.create([('payload','dir',''),entry])
            with self.assertRaises(ValueError):self.extract()
            self.assertEqual(list(self.destination.iterdir()),[])
    def test_hardlink_chain_or_missing_target_is_not_authority(self):
        for target in ('outside','payload/missing'):
            self.create([('payload','dir',''),('payload/link','hardlink',target)])
            with self.assertRaises(ValueError):self.extract()
    def test_stop_protocol_delivers_eof_and_joins_readers(self):
        child=self.driver.Child([sys.executable,'-B','-c',"import sys,json;lines=sys.stdin.read().splitlines();assert json.loads(lines[0])=={'mode':'stop'};print('MAINTENANCE_CLI_FIXTURE:'+json.dumps({'kind':'stopped'}))"],stdin=self.driver.subprocess.PIPE)
        child.send({'mode':'stop'});self.assertTrue(child.process.stdin.closed);self.assertEqual(child.result('stopped'),{'kind':'stopped'});child.settled()
        self.assertTrue(all(not t.is_alive() for t in child.threads));self.assertEqual(child.reader_errors,[])
        with self.assertRaises(ValueError):child.send({'mode':'stop'})
    def test_failed_owner_exit_is_not_clean_success(self):
        child=self.driver.Child([sys.executable,'-B','-c',"import sys;sys.stdin.read();sys.exit(7)"],stdin=self.driver.subprocess.PIPE)
        child.send({'mode':'stop'})
        with self.assertRaises(AssertionError):child.settled()
    def test_pinned_transport_refuses_alias_wrong_digest_and_changes(self):
        file=self.root/'transport';file.write_bytes(b'synthetic exact archive');good=host.digest(file.read_bytes())
        with self.driver.pinned_transport(file,good,1024) as (stream,observed):self.assertEqual(stream.read(),b'synthetic exact archive');self.assertEqual(observed,good)
        with self.assertRaises(ValueError):
            with self.driver.pinned_transport(file,'0'*64,1024):pass
        with self.assertRaises(ValueError):
            with self.driver.pinned_transport(file,good,1):pass
        alias=self.root/'transport-alias';alias.symlink_to(file)
        with self.assertRaises(OSError):
            with self.driver.pinned_transport(alias,good,1024):pass
        alias.unlink();os.link(file,alias)
        with self.assertRaises(ValueError):
            with self.driver.pinned_transport(file,good,1024):pass
        alias.unlink()
        with self.assertRaisesRegex(ValueError,'changed while reading'):
            with self.driver.pinned_transport(file,good,1024):file.write_bytes(b'changed but still in same protected descriptor')
    def test_duplicate_member_refused(self):
        self.create([('payload/a','file',b'a'),('payload/a','file',b'b')])
        with self.assertRaises(ValueError):self.extract()
    def test_dangling_symlink_is_refused(self):
        self.create([('payload','dir',''),('payload/link','symlink','missing')])
        with self.assertRaises(FileNotFoundError):self.extract()
if __name__=='__main__':unittest.main(verbosity=2)
