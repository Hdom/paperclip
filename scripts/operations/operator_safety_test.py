import importlib.machinery,importlib.util,pathlib,tempfile,unittest,os
ROOT=pathlib.Path(__file__).parent

def load(name,file):
 loader=importlib.machinery.SourceFileLoader(name,str(ROOT/file));spec=importlib.util.spec_from_loader(name,loader);module=importlib.util.module_from_spec(spec);loader.exec_module(module);return module
transport=load('guest_exec','guest-exec.py');backup=load('prepare_upgrade','prepare-database-upgrade.py');gateway=load('gateway','deployment-examples/gateway/paperclip-guests-exec')
class Channel:
 def __init__(self,password_prompt):self.prompted=password_prompt;self.stderr=b'PROMPT' if password_prompt else b'';self.stdout=b'' if password_prompt else b'READY\npublic-result';self.sent=[];self.closed=False
 def recv_ready(self):return bool(self.stdout)
 def recv_stderr_ready(self):return bool(self.stderr)
 def recv(self,size):value=self.stdout;self.stdout=b'';return value
 def recv_stderr(self,size):value=self.stderr;self.stderr=b'';return value
 def sendall(self,value):
  if not self.prompted:raise AssertionError('Password leaked to NOPASSWD command stdin')
  self.sent.append(value);self.stdout=b'READY\npublic-result'
 def shutdown_write(self):self.closed=True
 def exit_status_ready(self):return self.closed
 def recv_exit_status(self):return 0
class Safety(unittest.TestCase):
 def test_password_only_follows_real_prompt(self):
  for prompted in [True,False]:
   channel=Channel(prompted);code,out,err=transport.collect(channel,'PRIVATE_CANARY','PROMPT','READY',1)
   self.assertEqual(code,0);self.assertEqual(out,b'public-result');self.assertNotIn(b'PRIVATE_CANARY',out+err);self.assertEqual(channel.sent,[b'PRIVATE_CANARY\n'] if prompted else []);self.assertTrue(channel.closed)
 def test_guest_readiness_prevents_late_prompt_from_receiving_password(self):
  channel=Channel(False);channel.stderr=b'PROMPT'
  code,out,err=transport.collect(channel,'PRIVATE_CANARY','PROMPT','READY',1)
  self.assertEqual(code,0);self.assertEqual(channel.sent,[]);self.assertNotIn(b'PRIVATE_CANARY',out+err)
 def test_desktop_transport_restricts_scope_and_preserves_literal_arguments(self):
  for guest,args in [(112,['/bin/true']),(999,['/bin/true']),(113,['relative']),(124,['/bin/evil\n'])]:
   with self.assertRaises(ValueError):transport.build_command(guest,args,'PROMPT','READY')
  command=transport.build_command(113,['/bin/echo','literal; do-not-execute'],'PROMPT','READY');self.assertIn("'literal; do-not-execute'",command);self.assertIn('sudo -k -S',command)
 def test_existing_gateway_has_no_arbitrary_node_command_path(self):
  self.assertEqual(gateway.build_command(['113','/bin/true']),['/usr/sbin/pct','exec','113','--','/bin/true'])
  for args in [['999','/bin/true'],['113','relative'],['113','/bin/a\x7f']]:
   with self.assertRaises(ValueError):gateway.build_command(args)
  self.assertEqual(set(gateway.SAFE_ENV),{'PATH','LANG'})
 def test_backup_rejects_credentials_and_invalid_database_names(self):
  for value in ['a;DROP DATABASE paperclip','../database','Name']:
   with self.assertRaises(ValueError):backup.database_name(value)
  for file in ['/var/lib/paperclip/keys/coordinator.pem','/opt/paperclip/secrets/master.key','relative/config.json']:
   self.assertFalse(backup.allowed_snapshot(file))
  self.assertTrue(backup.allowed_snapshot('/etc/paperclip/paperclip.env'))

class SnapshotContent(unittest.TestCase):
 def test_synthetic_private_key_and_environment_master_key_are_refused(self):
  for content,kind in [(b'-----BEGIN PRIVATE KEY-----\nSYNTHETIC_CANARY','environment'),(b'PAPERCLIP_SECRETS_MASTER_KEY=synthetic_canary','environment'),(b'{"masterKey":"synthetic_canary"}','json')]:
   with self.assertRaises(ValueError):backup.validate_snapshot_content(content,kind)
  self.assertEqual(backup.validate_snapshot_content(b'{"privateKeyPath":"/controller/keys/test.pem"}','json'),b'{"privateKeyPath":"/controller/keys/test.pem"}')
 def test_opened_source_rejects_hardlinks_symlinks_and_special_files(self):
  with tempfile.TemporaryDirectory() as folder:
   source=pathlib.Path(folder)/'config.json';source.write_text('{}');source.chmod(0o600);before=backup.SNAPSHOT_PATHS
   try:
    backup.SNAPSHOT_PATHS={str(source):'json'};self.assertEqual(backup.read_snapshot(str(source)),b'{}')
    linked=pathlib.Path(folder)/'linked';os.link(source,linked)
    with self.assertRaises(ValueError):backup.read_snapshot(str(source))
    linked.unlink();source.unlink();source.symlink_to(linked)
    with self.assertRaises(ValueError):backup.read_snapshot(str(source))
    source.unlink();os.mkfifo(source)
    with self.assertRaises(ValueError):backup.read_snapshot(str(source))
   finally:backup.SNAPSHOT_PATHS=before

if __name__=='__main__':unittest.main()
