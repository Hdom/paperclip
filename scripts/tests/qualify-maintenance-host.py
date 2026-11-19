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
        # A formerly systemd-quoted JSON representation remains unsupported;
        # the serializer produces canonical data, never a relaxed parser.
        legacy='PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS='+json.dumps(values['PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS'])+'\n'
        with self.assertRaises(host.Refusal):host.parse_environment(legacy.encode())
        for changed in ({**values,'UNREVIEWED_ROOT':'/synthetic'}, {k:v for k,v in values.items() if k!=next(iter(values))},
                        {**values,next(iter(values)):'bad\nvalue'}, {**values,next(iter(values)):r'bad\value'},
                        {**values,next(iter(values)):"contains'apostrophe"}, {**values,next(iter(values)):None}):
            with self.assertRaises(host.Refusal):host.canonical_policy_assignments(changed)
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
if __name__=='__main__':unittest.main(verbosity=2)
