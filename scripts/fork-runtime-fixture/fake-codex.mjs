import fs from 'node:fs';
const emit=x=>console.log(JSON.stringify(x));
if(process.argv.includes('--version')){console.log('codex-cli 0.115.0 (synthetic handoff fixture)');process.exit(0)}
if(!process.env.PAPERCLIP_RUN_ID){emit({type:'thread.started',thread_id:'synthetic-probe'});emit({type:'item.completed',item:{type:'agent_message',text:'Hello'}});emit({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}});process.exit(0)}
const runId=process.env.PAPERCLIP_RUN_ID,role=process.env.FIXTURE_ROLE;
const startTicks=fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19];
fs.appendFileSync(process.env.FIXTURE_CHILDREN,JSON.stringify({pid:process.pid,startTicks})+'\n');
const lifetime=setTimeout(()=>process.exit(124),45000);lifetime.unref();
const fixture=JSON.parse(fs.readFileSync(process.env.FIXTURE_FILE,'utf8'));
const base=process.env.PAPERCLIP_API_URL;
if(base!=='http://127.0.0.1:3107')throw Error('Unexpected target refused');
function clean(v){if(Array.isArray(v))return v.map(clean);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,w])=>[k,/token|secret|password|authorization|apikey|adapterconfig|env/i.test(k)?'[REDACTED]':clean(w)]));return v}
function publicData(d){return Object.fromEntries(['id','key','status','statusVersion','assigneeAgentId','assigneeUserId','executionState','latestRevisionId','latestRevisionNumber','body','code'].filter(k=>k in d).map(k=>[k,d[k]]).concat(d.details?.code?[['details',{code:d.details.code}]]:[]))}
function log(event,data={}){fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({at:new Date().toISOString(),role,runId,event,...clean(data)})+'\n')}
let terminationTimer;
process.on('SIGTERM',()=>{if(terminationTimer)return;log('sigterm',{terminationDelayMs:1800});terminationTimer=setTimeout(()=>{log('exit_after_term');process.exit(0)},1800)});
const headers={Authorization:'Bearer '+process.env.PAPERCLIP_API_KEY,'Content-Type':'application/json','X-Paperclip-Run-Id':runId};
async function api(method,path,body){const r=await fetch(base+'/api'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const data=await r.json();log('http',{method,path,status:r.status,data:publicData(data)});if(!r.ok)throw Error('HTTP '+r.status);return data}
emit({type:'thread.started',thread_id:'synthetic-'+runId});emit({type:'turn.started'});
try{
 log('start',{agentId:process.env.PAPERCLIP_AGENT_ID});
 const me=await api('GET','/agents/me');if(me.id!==process.env.PAPERCLIP_AGENT_ID)throw Error('Actor mismatch');
 const path='/issues/'+fixture.issueId,issue=await api('GET',path);
 if(issue.assigneeAgentId!==me.id){log('not_assigned');process.exit(0)}
 const beforeState=JSON.stringify(issue.executionState);
 const checked=await api('POST',path+'/checkout',{agentId:me.id,expectedStatuses:[issue.status]});
 if(checked.assigneeAgentId!==me.id||checked.checkoutRunId!==runId)throw Error('Checkout lease mismatch');
 if(role==='Coordinator'&&(checked.status!=='in_review'||JSON.stringify(checked.executionState)!==beforeState))throw Error('Checkout changed native review stage');
 if(role==='Planner'&&checked.status!=='in_progress')throw Error('Producer checkout failed');
 const after=await api('GET',path);
 if(after.status!==checked.status||JSON.stringify(after.executionState)!==JSON.stringify(checked.executionState))throw Error('Persisted checkout mismatch');
 log('checkout_invariant_passed',{status:checked.status,executionState:checked.executionState});
 if(role==='Planner'){
  const r=await fetch(base+'/api'+path+'/documents/plan',{headers,signal:AbortSignal.timeout(15000)});if(!r.ok&&r.status!==404)throw Error('Plan lookup failed');const old=r.ok?await r.json():null;
  const n=old?2:1;if(old&&old.latestRevisionNumber!==1)throw Error('Unexpected rework count');
  const doc=await api('PUT',path+'/documents/plan',{format:'markdown',title:'Synthetic plan',body:'# Synthetic plan revision '+n+'\n'+(n===1?'Initial proposal requiring validation details.':'Revised proposal with validation details and explicit human approval before implementation.'),changeSummary:'Synthetic revision '+n,...(old?{baseRevisionId:old.latestRevisionId}:{})});
  if(doc.key!=='plan')throw Error('Wrong document');
  await api('PATCH',path,{status:'in_review',comment:'Synthetic Planner submits current plan '+doc.latestRevisionId,reviewRequest:{instructions:'Review exact current revision '+doc.latestRevisionId}});
 }else if(role==='Coordinator'){
  const doc=await api('GET',path+'/documents/plan');
  if(doc.latestRevisionNumber===1)await api('PATCH',path,{status:'in_progress',comment:'Synthetic Coordinator requests validation details for '+doc.latestRevisionId});
  else if(doc.latestRevisionNumber===2&&doc.body.includes('validation details')){
   const hold=await api('PATCH',path,{status:'done',comment:'Synthetic Coordinator approves revision '+doc.latestRevisionId+'; human approval still required.'});
   if(hold.status!=='in_review'||hold.executionState.currentParticipant.type!=='user')throw Error('Missing human hold');
   for(const status of ['done','in_progress']){const r=await fetch(base+'/api'+path,{method:'PATCH',headers,body:JSON.stringify({status,comment:'Synthetic active-run human-stage denial assertion'}),signal:AbortSignal.timeout(15000)});const data=await r.json();log('human_gate_denial',{attemptedStatus:status,status:r.status,data:publicData(data)});if(r.status!==403||(data.code??data.details?.code)!=='issue_handed_off')throw Error('Human gate not proven')}
   const still=await api('GET',path);if(still.statusVersion!==hold.statusVersion||JSON.stringify(still.executionState)!==JSON.stringify(hold.executionState))throw Error('Human stage changed');log('human_gate_assertions_passed');
  }else throw Error('Unexpected plan revision');
 }else throw Error('Unexpected role');
 await new Promise(r=>setTimeout(r,2500));log('finish');emit({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}});
}catch(e){log('error',{message:String(e)});process.exitCode=1}
