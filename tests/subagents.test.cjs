'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {loader}=require('./load-ts.cjs');
const file=p=>path.resolve(__dirname,'..',p);
const {createSubagentRuntime}=loader()(file('src/lib/subagent-runtime.ts'));
const schema=loader()(file('src/lib/paramSchema.ts'));

const workers=[
  {id:'sol',profileId:'profile-sol',model:'gpt-5.6-sol',label:'Sol'},
  {id:'luna',profileId:'profile-luna',model:'gpt-5.6-luna',label:'Luna'},
];

function fixture(options={}){
  const launches=[],saves=[];let usageEvents=0;
  const state={spentTokens:options.spentTokens||0,usage:{},requestStats:[],subagents:structuredClone(options.jobs||[])};
  const config={model:'parent',toolsEnabled:true,enabledTools:['read_file','write_file','spawn_subagent','wait_subagents'],maxToolRounds:30,
    params:{max_tokens:{enabled:true,value:4096},max_completion_tokens:{enabled:false,value:4096}},runtime:{maxTokens:options.maxTokens||0},
    subagents:{enabled:true,workers:structuredClone(workers),maxCalls:options.maxCalls||4,allowEdits:options.allowEdits||false},
    customBody:'parent-private-body',systemPrompt:'parent-private-system',historyLimit:99,client:{kind:'codex'}};
  const args={requestId:'parent-run',config,profile:{id:'parent-profile'},apiKey:'parent-secret',history:[],
    resolveWorker:options.resolveWorker|| (async id=>({profile:{id},apiKey:'child-secret',models:[{id:workers.find(w=>w.profileId===id)?.model}]})),
    events:{onUsage(){usageEvents++;}},toolCtx:()=>({}),effortMappings:[],extraSystem:'parent-extra',timeoutMs:1000,canRunHostTools:true,autoRetry:0};
  const run=childArgs=>{
    const launch={args:childArgs,aborted:false};launches.push(launch);
    launch.handle={abort(){launch.aborted=true;options.onAbort?.(launch);}};
    options.onRun?.(launch);
    return launch.handle;
  };
  const save=async()=>{saves.push(structuredClone(state));};
  const runtime=createSubagentRuntime(args,state,save,run);
  return {runtime,state,launches,saves,args,get usageEvents(){return usageEvents;}};
}

async function turn(){await new Promise(resolve=>setImmediate(resolve));}
async function spawn(f,key,task=key,worker_id='sol'){
  const result=await f.runtime.tool('spawn_subagent',{worker_id,request_key:key,task});await turn();return result;
}
function childState(tokens=123){return {status:'completed',spentTokens:tokens,usage:{prompt_tokens:80,completion_tokens:20,total_tokens:100},requestStats:[{route:'child',purpose:'agent',estimatedInput:80,reservedOutput:20,at:1,outcome:'accepted'}],steps:[],working:[],content:'child evidence'};}

test('limits live children to two and deduplicates a stable request key',async()=>{
  const f=fixture();
  assert.equal((await spawn(f,'a','task a')).ok,true);
  assert.equal((await spawn(f,'b','task b','luna')).ok,true);
  const duplicate=await spawn(f,'a','task a');
  assert.equal(duplicate.ok,true);assert.match(duplicate.summary,/未重复/);assert.equal(f.launches.length,2);
  const conflict=await spawn(f,'a','changed task');assert.equal(conflict.ok,false);assert.match(conflict.error,/不同任务/);
  const third=await spawn(f,'c','task c');assert.equal(third.ok,false);assert.match(third.error,/两个子代理/);
});

test('scopes child configuration, disables nesting, and filters dangerous tools in read-only mode',async()=>{
  const f=fixture();await spawn(f,'scope','inspect only');
  const child=f.launches[0].args;
  assert.equal(child.requestId.startsWith('parent-run-sub-'),true);
  assert.equal(child.config.model,'gpt-5.6-sol');assert.equal(child.config.subagents,undefined);assert.equal(child.resolveWorker,undefined);
  assert.equal(child.config.customBody,'');assert.equal(child.config.systemPrompt,'');assert.equal(child.config.client,undefined);assert.equal(child.config.historyLimit,0);
  assert.deepEqual(child.config.enabledTools,['read_file']);assert.doesNotMatch(child.extraSystem,/parent-extra|parent-private/);
  assert.match(child.extraSystem,/不能修改文件/);assert.deepEqual(child.history.map(m=>m.content),['inspect only']);
});

test('unknown profile fails without calling a model and refunds its token reservation',async()=>{
  const f=fixture({spentTokens:50,resolveWorker:async()=>{throw Error('unknown profile');}});
  await spawn(f,'missing','bounded task');await turn();
  assert.equal(f.launches.length,0);assert.equal(f.state.subagents[0].status,'failed');assert.equal(f.state.subagents[0].tokens,0);
  assert.equal(f.state.spentTokens,50);assert.match(f.state.subagents[0].error,/unknown profile/);
});

test('cancel before dispatch refunds reservation, and a resumed uncertain job is never resent',async()=>{
  let resolveProfile;const gate=new Promise(resolve=>{resolveProfile=resolve;});
  const first=fixture({spentTokens:70,resolveWorker:()=>gate});
  await first.runtime.tool('spawn_subagent',{worker_id:'sol',request_key:'stable',task:'one task'});
  assert.equal(first.state.spentTokens,24070);first.runtime.stop();resolveProfile({profile:{id:'profile-sol'},apiKey:'secret'});await turn();await turn();
  assert.equal(first.state.subagents[0].status,'cancelled');assert.equal(first.state.spentTokens,70);assert.equal(first.launches.length,0);

  const resumed=fixture({jobs:[{id:'old',requestKey:'old-key',workerId:'sol',model:'gpt-5.6-sol',task:'old task',status:'running',content:'',startedAt:1,steps:0,tokens:24000}]});
  assert.equal(resumed.state.subagents[0].status,'uncertain');
  const same=await resumed.runtime.tool('spawn_subagent',{worker_id:'sol',request_key:'old-key',task:'old task'});
  assert.equal(same.ok,true);assert.equal(resumed.launches.length,0);assert.match(same.content,/uncertain/);
});

test('settles child usage once even when terminal callbacks repeat',async()=>{
  const f=fixture({onRun:launch=>queueMicrotask(async()=>{
    await launch.args.events.onRunState(childState(123));launch.args.events.onDone();launch.args.events.onDone();launch.args.events.onError('late duplicate');
  })});
  await spawn(f,'usage','measure it');await f.runtime.waitRunning();
  assert.equal(f.state.subagents[0].status,'completed');assert.equal(f.state.spentTokens,123);
  assert.deepEqual(f.state.usage,{prompt_tokens:80,completion_tokens:20,total_tokens:100});
  assert.equal(f.state.requestStats.length,1);assert.match(f.state.requestStats[0].purpose,/^subagent:/);assert.equal(f.usageEvents,1);
});

test('waitRunning blocks parent delivery until the child terminal callback',async()=>{
  let finishChild;const f=fixture({onRun:launch=>{finishChild=async()=>{await launch.args.events.onRunState(childState(9));launch.args.events.onDone();};}});
  await spawn(f,'wait','finish evidence');
  let released=false;const waiting=f.runtime.waitRunning().then(()=>{released=true;});await turn();assert.equal(released,false);
  await finishChild();await waiting;assert.equal(released,true);assert.equal(f.state.subagents[0].status,'completed');
});

test('real parent runAgent holds its final delivery until the child run finishes',async()=>{
  let releaseChild;const childGate=new Promise(resolve=>{releaseChild=resolve;});
  const calls={parent:0,child:0},states=[],parentBodies=[];let parentDone=0,settle;
  const finished=new Promise(resolve=>{settle=resolve;});
  const reply=(events,text,toolCalls=[])=>{
    events.onResponse?.(200,{});if(text)events.onContent(text);events.onToolCalls(toolCalls);
    events.onStop({reason:toolCalls.length?'tool_calls':'stop',droppedCalls:0});
    events.onUsage({prompt_tokens:10,completion_tokens:5,total_tokens:15});events.onDone();
  };
  const transport={
    chat:async(init,events)=>{
      if(init.requestId.includes('-sub-')){
        calls.child++;await childGate;reply(events,'子任务已核对，结论与局限如下。');return;
      }
      calls.parent++;parentBodies.push(init.body);
      if(calls.parent===1){reply(events,'',[{id:'spawn-1',name:'spawn_subagent',arguments:'{"worker_id":"sol","request_key":"fact-check","task":"请解释这个独立事实并说明局限。"}'}]);return;}
      if(calls.parent===2){reply(events,'主任务答案抢先交付。');return;}
      if(calls.parent===3){reply(events,'',[{id:'wait-1',name:'wait_subagents',arguments:'{}'}]);return;}
      reply(events,'已等待子任务结束并复核其结果，现交付最终答案。');
    },
    callTool:async()=>({ok:true,content:''}),abort:async()=>{},
  };
  let serial=0;const local=loader({[file('src/lib/transport.ts')]:{getTransport:()=>transport},[file('src/lib/store.ts')]:{uid:()=>`s-${++serial}`}});
  const config=schema.defaultGenerationConfig();Object.assign(config,{model:'parent',toolsEnabled:true,enabledTools:['spawn_subagent','list_subagents','wait_subagents'],maxToolRounds:20,
    subagents:{enabled:true,workers:[workers[0]],maxCalls:2,allowEdits:false}});config.runtime={...config.runtime,contextTokens:100000,maxTokens:100000,maxMinutes:1,harness:'guided'};
  local(file('src/lib/agent.ts')).runAgent({requestId:'parent-integrated',profile:{id:'parent',baseUrl:'https://test/v1'},apiKey:'fixture',config,
    history:[{id:'goal',role:'user',content:'请调用子代理核对事实，然后整合结果交付。',createdAt:1}],toolCtx:()=>({workspaceRoots:[]}),effortMappings:[],extraSystem:'',timeoutMs:1000,canRunHostTools:true,autoRetry:0,
    resolveWorker:async()=>({profile:{id:'child',baseUrl:'https://test/v1'},apiKey:'fixture',models:[{id:'gpt-5.6-sol'}]}),confirm:async()=>true,grantAccess:async()=>({ok:true,content:''}),
    events:{onContentDelta(){},onReasoningDelta(){},onSources(){},onUsage(){},onRound(){},onNotice(){},onStopReason(){},onStep(){},onRunState:s=>{if(s)states.push(structuredClone(s));},onDone(){parentDone++;settle();},onPaused(reason){settle(Error(reason));},onError(error){settle(Error(error));}}});
  for(let i=0;i<50&&!(calls.parent>=2&&calls.child>=1);i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(calls.parent,2);assert.equal(calls.child,1);assert.equal(parentDone,0,'parent must not deliver while child is running');
  releaseChild();const outcome=await Promise.race([finished,new Promise(resolve=>setTimeout(()=>resolve(Error('timed out')),1000))]);
  if(outcome instanceof Error)throw outcome;
  assert.equal(parentDone,1);assert.equal(calls.parent,4);assert.match(JSON.stringify(parentBodies[3]),/子任务已核对/);
  assert.equal(states.at(-1).subagents[0].status,'completed');
});
