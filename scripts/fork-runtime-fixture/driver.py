import json,pathlib,time,urllib.request,urllib.error,uuid,os
H=pathlib.Path(__file__).resolve().parent
P=pathlib.Path(os.environ['HANDOFF_EVIDENCE']).resolve()
WORKSPACE=pathlib.Path(os.environ['HANDOFF_WORKSPACE']).resolve()
BASE='http://127.0.0.1:3107/api'
def clean(v):
 if isinstance(v,dict):return {k:('[REDACTED]' if any(s in k.lower() for s in ['token','secret','password','authorization','apikey','adapterconfig','env']) else clean(w)) for k,w in v.items()}
 if isinstance(v,list):return [clean(w) for w in v]
 return v
def api(method,path,body=None):
 req=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'},method=method)
 try:
  with urllib.request.urlopen(req,timeout=15) as r:status,data=r.status,json.load(r)
 except urllib.error.HTTPError as e:status,data=e.code,json.load(e)
 with (P/'driver-events.jsonl').open('a') as f:f.write(json.dumps({'at':time.time(),'method':method,'path':path,'status':status,'data':{k:clean(data[k]) for k in ['id','status','statusVersion','assigneeAgentId','assigneeUserId','executionState'] if k in data}})+'\n')
 if status>=400:raise RuntimeError('HTTP '+str(status)+' '+path)
 return data
if __name__=='__main__':
 P.mkdir(parents=True,exist_ok=False)
 c=api('POST','/companies',{'name':'Disposable packaged handoff','defaultResponsibleUserId':'local-board'});cid=c['id']
 api('PATCH','/companies/'+cid,{'requireBoardApprovalForNewAgents':False})
 roles={}
 for role in ['Planner','Coordinator']:
  a=api('POST','/companies/'+cid+'/agents',{'name':'Synthetic '+role,'role':'engineer','adapterType':'codex_local','runner':'legacy','adapterConfig':{'command':str(H/'codex'),'engine':'cli','args':[],'cwd':str(WORKSPACE),'graceSec':4,'timeoutSec':40,'dangerouslyBypassApprovalsAndSandbox':False,'env':{'OPENAI_API_KEY':'synthetic-handoff-local-peer-not-a-real-key','FIXTURE_ROLE':role,'FIXTURE_FILE':str(P/'fixture.json'),'FIXTURE_LOG':str(P/'agent-events.jsonl'),'FIXTURE_CHILDREN':str(P/'children.jsonl')}},'runtimeConfig':{'heartbeat':{'enabled':False,'wakeOnAssignment':True,'wakeOnDemand':True,'maxConcurrentRuns':1}},'permissions':{'canCreateAgents':False}})
  roles[role]=a['id']
 review,human=str(uuid.uuid4()),str(uuid.uuid4())
 issue=api('POST','/companies/'+cid+'/issues',{'title':'Synthetic review and human hold','status':'backlog','assigneeAgentId':roles['Planner'],'responsibleUserId':'local-board','executionPolicy':{'mode':'normal','commentRequired':True,'maxReviewRounds':3,'stages':[{'id':review,'type':'review','approvalsNeeded':1,'participants':[{'type':'agent','agentId':roles['Coordinator']}]},{'id':human,'type':'approval','approvalsNeeded':1,'participants':[{'type':'user','userId':'local-board'}]}]}})
 (P/'fixture.json').write_text(json.dumps({'companyId':cid,'issueId':issue['id'],'roles':roles,'reviewId':review,'humanId':human},indent=2))
 api('PATCH','/issues/'+issue['id'],{'status':'todo','comment':'Start disposable synthetic planning only.'})
 deadline=time.monotonic()+90
 while time.monotonic()<deadline:
  time.sleep(1);i=api('GET','/issues/'+issue['id'])
  if (i.get('executionState') or {}).get('currentStageId')==human:break
 else:raise RuntimeError('Timed out before human hold')
 time.sleep(6)
 print('HUMAN_HOLD_REACHED; run verify.py for acceptance')
