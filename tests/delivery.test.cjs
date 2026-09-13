const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {loader} = require('./load-ts.cjs');
const d = loader()(path.resolve(__dirname,'../src/lib/delivery.ts'));
const native = require('../electron/tools/verification.cjs');
const state = () => ({working:[{id:'u1',role:'user',content:'生成包含三项的 JSON，并检查覆盖全部课程',createdAt:1}],requirementSourceIds:['u1'],milestones:[],steps:[],requirements:[],round:1,at:1,stoppedBy:'unknown'});
const requirement = (more={}) => ({id:'r1',title:'交付三条数据',sourceId:'u1',sourceQuote:'包含三项的 JSON',check:{kind:'json',path:path.resolve('out.json'),count:3},...more});

test('requirements reject invented/internal sources and preserve omitted requirements atomically',()=>{
  const s=state();s.working.push({id:'internal',role:'user',content:'继续任务'});
  assert.equal(d.updateRequirements(s,{requirements:[requirement()]}).ok,true);
  assert.equal(d.updateRequirements(s,{requirements:[requirement({id:'bad',sourceId:'internal',sourceQuote:'继续任务'})]}).ok,false);
  assert.equal(s.requirements.length,1);
  assert.equal(d.updateRequirements(s,{requirements:[requirement({id:'r2',check:{kind:'review'}}),requirement({id:'r3',sourceQuote:'invented'})]}).ok,false);
  assert.equal(s.requirements.length,1);
});

test('evidence existence cannot set a program check to passed; failed conditions block delivery',async()=>{
  const s=state();d.updateRequirements(s,{requirements:[requirement()]});
  await d.verifyRequirements(s,{ids:['r1'],reviews:[{id:'r1',status:'passed',detail:'I think done',evidence:['anything']}]},async()=>({ok:true,content:JSON.stringify({status:'failed',detail:'记录只有两项'})}));
  assert.equal(d.deliveryReport(s).status,'failed');assert.equal(s.requirements[0].verification.method,'program');
  assert.equal(d.updateRequirements(s,{requirements:[requirement({check:{kind:'file_exists',path:path.resolve('out.json')}})]}).ok,false);
});

test('new user requirements invalidate prior verification and retain both versions',async()=>{
  const s=state();d.updateRequirements(s,{requirements:[requirement()]});
  await d.verifyRequirements(s,{ids:['r1']},async()=>({ok:true,content:'{"status":"passed","detail":"three rows"}'}));
  s.working.push({id:'u2',role:'user',content:'改成四项',createdAt:2});s.requirementSourceIds.push('u2');
  const result=d.updateRequirements(s,{requirements:[requirement({sourceId:'u2',sourceQuote:'四项',check:{kind:'json',path:path.resolve('out.json'),count:4}})]});
  assert.equal(result.ok,true);assert.equal(s.requirements[0].revision,2);assert.equal(d.deliveryReport(s).status,'unchecked');
  assert.equal(s.requirements[0].history[0].check.count,3);assert.equal(s.requirements[0].verificationHistory[0].status,'passed');
});

test('model reviews require real evidence and remain labelled model, unknown is not success',async()=>{
  const s=state();d.updateRequirements(s,{requirements:[requirement({check:{kind:'review'}})]});
  s.steps.push({id:'plan',callId:'plan-call',name:'update_requirements',status:'ok'});
  assert.equal((await d.verifyRequirements(s,{ids:['r1'],reviews:[{id:'r1',status:'passed',detail:'覆盖全部课程已确认',evidence:['plan-call']}]},()=>{})).ok,false);
  await d.verifyRequirements(s,{ids:['r1'],reviews:[{id:'r1',status:'unverifiable',detail:'没有课程原始清单，无法判断覆盖完整性'}]},()=>{});
  assert.equal(d.deliveryReport(s).status,'unverifiable');assert.equal(s.requirements[0].verification.method,'model');
  assert.equal(d.deliveryReport(state()).status,'unchecked');
});

test('multi-item verification adopts atomically when inspector is interrupted',async()=>{
  const s=state();d.updateRequirements(s,{requirements:[requirement(),requirement({id:'r2'})]});let count=0;
  const result=await d.verifyRequirements(s,{ids:['r1','r2']},async()=>{if(++count===2)throw new Error('cancel');return {ok:true,content:'{"status":"passed","detail":"checked"}'};});
  assert.equal(result.ok,false);assert.ok(s.requirements.every(r=>!r.verification));
});

test('native inspection checks JSON structure, ICS conditions and file scope without altering files',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anyai-delivery-'));const ctx={workspaceRoots:[root]};
  try {
    const p=path.join(root,'out.json');fs.writeFileSync(p,JSON.stringify([{name:'A'},{wrong:'B'}]));
    const inspect=a=>JSON.parse(native.inspectDeliverable(a,ctx).content);
    assert.equal(inspect({kind:'file_exists',path:p}).status,'passed');
    assert.equal(inspect({kind:'json',path:p,count:3}).status,'failed');
    assert.equal(inspect({kind:'json',path:p,count:2,requiredKeys:['name']}).status,'failed');
    assert.equal(inspect({kind:'json',path:p,count:2}).status,'passed');
    assert.equal(inspect({kind:'file_exists',path:path.join(root,'missing')}).status,'failed');
    assert.equal(inspect({kind:'file_exists',path:__filename}).status,'unverifiable');
    const ics=path.join(root,'out.ics');fs.writeFileSync(ics,'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:one\r\nDTSTAMP:20260913T120000Z\r\nDTSTART;VALUE=DATE:20260914\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
    assert.equal(inspect({kind:'ics',path:ics,count:1}).status,'passed');assert.equal(inspect({kind:'ics',path:ics,count:2}).status,'failed');
    fs.writeFileSync(ics,'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nEND:VCALENDAR');assert.equal(inspect({kind:'ics',path:ics}).status,'failed');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('uncertain writes are recovered only when exact bytes match, never repeated',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anyai-recover-'));const p=path.join(root,'out.txt');
  try {
    fs.writeFileSync(p,'exact\r\n');const before=fs.statSync(p).mtimeMs;
    assert.equal(native.recoverExactWrite({path:p,content:'exact\r\n'},{workspaceRoots:[root]}).ok,true);
    assert.equal(native.recoverExactWrite({path:p,content:'exact\n'},{workspaceRoots:[root]}),null);
    assert.equal(native.recoverExactWrite({path:p,content:'exact\r\n'},{workspaceRoots:[]}),null);
    assert.equal(fs.statSync(p).mtimeMs,before);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('recovery distinguishes user pause, budget and uncertain external operation',()=>{
  const s=state();s.reason='达到预算';assert.equal(d.recoveryInfo(s).kind,'budget');
  s.stoppedBy='user';assert.equal(d.recoveryInfo(s).kind,'user');
  s.uncertainCallId='write';s.pendingCalls=[{id:'write',name:'write_file',arguments:'{"path":"C:/work/output.txt","content":"PRIVATE_BODY"}'}];
  const info=d.recoveryInfo(s);assert.equal(info.kind,'uncertain');assert.equal(info.canAddInput,false);assert.equal(info.target,'C:/work/output.txt');assert.doesNotMatch(JSON.stringify(info),/PRIVATE_BODY/);
});

function agentHarness(chat,callTool,extra={}){
  const file=p=>path.resolve(__dirname,'..',p);let finish,serial=0;const log={states:[],done:0,requests:[]};const finished=new Promise(r=>finish=r);
  const local=loader({[file('src/lib/transport.ts')]:{getTransport:()=>({chat:async(i,e)=>{log.requests.push(i);await chat(i,e);},callTool:callTool??(async()=>({ok:true,content:''})),abort:async()=>{}})},[file('src/lib/store.ts')]:{uid:()=>`generated-${++serial}`}});
  const cfg=local(file('src/lib/paramSchema.ts')).defaultGenerationConfig();Object.assign(cfg,{model:'qa',toolsEnabled:true,enabledTools:['write_file'],approvalMode:'all',maxToolRounds:12,runtime:{contextTokens:24000,maxTokens:300000,maxMinutes:1}});
  const handle=local(file('src/lib/agent.ts')).runAgent({requestId:'delivery-run',profile:{id:'qa',baseUrl:'http://localhost/v1'},apiKey:'fake',config:cfg,history:state().working,toolCtx:()=>({workspaceRoots:[]}),effortMappings:[],extraSystem:'',timeoutMs:1000,canRunHostTools:true,autoRetry:0,confirm:async()=>true,grantAccess:async()=>({ok:true,content:''}),...extra,
    events:{onContentDelta(){},onReasoningDelta(){},onSources(){},onUsage(){},onRound(){},onNotice(){},onStopReason(){},onStep(){},onRunState:s=>{if(s)log.states.push(structuredClone(s));},onDone(){log.done++;finish();},onPaused(reason){log.reason=reason;finish();},onError(error){log.error=error;finish();}}});
  return{handle,finished,log};
}
const respond=(e,text,calls=[])=>{e.onContent(text);e.onToolCalls(calls);e.onStop({reason:calls.length?'tool_calls':'stop',droppedCalls:0});e.onUsage({prompt_tokens:100,completion_tokens:50,total_tokens:150});e.onDone();};
const call=(id,name,args)=>({id,name,arguments:JSON.stringify(args)});

test('real agent cannot finish after a failed deterministic check, repairs and rechecks before delivery',async()=>{
  let requests=0,rows=2,checks=0;
  const h=agentHarness(async(_,e)=>{
    if(requests++===0)respond(e,'建立验收条件',[call('req','update_requirements',{requirements:[requirement()]})]);
    else if(requests===2)respond(e,'文件已经写好，可以交付。');
    else if(requests===3)respond(e,'根据验收失败补齐第三项',[call('fix','write_file',{path:path.resolve('out.json'),content:'three rows'})]);
    else respond(e,'三项记录已经核对。');
  },async(name)=>{
    if(name==='inspect_deliverable'){checks++;return{ok:true,content:JSON.stringify({status:rows===3?'passed':'failed',detail:rows===3?'三项记录已核对':'实际只有两项'})};}
    rows=3;return{ok:true,content:'已修复',files:[{path:path.resolve('out.json'),direction:'output'}]};
  });
  await h.finished;assert.equal(h.log.done,1);assert.equal(h.log.requests.length,4);assert.equal(checks,2);assert.equal(h.log.states.at(-1).delivery.status,'passed');
  assert.ok(h.log.states.some(s=>s.delivery?.status==='failed'));
});

test('repeated false completion pauses with the failed requirement and preserves artifacts',async()=>{
  let n=0;const h=agentHarness(async(_,e)=>n++===0?respond(e,'',[call('req','update_requirements',{requirements:[requirement()]})]):respond(e,'Everything is done'),async()=>({ok:true,content:'{"status":"failed","detail":"缺少第三条记录"}'}));
  await h.finished;assert.equal(h.log.done,0);assert.match(h.log.reason,/验收尚未通过/);assert.equal(h.log.states.at(-1).recovery.kind,'verification');assert.equal(h.log.states.at(-1).requirements.length,1);
});

test('supplement during pending tools preserves wire pairing and cancels unstarted old actions before replanning',async()=>{
  const s=state();const pending=call('old-write','write_file',{path:'C:/work/old.txt',content:'do not write'});
  Object.assign(s,{runId:'prior',version:2,phase:'tools',pendingCalls:[pending],toolCursor:0,status:'paused',working:[...s.working,{id:'a1',role:'assistant',content:'',toolCalls:[pending],createdAt:2}]});
  const next=d.addRunInput(s,{id:'u2',content:'不要执行旧写入，改为解释当前结果',createdAt:3});
  assert.equal(next.working.at(-1).role,'assistant');assert.equal(next.pendingInputMessages.length,1);let writes=0;
  const h=agentHarness(async(init,e)=>{const body=JSON.stringify(init.body);assert.match(body,/不要执行旧写入/);assert.equal(init.body.messages.at(-1).role,'user');respond(e,'按新要求解释，旧写入没有执行。');},async(name)=>{
    if(name==='reconcile_operation')return{ok:false,operationStatus:'not_started',content:'尚未开始，已取消'};writes++;return{ok:true,content:'unexpected'};
  },{resume:next});
  await h.finished;assert.equal(h.log.done,1);assert.equal(writes,0);assert.equal(h.log.states.at(-1).steps[0].status,'denied');assert.ok(h.log.states.at(-1).requirementSourceIds.includes('u2'));
});

test('supplement cannot silently skip an uncertain external operation',async()=>{
  const s=state(),pending=call('command','run_command',{command:'external action'});
  Object.assign(s,{runId:'prior',version:2,phase:'tools',pendingCalls:[pending],toolCursor:0,status:'paused',working:[...s.working,{id:'a1',role:'assistant',content:'',toolCalls:[pending],createdAt:2}]});
  const next=d.addRunInput(s,{id:'u2',content:'修改接下来的要求',createdAt:3});
  const h=agentHarness(async()=>assert.fail('must resolve prior action first'),async()=>({ok:false,uncertain:true,operationStatus:'uncertain',content:'',error:'旧操作已开始，无法确认结果'}),{resume:next});
  await h.finished;assert.equal(h.log.done,0);assert.equal(h.log.states.at(-1).uncertainCallId,'command');assert.equal(h.log.states.at(-1).pendingInputMessages.length,1);
});
