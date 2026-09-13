const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const {loader}=require('./load-ts.cjs');const file=p=>path.resolve(__dirname,'..',p);const load=loader();
const o=load(file('src/lib/observations.ts')),exportsApi=load(file('src/lib/observation-export.ts')),zip=load(file('src/lib/export-zip.ts'));
const now=Date.now();
const fakeApiKey=['sk','liveabcdefghijklmnop'].join('-');
const record=()=>({id:'internal-run',conversationId:'internal-conv',answerId:'internal-answer',keyProfileId:'private-profile',title:'PRIVATE_TITLE',question:{id:'user',role:'user',content:`PRIVATE_PROMPT ${fakeApiKey}`,createdAt:now},config:{model:'qa-model',effortLevel:'high'},
  state:{runId:'internal-run',working:[],round:1,at:now,startedAt:now,attemptId:'stage-one',attemptStartedAt:now,status:'running',stoppedBy:'unknown',runtimeVersion:'delivery-1',content:'PRIVATE_ANSWER',reasoning:'PRIVATE_REASONING',
    requestStats:[{route:'https://secret.test/?api_key=SECRET',effort:'high',purpose:'agent',estimatedInput:100,reservedOutput:4000,at:now,outcome:'pending'}],steps:[],requirements:[],compactions:[]}});

test('projection is idempotent and preserves unknown usage instead of manufacturing success',()=>{
  const r=record();let t=o.projectObservation(undefined,r,'route-alias');const count=t.events.length;
  t=o.projectObservation(t,r,'route-alias');assert.equal(t.events.length,count);assert.equal(t.requests.missingInput,1);assert.equal(t.requests.actualInput,0);assert.equal(t.acceptance.total,0);assert.equal(t.feedback,undefined);
  r.state.status='completed';r.state.at+=1000;let done=o.projectObservation(t,r,'route-alias');
  const s=exportsApi.summarizeTasks([done]);assert.equal(s.stateCounts.completed,1);assert.equal(s.accepted,0);assert.equal(s.usable,0);assert.equal(s.feedback,0);
  assert.doesNotMatch(JSON.stringify(done),/PRIVATE_|secret\.test|api_key|SECRET/);
});

test('pause/resume remains one task with distinct stages and timing excludes user absence',()=>{
  const r=record();let t=o.projectObservation(undefined,r,'route-a');
  r.state.at+=2000;r.state.status='waiting';t=o.projectObservation(t,r,'route-a');
  r.state.at+=3000;r.state.status='paused';r.state.reason='额度恢复超过预算';t=o.projectObservation(t,r,'route-a');
  assert.equal(t.pauseCount,1);assert.equal(t.attempts[0].activeMs,2000);assert.equal(t.attempts[0].waitMs,3000);
  const id=t.id;r.state.at+=24*3600000;r.state.attemptStartedAt=r.state.at;r.state.attemptId='stage-two';r.state.status='running';r.config.model='another-model';
  t=o.projectObservation(t,r,'route-b');assert.equal(t.id,id);assert.equal(t.resumeCount,1);assert.equal(t.attempts.length,2);assert.equal(t.attempts[1].activeMs,0);
  assert.equal(exportsApi.filterTasks([t],{model:'qa-model'}).length,1);assert.equal(exportsApi.filterTasks([t],{model:'another-model'}).length,1);
});

test('event retention does not resurrect pruned events or inflate repeated snapshots',()=>{
  const r=record();r.state.steps=Array.from({length:260},(_,i)=>({id:'s'+i,callId:'c'+i,name:'read_file',status:'ok',startedAt:now+i,output:'PRIVATE_TOOL_OUTPUT',args:{path:'C:/private/path'}}));
  let t=o.projectObservation(undefined,r,'route');assert.equal(t.events.length,200);assert.ok(t.droppedEvents>0);const dropped=t.droppedEvents,seq=t.nextSeq;
  for(let i=0;i<3;i++)t=o.projectObservation(t,r,'route');assert.equal(t.events.length,200);assert.equal(t.droppedEvents,dropped);assert.equal(t.nextSeq,seq);assert.equal(t.tools.total,260);
});

test('analysis exports whitelist data, keep source distinctions, and preserve stable identifiers',()=>{
  const r=record();const t=o.projectObservation(undefined,r,'route-alias');const store=o.emptyObservations();store.tasks=[t];
  const files=exportsApi.buildAnalysisFiles(store,[t],{},false,now),joined=JSON.stringify(files);
  assert.doesNotMatch(joined,/PRIVATE_|internal-run|internal-conv|private-profile|secret\.test|api_key|SECRET/);
  assert.match(files['report.md'],/未反馈不计成功或失败/);assert.match(files['report.md'],/预留不是实际消耗/);
  assert.equal(JSON.parse(files['tasks.jsonl']).id,t.id);assert.equal(JSON.parse(files['tasks.jsonl']).requests.missingOutput,1);
  const other=exportsApi.buildAnalysisFiles(store,[t],{model:'qa-model'},true,now+1);assert.doesNotMatch(JSON.stringify(other),/qa-model/);
  assert.equal(JSON.parse(other['manifest.json']).exportEpoch,store.epoch);
});

test('selected diagnostic redaction removes common credentials and private keys',()=>{
  const text='Bearer SECRET_AUTH api_key="SECRET_API" password=PASS sk-abcdefghijklmnop ghp_abcdefghijklmnop '+['-----BEGIN','PRIVATE KEY-----'].join(' ')+'\nKEYDATA\n-----END PRIVATE KEY-----';
  assert.doesNotMatch(exportsApi.redactSelectedText(text),/SECRET_AUTH|SECRET_API|PASS|abcdefghijklmnop|KEYDATA/);
});

test('local persistence survives reload, feedback changes separately, interruption remains unknown, deletion and clear do not resurrect tasks',async()=>{
  const kv=new Map();const transport={kvGet:async k=>kv.get(k)??null,kvSet:async(k,v)=>kv.set(k,v)};
  const make=()=>loader({[file('src/lib/transport.ts')]:{getTransport:()=>transport}})(file('src/lib/observations.ts'));
  const a=make(),r=record();await a.observeRun(r);await a.observeRun(r);let store=await a.observationSnapshot();assert.equal(store.tasks.length,1);const id=store.tasks[0].id;
  await a.setTaskFeedback(r.id,{outcome:'partial',reason:'omission',at:now});store=await a.observationSnapshot();assert.equal(store.tasks[0].feedback.outcome,'partial');assert.equal(store.tasks[0].status,'running');
  const b=make();await b.reconcileObservations([r]);store=await b.observationSnapshot();assert.equal(store.tasks[0].id,id);assert.equal(store.tasks[0].status,'interrupted');
  await b.removeObservations(r.conversationId,new Set([r.answerId]));assert.equal((await b.observationSnapshot()).tasks.length,0);
  await b.observeRun(r);await b.clearObservations();const epoch=(await b.observationSnapshot()).epoch;await b.observeRun(r);assert.equal((await b.observationSnapshot()).tasks.length,0);assert.notEqual(epoch,store.epoch);
});

test('retention discloses trimmed task counts and storage failures never reject task saves',async()=>{
  const store=o.emptyObservations(),r=record(),t=o.projectObservation(undefined,r,'route');store.tasks=Array.from({length:510},(_,i)=>({...t,id:'t'+i,lastAt:now+i}));o.pruneObservations(store,now+1000);assert.equal(store.tasks.length,500);assert.equal(store.droppedTasks,10);
  store.tasks[0].lastAt=now-91*86400000;o.pruneObservations(store,now);assert.equal(store.droppedTasks,11);
  const a=loader({[file('src/lib/transport.ts')]:{getTransport:()=>({kvGet:async()=>null,kvSet:async()=>{throw new Error('disk full');}})}})(file('src/lib/observations.ts'));
  await assert.doesNotReject(()=>a.observeRun(r));const broken=await a.observationSnapshot();assert.equal(broken.writeFailures,1);assert.match(broken.lastError,/未能保存/);
});

test('ZIP export preserves UTF-8 text, writes readable directory records and rejects unsafe names',()=>{
  const files={'report.md':'中文任务报告\nunknown ≠ failed','tasks.jsonl':'{"missing":null}'};const bytes=Buffer.from(zip.zipTextFiles(files));let offset=0,count=0;
  while(bytes.readUInt32LE(offset)===0x04034b50){const size=bytes.readUInt32LE(offset+18),len=bytes.readUInt16LE(offset+26);const name=bytes.subarray(offset+30,offset+30+len).toString();const text=bytes.subarray(offset+30+len,offset+30+len+size).toString();assert.equal(text,files[name]);offset+=30+len+size;count++;}
  assert.equal(count,2);assert.equal(bytes.readUInt32LE(offset),0x02014b50);assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);assert.equal(bytes.readUInt16LE(bytes.length-14),2);
  assert.throws(()=>zip.zipTextFiles({'../private.txt':'no'}),/文件名/);
});

test('human approval wait is separate from execution and quota wait, observed context is retained',()=>{
  const r=record();r.state.contextSnapshot={contextWindow:262144,workingBudget:96000};let t=o.projectObservation(undefined,r,'route');
  r.state.at+=100;r.state.status='waiting';r.state.waitKind='approval';t=o.projectObservation(t,r,'route');assert.equal(t.status,'awaiting_user');
  r.state.at+=5000;r.state.status='running';r.state.waitKind=undefined;t=o.projectObservation(t,r,'route');
  assert.equal(t.attempts[0].humanWaitMs,5000);assert.equal(t.attempts[0].waitMs,0);assert.equal(t.attempts[0].activeMs,100);assert.equal(t.attempts[0].contextWindow,262144);
});

test('runtime version in observations matches the packaged application version',()=>{
  const v=load(file('src/lib/version.ts')).APP_VERSION;assert.equal(v,require('../package.json').version);
});

test('feedback is tied to the reviewed execution stage, not automatically applied after a repair',()=>{
  const r=record();r.state.status='paused';let t=o.projectObservation(undefined,r,'route');t.feedback={outcome:'unresolved',at:now,attemptId:t.attempts[0].id};
  assert.equal(exportsApi.summarizeTasks([t]).unresolved,1);
  r.state.at+=1000;r.state.status='running';r.state.attemptId='repaired-stage';r.state.attemptStartedAt=r.state.at;t=o.projectObservation(t,r,'route');
  const summary=exportsApi.summarizeTasks([t]);assert.equal(summary.feedback,0);assert.equal(summary.historicalFeedback,1);assert.equal(t.feedback.outcome,'unresolved');
});
