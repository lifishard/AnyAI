const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loader } = require('./load-ts.cjs');
const root = path.resolve(__dirname, '..');
const file = (p) => path.join(root, p);
const load = loader();
const pacer = load(file('src/lib/pacer.ts'));

test('cancelled queued request never dispatches or lets later requests overtake', async () => {
  let release; const order = [];
  const active = pacer.paced('queue-test', async () => { order.push('first'); await new Promise((r) => release=r); });
  await new Promise(setImmediate);
  const abort = new AbortController();
  const queued = pacer.paced('queue-test', async () => order.push('cancelled'), { signal: abort.signal });
  const later = pacer.paced('queue-test', async () => order.push('last'));
  abort.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  assert.deepEqual(order, ['first']);
  release(); await Promise.all([active, later]);
  assert.deepEqual(order, ['first', 'last']);
});
test('usage replaces reservation and an oversized request fails immediately', () => {
  pacer.reserveTokens('ledger', 'one', 1000);
  pacer.reconcileTokens('ledger', 'one', 1200);
  pacer.reconcileTokens('ledger', 'one', 1200);
  assert.equal(pacer.tokensInWindow('ledger'), 1200);
  assert.ok(pacer.waitForTokens('ledger', 1000, 2000) > 59000);
  assert.throws(() => pacer.waitForTokens('ledger', 3000, 2000), /等待不能解决/);
  const before=Date.now(); pacer.noteRateLimit('deadline', 90000);
  assert.ok(pacer.paceOf('deadline').blockedUntil >= before+90000);
});
test('rate reports do not become context limits or learn error codes as quota', () => {
  const limits=load(file('src/lib/limits.ts'));
  assert.equal(limits.looksLikeOverflow('inference exceeds tpm/rpm limit'), false);
  assert.deepEqual(limits.parseRateLimits('tpm/rpm limit (code 400001)'), {});
  assert.deepEqual(limits.parseRateLimits('TPM limit: 20,000; RPM: 30'), {tpm:20000, rpm:30});
  assert.ok(load(file('src/lib/errors.ts')).backoffMs(1, {retryAfterMs:90000}) >= 90000);
});
test('SSE handles CRLF split across chunks and records HTTP-200 error packets', () => {
  const sse=load(file('src/lib/sse.ts')); const values=[];
  const p=sse.createSseParser((s)=>values.push(s));
  for(const c of 'data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n') p.feed(c);
  assert.deepEqual(values, ['{"a":1}', '[DONE]']);
  let error=''; const consumer=sse.createStreamConsumer({onContent(){},onReasoning(){},onToolCallDelta(){},onUsage(){},onError:s=>error=s});
  consumer.chunk('data: {"error":{"message":"tpm exhausted"}}\n\n');
  assert.match(error,/tpm exhausted/);
});
test('request evidence stays attached to the failing attempt after a final/probe', () => {
  const w=load(file('src/lib/wiretap.ts'));
  w.beginExchange({requestId:'failed',runId:'r',url:'local',body:{messages:['original']},stream:true});
  w.recordRaw('original error', 'failed'); w.endExchange('failed','bad request',400);
  w.beginExchange({requestId:'summary',runId:'r',purpose:'final',url:'local',body:{messages:['wrapup']},stream:true});
  w.recordRaw('summary', 'summary');
  assert.equal(w.failedExchange('r').requestId,'failed');
  assert.match(w.formatExchange(w.exchangeOf('failed')), /original error/);
  assert.equal(w.exchangeOf('failed').raw,'original error');
});
test('JSON object errors are inspectable, arrays support fields and paging', () => {
  const {projectJson}=require('../electron/tools/json-page.cjs');
  assert.equal(projectJson({errors:['unauthorized']},{}).isArray,false);
  const r=projectJson({data:[{id:1,details:{due:'tomorrow'}},{id:2}]},{items_path:'data',fields:['id','details.due'],limit:1});
  assert.deepEqual(r.items,[{id:1,'details.due':'tomorrow'}]); assert.equal(r.nextOffset,1);
});
test('durable checkpoints, backup recovery, tombstones and complete evidence paging', (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anyai-test-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {createRunStore}=require('../electron/run-store.cjs'); let store=createRunStore(dir);
  const record={id:'run',conversationId:'conv',answerId:'a',state:{working:[],toolCursor:1}};
  store.save(record); store.save({...record,state:{working:[],toolCursor:2}});
  store=createRunStore(dir); assert.equal(store.list()[0].state.toolCursor,2);
  const p=path.join(dir,'runs',fs.readdirSync(path.join(dir,'runs')).find(f=>f.endsWith('.json')));
  fs.writeFileSync(p,'corrupt'); assert.equal(store.list()[0].state.toolCursor,1);
  const raw='evidence'.repeat(9000); const id=store.saveResult('run','call',raw);
  let text='',offset=0; do { const part=store.readResult(id,offset,16000); text+=part.text; offset=part.nextOffset; } while(offset!==null);
  assert.equal(text,raw);
  store.remove('run'); store.save(record); assert.equal(store.list().length,0);
});
test('file cards require actual files in allowed roots; ICS and input metadata preserved', (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anyai-files-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const p=path.join(dir,'课程 日历.ics'); fs.writeFileSync(p,'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n');
  const {verifyFiles}=require('../electron/file-records.cjs');
  const r=verifyFiles([p,path.join(dir,'missing.ics')],[dir]);
  assert.equal(r.files.length,1); assert.equal(r.errors.length,1); assert.equal(r.files[0].direction,'output');
  assert.equal(verifyFiles([p],[dir],'input').files[0].direction,'input');
  assert.equal(verifyFiles([p],[path.join(dir,'different')]).files.length,0);
  const a=load(file('src/lib/artifacts.ts'));
  assert.deepEqual(a.filePathsInText('已保存：`C:\\Users\\Someone\\OneDrive\\Documents\\课程 日历.ics`'),['C:\\Users\\Someone\\OneDrive\\Documents\\课程 日历.ics']);
  assert.equal(a.collectArtifacts('claimed C:\\missing.ics',[]).length,0);
  assert.equal(a.collectArtifacts('',[{id:'s',files:r.files}])[0].path,r.files[0].path);
});
test('bounded working context preserves goals, source evidence and tool-call pairing', () => {
  const {contextView}=load(file('src/lib/task-context.ts')); const history=[{id:'goal',role:'user',content:'Complete all courses',createdAt:1}]; const steps=[];
  for(let i=0;i<5;i++) {history.push({id:'a'+i,role:'assistant',content:'',toolCalls:[{id:'c'+i,name:'read_file',arguments:'{}'}]}, {id:'t'+i,role:'tool',toolCallId:'c'+i,toolName:'read_file',content:'x'.repeat(20000)});steps.push({callId:'c'+i,status:'ok',summary:'course '+i,resultRef:'raw'+i});}
  const view=contextView(history,steps,900,true);
  assert.equal(history[2].content.length,20000); assert.equal(view[0].content,history[0].content);
  assert.match(JSON.stringify(view),/read_tool_result/);
  for(let i=0;i<view.length;i++) if(view[i].toolCalls) for(const c of view[i].toolCalls) assert.ok(view.slice(i+1).some(m=>m.role==='tool'&&m.toolCallId===c.id));
});

test('vision allowance is independent of Base64 size and retains a nonzero budget', () => {
  const {estimateRequestTokens,IMAGE_TOKEN_ALLOWANCE}=load(file('src/lib/limits.ts'));
  const body=(url)=>({messages:[{role:'user',content:[{type:'text',text:'Read this screenshot'},{type:'image_url',image_url:{url}}]}]});
  const small=body('data:image/png;base64,'+'A'.repeat(100));
  const large=body('data:image/png;base64,'+'A'.repeat(1100000));
  assert.equal(estimateRequestTokens(small),estimateRequestTokens(large));
  assert.ok(estimateRequestTokens(large)>=IMAGE_TOKEN_ALLOWANCE);
  assert.equal(large.messages[0].content[1].image_url.url.length,1100022);
  assert.ok(estimateRequestTokens({messages:[{role:'user',content:'data:image/png;base64,'+'A'.repeat(1100000)}]})>250000);
});
test('image attachment bytes do not force history truncation, but real long text still counts', () => {
  const {contextView}=load(file('src/lib/task-context.ts'));
  const history=[{id:'q',role:'user',content:'Read screenshot',attachments:[{kind:'image',dataUrl:'data:image/png;base64,'+'A'.repeat(1100000)}]},
    {id:'a',role:'assistant',content:'Previous course deadlines. '.repeat(100)},
    {id:'new',role:'user',content:'Please export these deadlines'}];
  const view=contextView(history,[],20000);
  assert.deepEqual(view.map(m=>m.content),history.map(m=>m.content));
  assert.equal(view[0].attachments[0].dataUrl,history[0].attachments[0].dataUrl);
  const {estimateChatTokens}=load(file('src/lib/limits.ts'));
  assert.ok(estimateChatTokens([{id:'text',role:'user',content:'Long input',attachments:[{kind:'text',name:'large.txt',text:'x'.repeat(1100000)}]}])>250000);
});

function agentHarness(chat, tool, extra={}) {
  const eventsLog={states:[],steps:[],done:0}; let resolve;
  const finished=new Promise(r=>resolve=r); let serial=0;
  const transport={chat,callTool:tool|| (async()=>({ok:true,content:'saved'})),abort:async()=>{}};
  const local=loader({[file('src/lib/transport.ts')]:{getTransport:()=>transport},[file('src/lib/store.ts')]:{uid:()=>`id-${++serial}`}});
  const cfg=local(file('src/lib/paramSchema.ts')).defaultGenerationConfig();
  Object.assign(cfg,{model:'mock',toolsEnabled:true,enabledTools:['read_file'],maxToolRounds:5,runtime:{contextTokens:50000,maxMinutes:1,maxTokens:100000}});
  const args={requestId:'run',profile:{id:'test',baseUrl:'http://localhost/v1'},apiKey:'test-only',config:cfg,history:[{id:'question',role:'user',content:'Read both files',createdAt:1}],toolCtx:()=>({workspaceRoots:[]}),effortMappings:[],extraSystem:'',timeoutMs:1000,canRunHostTools:true,autoRetry:0,confirm:async()=>true,grantAccess:async()=>({ok:true,content:''}),...extra,
    events:{onContentDelta(){},onReasoningDelta(){},onSources(){},onUsage(){},onRound(){},onNotice(){},onStopReason(){},onStep:s=>eventsLog.steps.push(s),onRunState:s=>{if(s)eventsLog.states.push(structuredClone(s));},onDone(){eventsLog.done++;resolve();},onPaused(reason){eventsLog.reason=reason;resolve();},onError(message){eventsLog.error=message;resolve();}}};
  const handle=local(file('src/lib/agent.ts')).runAgent(args);
  return {handle,finished,log:eventsLog,local,cfg};
}
const respond=(h,text='done',calls=[])=>{h.onContent(text);h.onToolCalls(calls);h.onStop({reason:calls.length?'tool_calls':'stop',droppedCalls:0});h.onUsage({total_tokens:100});h.onDone();};
test('resume with four large historical images passes the default 24K preflight and preserves images', async () => {
  const history=[];for(let i=0;i<24;i++) {history.push({id:'q'+i,role:'user',content:'Course details '+i,...(i<4?{attachments:[{id:'img'+i,kind:'image',name:'screenshot.png',dataUrl:'data:image/png;base64,'+'A'.repeat(270000)}]}:{})},{id:'a'+i,role:'assistant',content:'Known deadlines '+i});}
  history.push({id:'current',role:'user',content:'Please send the calendar file again'});
  const state={version:2,runId:'large-history',phase:'request',round:1,status:'paused',stoppedBy:'error',at:1,working:history,steps:[],sources:[],content:'',reason:'Previous false token overflow'};
  let requests=0;
  const h=agentHarness(async(init,e)=>{requests++;assert.ok(init.paceTokens<24000);assert.equal(init.body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url').length,4);respond(e);},undefined,{resume:state,history,config:{model:'mock',systemPrompt:'',historyLimit:0,stream:true,params:{},effort:'default',toolsEnabled:true,enabledTools:['read_file'],maxToolRounds:5,runtime:{contextTokens:24000,maxMinutes:1,maxTokens:300000}}});
  await h.finished;assert.equal(requests,1);assert.equal(h.log.done,1);assert.equal(state.working[0].attachments[0].dataUrl.length,270022);
});
test('quote-only requests send selected paragraph and follow-up, excluding full source', () => {
  const local=loader({[file('src/lib/transport.ts')]:{},[file('src/lib/store.ts')]:{uid:()=>''}});
  const cfg=local(file('src/lib/paramSchema.ts')).defaultGenerationConfig();
  const wire=local(file('src/lib/agent.ts')).buildWire([{id:'old',role:'assistant',content:'PRIVATE FULL SOURCE NOT SELECTED'},{id:'new',role:'user',content:'Explain this',quoteOnly:true,quotes:[{text:'Selected paragraph',messageId:'old',role:'assistant'}]}],cfg);
  assert.match(JSON.stringify(wire),/Selected paragraph/); assert.doesNotMatch(JSON.stringify(wire),/PRIVATE FULL SOURCE/);
});
test('final request failure preserves completed tool steps and never calls completion', async () => {
  let n=0;
  const h=agentHarness(async(init,e)=>{if(n++===0)respond(e,'',[{id:'read',name:'read_file',arguments:'{"path":"a"}'}]);else e.onError('invalid final response',400);},undefined,{config:{model:'mock',systemPrompt:'',historyLimit:0,stream:true,params:{},effort:'default',toolsEnabled:true,enabledTools:['read_file'],maxToolRounds:1,runtime:{contextTokens:50000,maxMinutes:1,maxTokens:100000}}});
  await h.finished; const saved=h.log.states.at(-1);
  assert.equal(h.log.done,0);assert.equal(saved.status,'paused');assert.equal(saved.steps[0].status,'ok');assert.equal(saved.phase,'final');assert.ok(saved.failedRequestId);
});
test('pause during tool batch retains cursor; resume continues at that call', async () => {
  let started; const toolStarted=new Promise(r=>started=r);let count=0;
  const h=agentHarness(async(_,e)=>respond(e,'',[{id:'a',name:'read_file',arguments:'{}'},{id:'b',name:'read_file',arguments:'{}'}]),async()=>{if(count++===0)return{ok:true,content:'first saved'};started();return new Promise(()=>{});});
  await toolStarted;h.handle.abort();await h.finished;
  const saved=h.log.states.at(-1);assert.equal(saved.toolCursor,1);assert.equal(saved.steps[0].status,'ok');assert.equal(h.log.done,0);
  let resumedCalls=0;const resumed=agentHarness(async(_,e)=>respond(e),async()=>{resumedCalls++;return{ok:true,content:'second saved'};},{resume:saved});
  await resumed.finished;assert.equal(resumedCalls,1);assert.equal(resumed.log.done,1);assert.equal(resumed.log.states.at(-1).steps.filter(s=>s.status==='ok').length,2);
});
test('restart rebuilds missing conversation from checkpoint with local partial progress', () => {
  const local=loader({[file('src/lib/transport.ts')]:{}}); const {recoverConversations}=local(file('src/lib/runs.ts'));
  const r={id:'r',conversationId:'c',answerId:'a',title:'Recovered',config:{model:'m'},question:{id:'q',role:'user',content:'original goal',createdAt:1},state:{at:2,status:'running',working:[],content:'partial',steps:[{id:'s',status:'ok',summary:'First file saved'}]}};
  const c=recoverConversations([], [r])[0];assert.equal(c.messages[0].content,'original goal');assert.equal(c.messages[1].runState.status,'paused');assert.match(c.messages[1].progress,/First file saved/);
});

test('native journal joins active operations, reuses completed results and blocks uncertain writes after restart', async(t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anyai-journal-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=require('../electron/run-store.cjs').createRunStore(dir);
  let executions=0,release;
  const overrides={ [file('electron/run-store.cjs')]:{runtimeStore:()=>store}, [file('electron/store.cjs')]:{} };
  for(const name of ['web','files','shell','chrome','github','claudecode','knowledge','documents','computer']) overrides[file(`electron/tools/${name}.cjs`)]={};
  overrides[file('electron/tools/shell.cjs')]={runCommand:async()=>{executions++;await new Promise(r=>release=r);return{ok:true,content:'full evidence '.repeat(4000)};}};
  const {runTool}=loader(overrides)(file('electron/tools/index.cjs'));
  const ctx={workspaceRoots:[dir],execution:{runId:'r',callId:'c'}};
  const first=runTool('run_command',{command:'mock'},ctx);
  const second=runTool('run_command',{command:'mock'},{...ctx,execution:{...ctx.execution,retryUncertain:true}});
  assert.equal(executions,1);release();const [a,b]=await Promise.all([first,second]);
  assert.deepEqual(a,b);assert.ok(a.resultRef);assert.equal(store.readResult(a.resultRef).total,56000);
  await runTool('run_command',{command:'mock'},ctx);assert.equal(executions,1);
  const crypto=require('node:crypto');const args={command:'uncertain'};
  store.saveJob('r','pending',{status:'started',fingerprint:crypto.createHash('sha256').update(JSON.stringify({name:'run_command',args})).digest('hex')});
  const restarted=loader(overrides)(file('electron/tools/index.cjs'));
  const result=await restarted.runTool('run_command',args,{...ctx,execution:{runId:'r',callId:'pending'}});
  assert.equal(result.uncertain,true);assert.equal(executions,1);
});
