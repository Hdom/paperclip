"""Authorized desktop operator transport. No password in argv/files/remote environment.
Requires paramiko and the existing trusted host-key file. This installs no privileges.
"""
import json,os,pathlib,secrets,shlex,sys,time,hashlib,stat,re

def build_command(guest,arguments,prompt,ready):
 if str(guest) not in ('113','124') or not isinstance(arguments,list) or not arguments or not all(isinstance(x,str) for x in arguments) or not arguments[0].startswith('/') or any(ord(x)<32 or ord(x)==127 for x in arguments[0]):raise ValueError('Expected controller/worker and an absolute executable')
 inner=['/bin/sh','-c','printf '+shlex.quote(ready+'\n')+'; exec "$@"','paperclip-operator',*arguments]
 return 'sudo -k -S -p '+shlex.quote(prompt)+' /usr/local/sbin/paperclip-guests-exec '+str(guest)+' '+shlex.join(inner)

def collect(channel,password,prompt,ready,timeout=90,input_stream=None):
 # Do not write a sudo password until sudo actually requests one. With cached
 # or NOPASSWD authentication an eager write would reach the guest's stdin.
 deadline=time.monotonic()+timeout;stdout=bytearray();stderr=bytearray();sent=False;started=False;pending=b'';input_done=False
 while time.monotonic()<deadline:
  progressed=False
  if channel.recv_ready():stdout.extend(channel.recv(65536));progressed=True
  if channel.recv_stderr_ready():stderr.extend(channel.recv_stderr(65536));progressed=True
  if len(stdout)>2_000_000 or len(stderr)>2_000_000:raise RuntimeError('Operator output limit exceeded')
  if not started and ready.encode() in stdout:
   started=True
   if input_stream is None:channel.shutdown_write();input_done=True
  if not sent and not started and prompt.encode() in stderr:
   channel.sendall((password+'\n').encode());sent=True;progressed=True
  if started and not input_done and channel.send_ready():
   if not pending:pending=input_stream.read(65536)
   if pending:
    count=channel.send(pending);pending=pending[count:];progressed=progressed or count>0
   else:channel.shutdown_write();input_done=True
  if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
   code=channel.recv_exit_status()
   if not started or not input_done:raise RuntimeError('Approved guest command did not consume the complete input')
   return code,bytes(stdout).replace((ready+'\n').encode(),b'',1),bytes(stderr).replace(prompt.encode(),b'')
  if not progressed:time.sleep(.01)
 raise TimeoutError('Operator command deadline exceeded')

def run(options):
 import winreg,paramiko
 def uservar(name):
  with winreg.OpenKey(winreg.HKEY_CURRENT_USER,'Environment') as key:return winreg.QueryValueEx(key,name)[0]
 prompt='paperclip-sudo-'+secrets.token_hex(16);ready='paperclip-ready-'+secrets.token_hex(16)
 command=build_command(options['guest'],options['command'],prompt,ready)
 timeout=int(options.get('timeoutSeconds',90))
 if not 1<=timeout<=900:raise ValueError('Operator timeout must be between 1 and 900 seconds')
 password=uservar('PROXMOX_OPERATOR_PASSWORD');user=uservar('PROXMOX_OPERATOR_USER')
 stream=None
 if options.get('stdinFile'):
  file=pathlib.Path(options['stdinFile']).absolute()
  if not re.fullmatch(r'(?:paperclip-[a-f0-9]{12}-(?:linux-x64|operator-tools)\.tar\.gz|manifest\.json|SHA256SUMS|resolved-package-lock\.json)',file.name) or file.resolve()!=file:raise ValueError('Only verified release assets can be streamed')
  stream=file.open('rb');info=os.fstat(stream.fileno())
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>2*1024**3:stream.close();raise ValueError('Unsafe release asset')
  digest=hashlib.sha256()
  for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
  if digest.hexdigest()!=options.get('stdinSha256'):stream.close();raise ValueError('Release asset checksum differs')
  stream.seek(0)
 client=paramiko.SSHClient()
 try:
  client.load_host_keys(os.path.expanduser(options.get('knownHosts','~/.ssh/known_hosts')));client.set_missing_host_key_policy(paramiko.RejectPolicy())
  client.connect(options['sshHost'],username=user,password=password,look_for_keys=False,allow_agent=False,timeout=15)
  channel=client.get_transport().open_session(timeout=15);channel.settimeout(15);channel.exec_command(command)
  return collect(channel,password,prompt,ready,timeout,stream)
 finally:
  client.close()
  if stream:stream.close()
if __name__=='__main__':
 try:
  if len(sys.argv)!=3 or sys.argv[1]!='--execute':raise ValueError('Explicit --execute and a non-secret options JSON file required')
  code,out,err=run(json.loads(pathlib.Path(sys.argv[2]).read_text()))
  sys.stdout.buffer.write(out);sys.stderr.buffer.write(err);sys.exit(code)
 except Exception as error:
  print(json.dumps({'error':'Verified operator transport failed','type':type(error).__name__}),file=sys.stderr);sys.exit(1)
