'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {loader}=require('./load-ts.cjs');
const file=p=>path.resolve(__dirname,'..',p);
const base=loader(),schema=base(file('src/lib/paramSchema.ts'));
const profile={id:'qa',baseUrl:'https://gateway.test/v1',name:'QA'};

function config(runtime={}){
  const value={...schema.defaultGenerationConfig(),model:'qa-model',toolsEnabled:true,enabledTools:['read_file'],maxToolRounds:30};
  value.runtime={...value.runtime,contextTokens:1000000,maxTokens:0,maxMinutes:1,...runtime};return value;
}
function response(events,text,calls=[]){
  events.onResponse?.(200,{});if(text)events.onContent(text);events.onToolCalls(calls);
  events.onStop({reason:calls.length?'tool_calls':'stop',droppedCalls:0});
  events.onUsage({prompt_tokens:100,completion_tokens:Math.max(1,Math.ceil(text.length/4)),total_tokens:100+Math.max(1,Math.ceil(text.length/4))});events.onDone();
}
function run(chat,extra={}){
  const log={states:[],requests:[],tools:[],done:0,notices:[]};let settle,serial=0;
  const finished=new Promise(resolve=>settle=resolve);
  const transport={chat:async(init,events)=>{log.requests.push(init);await chat(init,events,log.requests.length);},callTool:async(name,args)=>{log.tools.push({name,args});return {ok:true,content:'真实文件内容'};},abort:async()=>{}};
  const local=loader({[file('src/lib/transport.ts')]:{getTransport:()=>transport},[file('src/lib/store.ts')]:{uid:()=>`h-${++serial}`}});
  const cfg=extra.config||config(),history=extra.history||[{id:'goal',role:'user',content:'(a) 修 dueAt 日期 bug → (b) 做真实 UI 端到端测试 → (c) 提交推送，并清理临时文件',createdAt:1}];
  local(file('src/lib/agent.ts')).runAgent({requestId:'harness-run',profile,apiKey:'fixture',config:cfg,history,toolCtx:()=>({workspaceRoots:[]}),effortMappings:[],extraSystem:'',timeoutMs:1000,canRunHostTools:true,autoRetry:0,confirm:async()=>true,grantAccess:async()=>({ok:true,content:''}),
    events:{onContentDelta(){},onReasoningDelta(){},onSources(){},onUsage(){},onRound(){},onNotice(value){if(value)log.notices.push(value);},onStopReason(){},onStep(step){log.tools.push(step);},onRunState:state=>{if(state)log.states.push(structuredClone(state));},onDone(){log.done++;settle();},onPaused(reason){log.reason=reason;settle();},onError(error){log.error=error;settle();}}});
  return {finished,log};
}

test('the screenshot plan-only clean stop continues automatically and then completes with real tool evidence',async()=>{
  const cfg=config();cfg.enabledTools=['edit_file','run_command'];
  const execution=run((init,events,index)=>{
    if(index===1)return response(events,'先核对真实状态，不做假设。');
    if(index===2){assert.match(JSON.stringify(init.body.messages),/执行器完成检查/);return response(events,'',[
      {id:'edit-real',name:'edit_file',arguments:'{"path":"C:/work/source.ts","old_str":"old","new_str":"fixed"}'},
      {id:'test-real',name:'run_command',arguments:'{"command":"npm test"}'},
      {id:'push-real',name:'run_command',arguments:'{"command":"git push origin HEAD"}'},
    ]);}
    return response(events,'已完成修复、运行测试并推送。');
  },{config:cfg});
  await execution.finished;
  assert.equal(execution.log.done,1);assert.equal(execution.log.requests.length,3);
  const saved=execution.log.states.at(-1);assert.equal(saved.status,'completed');assert.equal(saved.harness.completion.status,'checked');
  assert.deepEqual(saved.steps.filter(step=>step.status==='ok').map(step=>step.callId),['edit-real','test-real','push-real']);
});

test('read-only evidence cannot complete a requested edit, test, or push',()=>{
  const harness=base(file('src/lib/harness.ts')),cfg=config();
  const state={harness:{mode:'guided',goal:'修复错误，运行测试并推送到 GitHub',sourceId:'g',action:true,stage:'execute',continuations:0},steps:[{id:'s',callId:'read',name:'read_file',args:{path:'x'},status:'ok',summary:'read',startedAt:1}]};
  assert.match(harness.completionIssue(state,'已经全部完成。',cfg),/只有查阅记录/);
  state.steps.push({id:'e',callId:'edit',name:'edit_file',args:{path:'x'},status:'ok',summary:'edited',startedAt:2});
  assert.match(harness.completionIssue(state,'已经全部完成。',cfg),/测试命令/);
  state.steps.push({id:'t',callId:'test',name:'run_command',args:{command:'npm test'},status:'ok',summary:'tests passed',startedAt:3});
  assert.match(harness.completionIssue(state,'已经全部完成。',cfg),/git push/);
  state.steps.push({id:'p',callId:'push',name:'run_command',args:{command:'git push origin HEAD'},status:'ok',summary:'pushed',startedAt:4});
  assert.equal(harness.completionIssue(state,'已经全部完成。',cfg),undefined);
});

test('an explicit blocker pauses action work but ordinary no-error findings do not',()=>{
  const harness=base(file('src/lib/harness.ts')),cfg=config();
  const state={harness:{mode:'guided',goal:'修复这个问题',sourceId:'g',action:true,stage:'execute',continuations:0},steps:[]};
  assert.match(harness.completionBlocker(state,'当前无法完成修复，缺少用户授权。',cfg),/阻塞/);
  assert.equal(harness.completionBlocker(state,'检查完成，没有发现错误。',cfg),undefined);
  assert.equal(harness.completionBlocker(state,'未完成项：无，测试通过。',cfg),undefined);
});

test('the real agent pauses an explicit blocker immediately without consuming continuation attempts',async()=>{
  const execution=run((_init,events)=>response(events,'当前无法完成修复，缺少用户授权。'));
  await execution.finished;
  assert.equal(execution.log.done,0);assert.equal(execution.log.requests.length,1);assert.match(execution.log.reason,/阻塞|未完成/);
  const saved=execution.log.states.at(-1);assert.equal(saved.status,'paused');assert.equal(saved.harness.continuations,0);
});

test('a verified already-satisfied edit request can complete without manufacturing a write',()=>{
  const harness=base(file('src/lib/harness.ts')),cfg=config();
  const step={id:'s',callId:'read-real',name:'read_file',args:{path:'x'},status:'ok',summary:'inspected',startedAt:1};
  const state={harness:{mode:'guided',goal:'修复已经存在的配置',sourceId:'g',action:true,stage:'verify',continuations:0},steps:[step]};
  const review=harness.recordTaskReview(state,{summary:'现有配置已经正确，无需修改。',checks:'已读取原文件并核对目标值。',evidence:['read-real']});
  assert.equal(review.ok,true);assert.equal(harness.completionIssue(state,'核对后确认现状已经满足要求。',cfg),undefined);
});

test('test evidence recognizes standard runners and requires review for a named QA script',()=>{
  const harness=base(file('src/lib/harness.ts')),cfg=config();
  for(const command of ['node --test tests/unit.test.cjs','python -m pytest','python3 -m unittest','npx playwright test']){
    const step={id:'s',callId:'test',name:'run_command',args:{command},status:'ok',summary:'passed',startedAt:1};
    const state={harness:{mode:'guided',goal:'运行测试',sourceId:'g',action:true,stage:'verify',continuations:0},steps:[step]};
    assert.equal(harness.completionIssue(state,'测试通过。',cfg),undefined,command);
  }
  const script={id:'qa',callId:'qa-run',name:'run_command',args:{command:'node scripts/qa-release.js'},status:'ok',summary:'QA done',startedAt:1};
  const state={harness:{mode:'guided',goal:'运行测试',sourceId:'g',action:true,stage:'verify',continuations:0},steps:[script]};
  assert.match(harness.completionIssue(state,'测试通过。',cfg),/测试命令/);
  state.harness.review={summary:'QA 脚本通过。',checks:'核对了脚本输出。',evidence:['qa-run'],nextAction:'',at:2};
  assert.equal(harness.completionIssue(state,'测试通过。',cfg),undefined);
});

test('explicit Chinese and English negative instructions do not create test or push obligations',()=>{
  const harness=base(file('src/lib/harness.ts')),cfg=config();
  const edit={id:'e',callId:'edit',name:'edit_file',args:{path:'x'},status:'ok',summary:'edited',startedAt:1};
  for(const goal of ['修复问题，不要测试和推送。',"fix the issue; do not test and don't push"]){
    const state={harness:{mode:'guided',goal,sourceId:'g',action:true,stage:'verify',continuations:0},steps:[edit]};
    assert.equal(harness.completionIssue(state,'修复完成。',cfg),undefined,goal);
  }
});

test('two bounded continuations cannot turn repeated plan prose into completion',async()=>{
  const execution=run((_init,events)=>response(events,'我先检查真实状态，然后开始修复。'));
  await execution.finished;
  assert.equal(execution.log.done,0);assert.equal(execution.log.requests.length,3);assert.match(execution.log.reason,/尚未确认任务完成/);
  const saved=execution.log.states.at(-1);assert.equal(saved.status,'paused');assert.equal(saved.harness.continuations,2);assert.equal(saved.steps.length,0);
});

test('an explanatory consultation is answered once without an execution false positive',async()=>{
  const history=[{id:'question',role:'user',content:'请解释如何重构这个模块，以及常见风险。',createdAt:1}];
  const execution=run((_init,events)=>response(events,'我先解释判断思路：先识别边界，再比较改动成本。'),{history});
  await execution.finished;
  assert.equal(execution.log.done,1);assert.equal(execution.log.requests.length,1);assert.equal(execution.log.states.at(-1).harness.action,false);
});

test('turning guidance off removes its prompt and completion tool while the executor still rejects premature completion',async()=>{
  const bodies=[];const execution=run((init,events)=>{bodies.push(init.body);response(events,'我先检查真实状态，然后开始修复。');},{config:config({harness:'off'})});
  await execution.finished;
  assert.equal(execution.log.done,0);assert.equal(execution.log.requests.length,3);assert.match(execution.log.reason,/尚未确认任务完成/);
  for(const body of bodies){assert.doesNotMatch(JSON.stringify(body.messages),/<wickrun_task_guidance>/);assert.ok(!(body.tools||[]).some(tool=>tool.function.name==='complete_task'));}
});

test('layered context folds summarized old user material but protects the active goal and requirement source verbatim',()=>{
  const memory=base(file('src/lib/context-memory.ts')),harness=base(file('src/lib/harness.ts'));
  const working=[
    {id:'old-doc',role:'user',content:'OLD_SOURCE_INDEX '+('old material '.repeat(300))+' OLD_DEEP_EXACT',createdAt:1},
    {id:'a1',role:'assistant',content:'earlier answer',createdAt:2},
    {id:'requirement-source',role:'user',content:'REQUIREMENT_EXACT keep timezone America/Vancouver',createdAt:3},
    {id:'a2',role:'assistant',content:'noted',createdAt:4},
    {id:'active-goal',role:'user',content:'ACTIVE_GOAL_EXACT 修改程序并运行测试',createdAt:5},
    {id:'a3',role:'assistant',content:'working',createdAt:6},
  ];
  const state={working,steps:[],requirements:[{id:'r1',title:'timezone',sourceId:'requirement-source',sourceQuote:'keep timezone',check:{kind:'review'},revision:1,at:1}],milestones:[],compactions:[{id:'compact',throughIndex:4,throughId:'active-goal',createdAt:7,facts:[{text:'old summary',sources:['old-doc']}],decisions:[],unresolved:[],nextSteps:[],beforeTokens:1000,afterTokens:50}],at:8,round:1,stoppedBy:'unknown'};
  state.harness=harness.taskSeed(working,config());
  const compacted=memory.memoryView(state),view=harness.layeredMemoryView(compacted,state,config()),wire=JSON.stringify(view);
  assert.match(wire,/OLD_SOURCE_INDEX/);assert.doesNotMatch(wire,/OLD_DEEP_EXACT/);assert.match(wire,/old-doc/);
  assert.match(wire,/REQUIREMENT_EXACT/);assert.match(wire,/ACTIVE_GOAL_EXACT/);
  assert.equal(state.harness.context.foldedMessages,1);
  assert.match(memory.readContext(state,{id:'old-doc',offset:0,limit:12000}).content,/OLD_DEEP_EXACT/);
});
