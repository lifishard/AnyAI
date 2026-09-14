const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {loader}=require('./load-ts.cjs');
const file=p=>path.join(__dirname,'..',p);
function fixture(result,previous=null){
  const calls=[],states=[];let done,apiCalls=0;
  const finished=new Promise(resolve=>done=resolve);
  const bridge={onClientEvent:()=>()=>{},toolAbort:async()=>{},conversationClientRecover:async()=>previous,conversationClientRun:async args=>{calls.push(args);return result;}};
  const local=loader({[file('src/lib/transport.ts')]:{desktop:()=>bridge},[file('src/lib/agent.ts')]:{buildWire:history=>history,runAgent:args=>{apiCalls++;states.push(args.resume);queueMicrotask(()=>done('api'));return {abort(){}};}}});
  const args={requestId:'native-request',config:{client:{kind:'codex',model:'test'},model:'test',toolsEnabled:false},history:[{id:'user-1',role:'user',content:'Keep the original goal',createdAt:1}],toolCtx:()=>({workspaceRoots:[]}),extraSystem:'',confirm:async()=>false,
    events:{onContentDelta(){},onContentReplace(){},onNotice(){},onRunState:s=>{if(s)states.push(structuredClone(s));},onPaused:()=>done('paused'),onDone:()=>done('completed')}};
  return {calls,states,finished,args,run:extra=>local(file('src/lib/connected-agent.ts')).runConnectedAgent({...args,...extra}),apiCalls:()=>apiCalls};
}
const marker='<wickrun_question>'+JSON.stringify({questions:[{id:'choice',question:'Which day?',options:[{label:'Friday'},{label:'Monday'}]}]})+'</wickrun_question>';
test('native question and exact answer survive separate native turns in the portable transcript',async()=>{
  const f=fixture({status:'completed',text:marker});f.run();assert.equal(await f.finished,'paused');const state=f.states.at(-1);
  assert.equal(state.waitKind,'question');assert.equal(state.uncertainCallId,undefined);
  state.userQuestion.answers={choice:{selected:['Friday'],text:'Keep this name'}};
  const resumed=fixture({status:'completed',text:'Done'});resumed.run({resume:state,requestId:'native-next'});assert.equal(await resumed.finished,'completed');
  assert.match(resumed.calls[0].prompt,/Friday/);assert.match(resumed.calls[0].prompt,/Keep this name/);assert.equal(resumed.states.at(-1).userQuestionHistory.length,1);assert.equal(resumed.states.at(-1).supplementalInputs.length,1);
});
test('unfinished native output cannot clear uncertainty by containing a question marker',async()=>{
  const f=fixture({status:'unknown',text:marker});f.run();await f.finished;
  assert.equal(f.states.at(-1).userQuestion,undefined);assert.match(f.states.at(-1).uncertainCallId,/^native-/);
});
test('completed host result recovers after renderer loss with zero new dispatches',async()=>{
  const f=fixture({status:'completed',text:'must not run'},{status:'completed',text:'saved on host'});
  f.run({resume:{working:f.args.history,runId:'prior-run',uncertainCallId:'native-prior-attempt',round:1,at:1,stoppedBy:'unknown'}});
  assert.equal(await f.finished,'completed');assert.equal(f.calls.length,0);assert.equal(f.states.at(-1).content,'saved on host');
});
test('unanswered native question does not submit a new model request on generic resume',async()=>{
  const f=fixture({status:'completed',text:marker});f.run();await f.finished;const state=f.states.at(-1);
  const next=fixture({status:'completed',text:'must not run'});next.run({resume:state});assert.equal(await next.finished,'paused');assert.equal(next.calls.length,0);
});
test('switching from a native question to API carries the submitted answer before calling API runtime',async()=>{
  const f=fixture({status:'completed',text:marker});f.run();await f.finished;const state=f.states.at(-1);state.userQuestion.answers={choice:{selected:['Friday'],text:'Keep this name'}};
  const next=fixture({status:'completed',text:'unused'});next.run({resume:state,config:{model:'api-model',toolsEnabled:false}});assert.equal(await next.finished,'api');assert.equal(next.apiCalls(),1);
  assert.equal(next.states.at(-1).userQuestion,undefined);assert.match(next.states.at(-1).working.at(-1).content,/Friday/);
});
