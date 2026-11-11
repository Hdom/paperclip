import json,time,urllib.request,datetime
from driver import P,BASE
f=json.loads((P/'fixture.json').read_text())
def get(p):
 with urllib.request.urlopen(BASE+p,timeout=10) as r:return json.load(r)
def dt(s):return datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
def check():
 path='/issues/'+f['issueId'];i=get(path);runs=get(path+'/runs');assert isinstance(runs,list)
 runs.sort(key=lambda r:(r.get('createdAt') or r['startedAt'],r['runId']))
 assert len(runs)==4,'Expected four runs'
 assert [r['agentId'] for r in runs]==[f['roles'][x] for x in ['Planner','Coordinator','Planner','Coordinator']]
 assert all(r['finishedAt'] and r['status'] in ['cancelled','succeeded'] for r in runs)
 s=i['executionState'];assert i['status']=='in_review' and i['assigneeAgentId'] is None and i['assigneeUserId']=='local-board'
 assert s['status']=='pending' and s['currentStageId']==f['humanId'] and s['currentStageType']=='approval' and s['currentParticipant']['type']=='user'
 ev=[json.loads(x) for x in (P/'agent-events.jsonl').read_text().splitlines()]
 reads=[e for e in ev if e.get('role')=='Coordinator' and e.get('method')=='GET' and e.get('path','').endswith('/documents/plan')]
 assert [e['data']['latestRevisionNumber'] for e in reads]==[1,2]
 doc=get(path+'/documents/plan');assert doc['latestRevisionNumber']==2 and doc['latestRevisionId']==reads[-1]['data']['latestRevisionId'] and 'validation details' in doc['body']
 # A handoff can cancel its actor before the HTTP response is logged. Verify
 # persisted decision state through independent board GET observations instead.
 observed=[]
 for line in (P/'driver-events.jsonl').read_text().splitlines():
  event=json.loads(line)
  if event.get('method')!='GET' or event.get('path')!=path or event.get('status')!=200:continue
  state=event.get('data',{}).get('executionState') or {}
  if state.get('lastDecisionId') and not any(d['lastDecisionId']==state['lastDecisionId'] for d in observed):observed.append(state)
 ds=observed
 assert len(ds)==2, 'Expected two independently observed persisted decisions'
 assert [d['lastDecisionOutcome'] for d in ds]==['changes_requested','approved']
 assert ds[0]['currentStageId']==f['reviewId'] and ds[0]['changesRequestedCount']==1
 assert ds[1]['currentStageId']==f['humanId'] and ds[1]['currentStageType']=='approval'
 assert len({d['lastDecisionId'] for d in ds})==2 and s['lastDecisionId']==ds[-1]['lastDecisionId']
 deny=[e for e in ev if e['event']=='human_gate_denial'];assert len(deny)==2 and {e['attemptedStatus'] for e in deny}=={'done','in_progress'}
 for e in deny:
  assert e['status']==403 and (e['data'].get('code') or e['data'].get('details',{}).get('code'))=='issue_handed_off'
  assert e['runId']==runs[-1]['runId'] and dt(e['at'])<dt(runs[-1]['finishedAt'])
 assert any(e['event']=='human_gate_assertions_passed' for e in ev)
 return {'passed':True,'runOrder':[{k:r.get(k) for k in ['runId','agentId','status','createdAt','startedAt','finishedAt']} for r in runs],'issueId':f['issueId'],'status':i['status'],'statusVersion':i['statusVersion'],'executionState':s,'observedDecisionIds':[d['lastDecisionId'] for d in ds],'revisionId':doc['latestRevisionId'],'activeRunHumanGateDenied':True,'limits':['Two decisions observed through independent board HTTP reads, not SQL ledger count.','No extra run in bounded observation; no implementation actor created.','Synthetic local Codex peer, not live model/SSH; no marker/crash or native document-revision-bound approval proof.']}
if __name__=='__main__':
 end=time.monotonic()+30
 while True:
  try:out=check();break
  except (AssertionError,OSError):
   if time.monotonic()>=end:raise
   time.sleep(1)
 time.sleep(5);out=check();(P/'verified-http.json').write_text(json.dumps(out,indent=2));print('PASS: packaged ordinary chain and active-run human hold')
