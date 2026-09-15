const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {loader}=require('./load-ts.cjs');const file=p=>path.join(__dirname,'..',p);
test('chat storage omits only checkpoints already durably journaled and restores their full state',async()=>{
  const state={runId:'run',working:[{id:'goal',role:'user',content:'original source '.repeat(30000),createdAt:1}],status:'paused',reason:'waiting',round:1,at:20,stoppedBy:'user',content:'saved progress',steps:[]};
  const record={id:'run',conversationId:'conv',answerId:'answer',question:state.working[0],state,config:{model:'test'},title:'saved',keyProfileId:'key'};
  const load=loader({[file('src/lib/transport.ts')]:{desktop:()=>({runList:async()=>[record]}),getTransport:()=>({kvGet:async()=>null,kvSet:async()=>{}})},
    [file('src/lib/observations.ts')]:{reconcileObservations:async()=>{},observeRun:async()=>{}}});
  const runs=load(file('src/lib/runs.ts'));await runs.loadRuns();
  const original=[{id:'conv',messages:[{id:'answer',role:'assistant',content:'saved progress',createdAt:1,runState:state}],config:{model:'test'},updatedAt:1}];
  const slim=runs.conversationsForStorage(original);
  assert.equal(slim[0].messages[0].runState,undefined);assert.ok(JSON.stringify(slim).length<JSON.stringify(original).length/100);
  assert.equal(original[0].messages[0].runState,state);
  const restored=runs.recoverConversations(slim,[record]);assert.equal(restored[0].messages[0].runState.working[0].content,state.working[0].content);
  const newer=[{...original[0],messages:[{...original[0].messages[0],runState:{...state,at:21}}]}];
  assert.ok(runs.conversationsForStorage(newer)[0].messages[0].runState);
  const unknown=[{...original[0],id:'different'}];assert.ok(runs.conversationsForStorage(unknown)[0].messages[0].runState);
});
