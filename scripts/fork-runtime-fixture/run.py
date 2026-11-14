"""Run only the synthetic fixture against an already-started loopback test app.
Runtime owner verifies artifact/source identity and owns server/DB stop.
"""
import os,pathlib,subprocess,sys,time,signal,json,hashlib
H=pathlib.Path(__file__).resolve().parent
R=pathlib.Path(os.environ['HANDOFF_ROOT']).resolve()
P=R/'evidence'/'handoff'
W=R/'handoff-workspace'
os.environ['HANDOFF_EVIDENCE']=str(P)
os.environ['HANDOFF_WORKSPACE']=str(W)
assert os.environ.get('PAPERCLIP_API_URL')=='http://127.0.0.1:3107'
assert not P.exists(), 'Evidence target must be fresh'
assert W.is_dir(), 'Runtime owner must prepare disposable workspace'
assert os.environ.get('HANDOFF_SOURCE_COMMIT')=='592e08a5da9ece1083ffeea913686ae8ae01728b'
assert os.environ.get('HANDOFF_ARTIFACT_ID')=='13886309184'
# Hard overall wall ceiling includes cleanup; reserve25seconds for teardown.
signal.signal(signal.SIGALRM,lambda *_:os._exit(124))
signal.alarm(240)
end=time.monotonic()+215
child=None
result={'expectedSourceCommit':os.environ['HANDOFF_SOURCE_COMMIT'],'expectedArtifactId':os.environ['HANDOFF_ARTIFACT_ID'],'identityVerification':'Runtime owner must independently verify these expected identities.','fixtureHashes':{n:hashlib.sha256((H/n).read_bytes()).hexdigest() for n in ['codex','fake-codex.mjs','driver.py','verify.py','run.py']},'wallDeadlineSeconds':240,'workBudgetSeconds':215,'cleanupBudgetSeconds':20,'passed':False}
def stop_driver():
 global child
 if child is not None and child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=2)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=2)
def cleanup_fixture_children():
 records=[];file=P/'children.jsonl';cleanup_end=time.monotonic()+20
 if not file.exists():return records
 lines=file.read_text().splitlines()
 if len(lines)>8:return [{'status':'cleanup_uncertain','reason':'Unexpected child count; child lifetime cap remains active'}]
 for line in lines:
  if time.monotonic()>=cleanup_end:
   records.append({'status':'cleanup_uncertain','reason':'Cleanup wall budget exhausted'});break
  item=json.loads(line);pid=item['pid'];rec={'pid':pid,'status':'already_exited'};fd=None
  try:
   fd=os.pidfd_open(pid)
   proc=pathlib.Path('/proc')/str(pid)
   ticks=(proc/'stat').read_text().split(') ')[1].split()[19]
   argv=(proc/'cmdline').read_bytes().split(b'\0')
   if ticks!=item['startTicks'] or str(H/'fake-codex.mjs').encode() not in argv:
    rec['status']='identity_mismatch_not_signalled'
   else:
    signal.pidfd_send_signal(fd,signal.SIGTERM)
    import select
    poll=select.poll();poll.register(fd,select.POLLIN)
    if not poll.poll(max(0,min(2500,int((cleanup_end-time.monotonic())*1000)))):signal.pidfd_send_signal(fd,signal.SIGKILL)
    rec['status']='terminated' if poll.poll(max(0,min(2000,int((cleanup_end-time.monotonic())*1000)))) else 'cleanup_uncertain'
  except ProcessLookupError:pass
  except FileNotFoundError:pass
  except Exception as e:rec={'pid':pid,'status':'cleanup_error','error':type(e).__name__}
  finally:
   if fd is not None:os.close(fd)
  records.append(rec)
 return records
try:
 for script in ['driver.py','verify.py']:
  remaining=end-time.monotonic()
  if remaining<=0:raise TimeoutError('Fixture wall deadline exceeded')
  child=subprocess.Popen([sys.executable,str(H/script)],env=os.environ.copy(),start_new_session=True)
  code=child.wait(timeout=remaining)
  if code:raise RuntimeError(script+' exited '+str(code))
 result['passed']=True
except Exception as e:
 result['failure']=type(e).__name__+': '+str(e)
finally:
 stop_driver()
 result['fixtureChildCleanup']=cleanup_fixture_children()
 if any(r['status'] in ['identity_mismatch_not_signalled','cleanup_uncertain','cleanup_error'] for r in result['fixtureChildCleanup']):result['passed']=False
 if P.is_dir():(P/'runner-result.json').write_text(json.dumps(result,indent=2))
 print(json.dumps({'passed':result['passed'],'failure':result.get('failure'),'fixtureChildCleanup':result.get('fixtureChildCleanup')}))
sys.exit(0 if result['passed'] else 1)
