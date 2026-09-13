const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loader } = require('./load-ts.cjs');
const file = p => path.resolve(__dirname,'..',p);
const load = loader();
const a = load(file('src/lib/adaptive.ts'));
const memory = load(file('src/lib/context-memory.ts'));
const limits = load(file('src/lib/limits.ts'));
const schema = load(file('src/lib/paramSchema.ts'));
const pacer = load(file('src/lib/pacer.ts'));
const cfg = () => ({ ...schema.defaultGenerationConfig(),model:'qa-model' });
const profile = { id:'qa',baseUrl:'https://gateway.test/v1',name:'QA' };

test('window × effort matrix keeps unknown distinct, reserves reasoning once and respects manual caps', () => {
  for (const window of [undefined,32768,262144,1048576]) for (const effort of ['off','low','medium','high','xhigh','max']) {
    const c = cfg(); c.effortLevel=effort;
    const cap=a.capabilities(profile,c,undefined,{id:c.model,contextWindow:window});
    const body=a.prepareBody(schema.buildRequestBody(c,[],[],[]),c,cap);
    const reserve=a.outputReserve(body,c,cap), budget=a.workingBudget(c,cap,reserve);
    assert.equal(cap.contextWindow,window);
    if (!window) assert.equal(budget,24000);
    else assert.ok(budget+reserve+1024<=window);
    if (window>=262144) assert.equal(budget,96000);
    c.runtime.contextMode='manual';c.runtime.contextTokens=70000;
    assert.ok(a.workingBudget(c,cap,reserve)<=70000);
  }
  const c=cfg();c.effortLevel='high';
  const body={model:c.model,max_completion_tokens:30000,thinking:{type:'enabled',budget_tokens:20000}};
  assert.equal(a.outputReserve(body,c,{}),30000);
  assert.equal(a.workingBudget(c,{contextWindow:32768},30000),1744);
  assert.throws(()=>a.outputReserve({...body,max_completion_tokens:15000},c,{}),/思考预算/);
  assert.equal(a.outputReserve({model:c.model},c,{maxOutput:2048}),2048);
});

test('capabilities are endpoint scoped; explicit quota groups combine credentials without combining windows', () => {
  const c=cfg(); const p={...profile,routeProfiles:{[a.routeKey(profile,c.model)]:{contextWindow:262144,tpm:90000}}};
  assert.equal(a.capabilities(p,c).contextWindow,262144);
  const changed={...p,baseUrl:'https://other.test/v1'};
  assert.equal(a.capabilities(changed,c).contextWindow,undefined);
  assert.notEqual(a.quotaKey(p),a.quotaKey(changed));
  assert.equal(a.quotaKey({...p,quotaGroup:'shared'}),a.quotaKey({...changed,id:'second',quotaGroup:'shared'}));
  assert.notEqual(limits.limitKey('qa','model',p.baseUrl),limits.limitKey('qa','model',changed.baseUrl));
});

test('strict upper-bound learning ignores request sizes and error codes; unrelated headers cannot refresh stale windows', () => {
  assert.deepEqual(limits.parseLimits('context too long, request 180000 tokens, code 400001'),{});
  assert.deepEqual(limits.parseLimits('maximum context length is 131072 tokens; requested 140000; request id 1234'),{maxContext:131072});
  assert.deepEqual(limits.parseLimits('maximum output tokens is 16384'),{maxOutput:16384});
  const old={maxContext:32000,tpm:10000,at:Date.now()-8*86400000,from:'old'};
  const merged=limits.mergeLearnedLimit(old,{rpm:30,tpm:60000,at:Date.now(),from:'header'});
  assert.equal(a.capabilities(profile,cfg(),merged).contextWindow,undefined);
  assert.equal(a.capabilities(profile,cfg(),merged).tpm,60000);
  const c=cfg();c.runtime.tpm=20000;
  assert.equal(a.capabilities(profile,c,merged).tpm,20000);
  assert.deepEqual(limits.quotaLimits({'anthropic-ratelimit-input-tokens-limit':'100000','anthropic-ratelimit-output-tokens-limit':'20000'}),{itpm:100000,otpm:20000});
});

test('route effort overrides preserve the requested level and reject ambiguous or incompatible output fields', () => {
  const c=cfg();c.effortLevel='xhigh';
  const cap={effortStyle:'reasoning_effort',effortValues:{xhigh:'xhigh'},outputField:'max_completion_tokens'};
  assert.deepEqual(a.prepareBody({model:c.model,max_tokens:32000,reasoning_effort:'high'},c,cap),{model:c.model,max_completion_tokens:32000,reasoning_effort:'xhigh'});
  assert.throws(()=>a.prepareBody({model:c.model},c,{...cap,effortValues:{high:'high'}}),/xhigh/);
  assert.throws(()=>a.prepareBody({model:c.model,max_tokens:10,max_completion_tokens:10},c,{}),/只设置一种/);
  assert.throws(()=>a.prepareBody({model:c.model,max_tokens:10},c,{outputField:'none'}),/不支持/);
  c.customBody='{"messages":[]}';assert.throws(()=>a.prepareBody({model:c.model},c,{}),/不能替换/);
});

test('passive token calibration stays separate for text, vision, effort and gateway', () => {
  const c=cfg(), body={model:c.model,messages:[{role:'user',content:'A real request with some useful text.'}]};
  const original=a.calibratedTokens(body,profile,c);
  a.observeInput(body,profile,c,original*2);
  assert.ok(a.calibratedTokens(body,profile,c)>=original*2);
  assert.equal(a.calibratedTokens(body,{...profile,baseUrl:'https://fresh.test'},c),original);
  const vision={model:c.model,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+'A'.repeat(1000000)}}]}]};
  assert.ok(a.calibratedTokens(vision,profile,c)<3000);
});

test('remaining quota waits for reset, does not redefine context, and input/output ledgers remain separate', () => {
  const now=Date.now();
  pacer.noteQuotaHeaders('headers',{'x-ratelimit-remaining-tokens':'0','x-ratelimit-reset-tokens':'1m30s'},now);
  assert.equal(pacer.waitForQuota('headers',{tokens:4000,input:2000,output:2000},now),90250);
  assert.equal(pacer.waitForQuota('headers',{tokens:4000,input:2000,output:2000},now+91000),0);
  pacer.noteQuotaHeaders('positive',{'anthropic-ratelimit-input-tokens-remaining':'1200','anthropic-ratelimit-input-tokens-reset':new Date(now+20000).toISOString()},now);
  pacer.consumeQuota('positive',{tokens:500,input:500,output:0});
  assert.ok(pacer.waitForQuota('positive',{tokens:800,input:800,output:0},now)>=20000);
  pacer.reserveTokens('pool:input','r',1000);pacer.reserveTokens('pool:output','r',8000);
  pacer.reconcileTokens('pool:input','r',300);
  assert.equal(pacer.waitForTokens('pool:input',500,1000),0);
  assert.ok(pacer.waitForTokens('pool:output',1000,8500)>59000);
  assert.throws(()=>pacer.waitForTokens('pool:output',9000,8500),/等待不能解决/);
  assert.equal(pacer.resetDeadline('250ms',now),now+250);
});

const longState=()=>{
  const working=[{id:'goal',role:'user',content:'所有课程；时区 America/Vancouver；保留原日期与更正；路径 C:\\课程\\学期.ics',createdAt:1,
    attachments:[{id:'doc',name:'课程.txt',kind:'text',text:'EXACT_ORIGINAL_ATTACHMENT',path:'C:\\课程\\课程.txt'}]}];
  const steps=[];
  for(let i=0;i<14;i++) {
    working.push({id:'a'+i,role:'assistant',content:'Source investigation '.repeat(850),toolCalls:[{id:'c'+i,name:'read_file',arguments:'{"path":"course'+i+'"}'}],createdAt:i+2},
      {id:'t'+i,role:'tool',toolCallId:'c'+i,toolName:'read_file',content:'RAW_EVIDENCE_'+i+' '+'data '.repeat(i>=11?9600:1800),createdAt:i+2});
    steps.push({id:'s'+i,callId:'c'+i,name:'read_file',status:'ok',summary:'Read course '+i,startedAt:i+2,files:i===0?[{path:'C:\\课程\\学期.ics',direction:'output'}]:[]});
  }
  return {version:2,runId:'long',round:15,phase:'request',status:'paused',working,steps,at:1,stoppedBy:'user',compactions:[],milestones:[{id:'remaining',title:'检查所有课程',status:'pending',evidence:[],updatedAt:1}]};
};
test('three incremental compactions preserve exact goals, pending work, paths and retrievable original evidence', () => {
  const state=longState(), original=JSON.stringify(state.working);
  for(let i=0;i<3;i++) {
    const candidate=memory.compressionCandidate(state,15000);assert.ok(candidate);
    const previous=state.compactions.at(-1);
    const summary={facts:[...(previous?.facts??[]),{text:'Observed course',sources:[candidate.messages.at(-1).id]}],
      decisions:[{text:'Use specified timezone',sources:['goal']}],unresolved:[{text:'Remaining courses still need checking',sources:['goal']}],nextSteps:['Continue checking missing courses']};
    state.compactions.push(memory.validateCompaction(JSON.stringify(summary),state,candidate.throughIndex));
    assert.ok(state.compactions.at(-1).throughIndex>(previous?.throughIndex??-1));
  }
  assert.equal(JSON.stringify(state.working),original);
  const view=memory.memoryView(state);assert.equal(view[0].content.split('\n')[0],state.working[0].content);
  assert.match(JSON.stringify(view),/America\/Vancouver/);assert.match(memory.memoryInstructions(state),/学期.ics/);
  assert.equal(state.milestones[0].status,'pending');
  assert.match(memory.readContext(state,{id:'t0',offset:0,limit:1000}).content,/RAW_EVIDENCE_0/);
  assert.match(memory.readContext(state,{id:'goal'}).content,/EXACT_ORIGINAL_ATTACHMENT/);
  const wire=load(file('src/lib/task-context.ts')).contextView(view,state.steps,24000);
  for(const m of wire) for(const c of m.toolCalls??[]) assert.ok(wire.some(r=>r.toolCallId===c.id));
  assert.throws(()=>memory.validateCompaction(JSON.stringify({facts:[{text:'invented',sources:['fake']}],decisions:[],unresolved:[],nextSteps:[]}),state,4),/来源/);
});

test('milestones merge without dropping pending scope and require existing successful evidence', () => {
  const state=longState();
  assert.equal(memory.updatePlan(state,{milestones:[{id:'new',title:'Write',status:'completed',evidence:['fabricated']}]}).ok,false);
  assert.equal(state.milestones.length,1);
  assert.equal(memory.updatePlan(state,{milestones:[{id:'new',title:'Read course',status:'completed',evidence:['c0']}]}).ok,true);
  assert.equal(state.milestones[0].status,'pending');assert.equal(state.milestones[1].status,'completed');
  state.steps[0].status='error';
  assert.equal(memory.updatePlan(state,{milestones:[{id:'remaining',title:'Remaining',status:'completed',evidence:['c0']}]}).ok,false);
  assert.equal(state.milestones[0].status,'pending');
  state.steps.push({id:'plan-proof',callId:'plan-proof',name:'update_plan',status:'ok'});
  assert.equal(memory.updatePlan(state,{milestones:[{id:'remaining',title:'Remaining',status:'completed',evidence:['plan-proof']}]}).ok,false);
});

function harness(chat,extra={}) {
  const log={states:[],done:0,requests:[]};let finish,serial=0;
  const finished=new Promise(r=>finish=r);
  const transport={chat:async(init,h)=>{log.requests.push(init);await chat(init,h);},callTool:async()=>({ok:true,content:'actual result'}),abort:async()=>{extra.abort?.();}};
  const local=loader({[file('src/lib/transport.ts')]:{getTransport:()=>transport},[file('src/lib/store.ts')]:{uid:()=>`new-${++serial}`}});
  const config={...cfg(),enabledTools:['read_file'],maxToolRounds:30,runtime:{contextTokens:22000,contextMode:'manual',maxTokens:300000,maxMinutes:1}};
  const handle=local(file('src/lib/agent.ts')).runAgent({requestId:'adaptive-qa',profile,apiKey:'qa',config,history:[{id:'goal',role:'user',content:'Continue task',createdAt:1}],toolCtx:()=>({workspaceRoots:[]}),effortMappings:[],extraSystem:'',timeoutMs:1000,canRunHostTools:true,autoRetry:0,confirm:async()=>true,grantAccess:async()=>({ok:true,content:''}),...extra,
    events:{onContentDelta(){},onReasoningDelta(){},onSources(){},onUsage(){},onRound(){},onNotice(){},onStopReason(){},onStep(){},onRunState:s=>{if(s)log.states.push(structuredClone(s));},onDone(){log.done++;finish();},onPaused(reason){log.reason=reason;finish();},onError(error){log.error=error;finish();}}});
  return {handle,finished,log};
}
function response(h,text,calls=[]) { h.onContent(text);h.onToolCalls(calls);h.onStop({reason:calls.length?'tool_calls':'stop',droppedCalls:0});h.onUsage({prompt_tokens:100,completion_tokens:50,total_tokens:150});h.onDone(); }

test('Chat to Work keeps decisions, attachments and saved context while enabling tools only for the new turn', async () => {
  const relay=load(file('src/lib/handoff.ts'));
  const question={id:'discuss',role:'user',content:'先讨论发布方案，名称保留灯芯AI。',createdAt:1,
    attachments:[{id:'brief',kind:'text',name:'brief.txt',text:'附件约束：仅向已报名用户发布。',mime:'text/plain',size:40}]};
  const chatConfig={...cfg(),toolsEnabled:false,enabledTools:['read_file']};
  const chat=harness(async(init,e)=>{
    assert.ok(!init.body.tools?.length);
    response(e,'决定：使用精简中文，发布时间为周五。');
  },{history:[question],config:chatConfig});
  await chat.finished;assert.equal(chat.log.done,1);
  const answer={id:'chat-answer',role:'assistant',content:'决定：使用精简中文，发布时间为周五。',createdAt:2,taskId:'chat-run'};
  const history=[question,answer,{id:'execute',role:'user',content:'按上面的方案检查资料并继续执行。',createdAt:3}];
  const record={id:'chat-run',answerId:answer.id,question,config:chatConfig,state:chat.log.states.at(-1)};
  const work=harness(async(init,e)=>{
    const wire=JSON.stringify(init.body.messages);
    for(const text of ['名称保留灯芯AI','仅向已报名用户发布','发布时间为周五','按上面的方案检查资料'])assert.ok(wire.includes(text),text);
    assert.ok(init.body.tools.some(t=>t.function.name==='read_file'));
    response(e,'已按已有方案继续处理。');
  },{history,conversationMemory:relay.conversationMemory(history,()=>record),config:{...chatConfig,toolsEnabled:true}});
  await work.finished;assert.equal(work.log.done,1);
  assert.equal(work.log.states.at(-1).handoff.mode,'followup');
  assert.equal(chatConfig.toolsEnabled,false);
  assert.equal(history[0].attachments[0].text,'附件约束：仅向已报名用户发布。');
});

test('agent performs same-route compaction, accounts its usage and keeps unfinished milestones from ending a task', async () => {
  const state=longState();state.milestones=[];
  const h=harness(async(init,e)=>{
    if(init.purpose==='compaction') {
      assert.equal(init.body.model,'qa-model');assert.ok(!init.body.tools);
      const data=JSON.parse(init.body.messages[1].content);
      response(e,JSON.stringify({facts:[...(data.previous?.facts??[]),{text:'Recorded source',sources:[data.source.at(-1).id]}],decisions:[],unresolved:[{text:'Continue original task',sources:['goal']}],nextSteps:['Continue']}));
    } else response(e,'Task response');
  },{resume:state});
  await h.finished;
  assert.ok(h.log.requests.some(r=>r.purpose==='compaction'),JSON.stringify({reason:h.log.reason,error:h.log.error}));
  assert.ok(h.log.states.at(-1).compactions.length>=1);
  assert.equal(h.log.states.at(-1).spentTokens,h.log.requests.length*150);
  assert.equal(h.log.done,1);
  const pending=longState();pending.working=[pending.working[0]];pending.steps=[];
  const blocked=harness(async(_,e)=>response(e,'Finished!'),{resume:pending});
  await blocked.finished;assert.equal(blocked.log.done,0);assert.match(blocked.log.reason,/未完成里程碑/);assert.equal(blocked.log.requests.length,3);
});

test('invalid and cancelled summaries leave the previous compaction boundary intact', async () => {
  const state=longState();state.milestones=[];
  const h=harness(async(init,e)=>response(e,init.purpose==='compaction'?'not valid json':'Task response'),{resume:state});
  await h.finished;assert.equal(h.log.states.at(-1).compactions.length,0);
  assert.deepEqual(h.log.states.at(-1).working.map(m=>[m.id,m.content,m.toolCalls,m.toolCallId,m.attachments]),state.working.map(m=>[m.id,m.content,m.toolCalls,m.toolCallId,m.attachments]));
  let started,release;const reached=new Promise(r=>started=r);
  const cancelled=harness(async(init,e)=>{if(init.purpose==='compaction'){started();await new Promise(r=>release=r);e.onError('cancelled');}else response(e,'done');},{resume:state,abort:()=>release?.()});
  await reached;cancelled.handle.abort();await cancelled.finished;
  assert.equal(cancelled.log.done,0);assert.equal(cancelled.log.states.at(-1).compactions.length,0);assert.equal(cancelled.log.states.at(-1).status,'paused');
});

test('resuming with another model recalculates its window and retains milestones and completed tool cursor', async () => {
  const state=longState();state.working=[state.working[0]];state.milestones=[];state.pendingCalls=[];state.toolCursor=1;
  let calls=0;
  const h=harness(async(init,e)=>{calls++;assert.equal(init.body.model,'small-model');response(e,'done');},{resume:state,
    config:{...cfg(),model:'small-model',effortLevel:'low',runtime:{contextMode:'auto',maxMinutes:1,maxTokens:300000}},modelInfo:{id:'small-model',contextWindow:32768}});
  await h.finished;assert.equal(calls,1);assert.equal(h.log.states.at(-1).contextSnapshot.contextWindow,32768);assert.equal(h.log.states.at(-1).steps.length,state.steps.length);
});

test('large attachments are externalized only when retrieval is available and their middle remains accessible', async () => {
  const original='start '+ 'x'.repeat(50000)+' EXACT_MIDDLE '+ 'y'.repeat(50000);
  const history=[{id:'attachment-question',role:'user',content:'Inspect the attached document',createdAt:1,attachments:[{kind:'text',name:'large.txt',text:original}]}];
  const context=load(file('src/lib/task-context.ts'));
  assert.ok(limits.estimateChatTokens(context.contextView(history,[],6000,false))>6000);
  const view=context.contextView(history,[],6000,true);
  assert.ok(limits.estimateChatTokens(view)<6000);assert.equal(history[0].attachments[0].text,original);
  let requests=0;
  const h=harness(async(init,e)=>{
    if(requests++===0) {assert.match(JSON.stringify(init.body),/read_context/);response(e,'',[{id:'read-middle',name:'read_context',arguments:JSON.stringify({id:'attachment-question',offset:49500,limit:2000})}]);}
    else {assert.match(JSON.stringify(init.body.messages.at(-1)),/EXACT_MIDDLE/);response(e,'The original passage was retrieved');}
  },{history});
  await h.finished;assert.equal(h.log.done,1);assert.equal(h.log.states.at(-1).working[0].attachments[0].text,original);
});

test('quote-only scope also constrains raw-history retrieval, not just the initial request', async () => {
  let requests=0;
  const history=[{id:'excluded',role:'assistant',content:'UNSELECTED_SECRET_SOURCE',createdAt:1},{id:'scoped',role:'user',content:'Explain selected text',quoteOnly:true,quotes:[{text:'Selected text',role:'assistant',messageId:'excluded'}],createdAt:2}];
  const h=harness(async(init,e)=>{
    assert.doesNotMatch(JSON.stringify(init.body),/UNSELECTED_SECRET_SOURCE/);
    if(requests++===0) response(e,'',[{id:'lookup',name:'read_context',arguments:'{"id":"excluded"}'}]);
    else {assert.match(JSON.stringify(init.body.messages.at(-1)),/找不到消息/);response(e,'Explained selected text');}
  },{history});
  await h.finished;assert.equal(h.log.done,1);assert.equal(h.log.states.at(-1).working[0].id,'scoped');
});

test('quota waits beyond the recovery budget pause before dispatch without pretending output was generated', async () => {
  const h=harness(async(_,e)=>{e.onPaceWait(20*60000);e.onError('aborted');});
  await h.finished;assert.equal(h.log.done,0);assert.match(h.log.reason,/自动等待上限/);assert.equal(h.log.states.at(-1).spentTokens,0);
});

test('model relay sends original goal and sourced summary despite legacy history limit, then retrieves original evidence',async()=>{
  const state=longState();state.working=state.working.slice(0,7).map(m=>({...m,content:m.content.slice(0,300)}));state.steps=state.steps.slice(0,3);state.milestones=[];state.lastModel='model-a';
  state.compactions=[memory.validateCompaction(JSON.stringify({facts:[{text:'SUMMARY_FROM_A',sources:['t0']}],decisions:[],unresolved:[],nextSteps:['Check source t0']}),state,4)];
  let requests=0;
  const h=harness(async(init,e)=>{e.onDispatch?.();const wire=JSON.stringify(init.body);assert.equal(init.body.model,'model-b');
    assert.match(wire,/America\/Vancouver/);assert.match(wire,/SUMMARY_FROM_A/);
    if(requests++===0)response(e,'',[{id:'source-read',name:'read_context',arguments:'{"id":"t0"}'}]);
    else {assert.match(wire,/RAW_EVIDENCE_0/);response(e,'Checked original evidence');}
  },{resume:state,config:{...cfg(),model:'model-b',historyLimit:1,enabledTools:['read_file'],runtime:{contextMode:'auto',maxMinutes:1,maxTokens:300000}},modelInfo:{id:'model-b',contextWindow:32768}});
  await h.finished;assert.equal(h.log.done,1);assert.equal(requests,2);
  const final=h.log.states.at(-1);assert.equal(final.handoff.fromModel,'model-a');assert.equal(final.handoff.status,'sent');assert.equal(final.contextSnapshot.contextWindow,32768);assert.equal(final.steps.length,4);
});

test('ordinary follow-up carries completed work and corrections across models without recounting prior tools',async()=>{
  const relay=load(file('src/lib/handoff.ts')),state=longState();state.working=state.working.slice(0,3);state.steps=state.steps.slice(0,1);state.milestones=[];state.requirementSourceIds=['goal','correction'];state.status='completed';state.reasoning='PRIVATE_HIDDEN_THOUGHT';
  const correction={id:'correction',content:'更正：日期必须为 2026-10-02',createdAt:2};state.working.push({...correction,role:'user'});
  state.compactions=[memory.validateCompaction(JSON.stringify({facts:[{text:'SUMMARY_FROM_A',sources:['t0']}],decisions:[],unresolved:[],nextSteps:[]}),state,2)];
  const answer={id:'answer-a',role:'assistant',content:'Saved prior result',createdAt:3,taskId:'task-a',supplementalInputs:[correction]};
  const history=[state.working[0],answer,{id:'next',role:'user',content:'继续核查上一阶段结果',createdAt:4}];
  const record={id:'task-a',answerId:'answer-a',question:history[0],config:{model:'model-a'},state};
  const portable=relay.conversationMemory(history,()=>record);assert.equal(portable.checkpoints,1);assert.doesNotMatch(JSON.stringify(portable),/PRIVATE_HIDDEN_THOUGHT/);
  let requests=0;const h=harness(async(init,e)=>{const wire=JSON.stringify(init.body);e.onDispatch?.();
    assert.match(wire,/SUMMARY_FROM_A/);assert.match(wire,/2026-10-02/);assert.doesNotMatch(wire,/PRIVATE_HIDDEN_THOUGHT/);
    if(requests++===0){assert.doesNotMatch(wire,/RAW_EVIDENCE_0/);response(e,'',[{id:'retrieve-old',name:'read_context',arguments:'{"id":"t0","limit":1000}'}]);}
    else {assert.match(wire,/RAW_EVIDENCE_0/);response(e,'Verified using saved record');}
  },{history,conversationMemory:portable,config:{...cfg(),model:'model-b',historyLimit:1,enabledTools:['read_file']}});
  await h.finished;assert.equal(h.log.done,1);const final=h.log.states.at(-1);assert.equal(final.steps.length,1);assert.equal(final.contextArchiveSteps.length,1);assert.equal(final.handoff.mode,'followup');
  const restored=JSON.parse(JSON.stringify(final));assert.match(memory.readContext(restored,{id:'t0'}).content,/RAW_EVIDENCE_0/);
  const scoped=relay.conversationMemory([...history,{id:'quoted',role:'user',quoteOnly:true,content:'仅讨论选中内容',createdAt:5}],()=>record);
  assert.equal(scoped.archive.length,0);assert.equal(scoped.checkpoints,0);
  assert.equal(relay.conversationMemory(history.slice(1),()=>record).archive.length,0);
  assert.equal(relay.conversationMemory([{...history[0],content:'Edited goal'},...history.slice(1)],()=>record).archive.length,0);
});

test('repeated identical retrieval stops without spending the entire round budget and can resume with another model',async()=>{
  let requests=0;
  const h=harness(async(_,e)=>response(e,'',[{id:`loop-${++requests}`,name:'read_context',arguments:'{"id":"goal"}'}]));
  await h.finished;assert.equal(h.log.done,0);assert.equal(requests,4);assert.match(h.log.reason,/连续三次/);assert.equal(h.log.states.at(-1).steps.filter(s=>s.status==='ok').length,3);
  const resumed=harness(async(_,e)=>response(e,'Use saved evidence and finish'),{requestId:'different-attempt',resume:h.log.states.at(-1),config:{...cfg(),model:'model-b',enabledTools:['read_file']}});
  await resumed.finished;assert.equal(resumed.log.done,1);assert.equal(resumed.log.requests.length,1);assert.equal(resumed.log.states.at(-1).steps.length,4);
});

test('without retrieval, reduction retains full evidence instead of leaving unusable references',()=>{
  const context=load(file('src/lib/task-context.ts')),state=longState();
  const view=context.contextView(state.working,state.steps,1000,false);
  assert.equal(JSON.stringify(view),JSON.stringify(state.working));
});
