'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createCollaborationStore}=require('../electron/collaboration-store.cjs');
const fixtureData=require('./team-store-fixtures.cjs');
function fixture(t,withRun=false){const tmpRoot=fs.realpathSync.native(os.tmpdir()),root=fs.mkdtempSync(path.join(tmpRoot,'wickrun-boundary-test-'));t.after(()=>{assert.equal(path.dirname(root),tmpRoot);assert.ok(path.basename(root).startsWith('wickrun-boundary-test-'));fs.rmSync(root,{recursive:true,force:true});});const store=createCollaborationStore(root),p=fixtureData.project(root);store.update(0,p);if(withRun){p.runs.push(fixtureData.run(p));store.update(1,p);}return {root,store};}
function update(store,fn){const data=store.read(),p=data.projects.p;fn(p.runs[0],p);return store.update(data.revision,p);}

test('new run cannot forge roots connections members task or a saved graph version',t=>{
 const {store}=fixture(t);
 const mutations=[r=>r.projectSettings.roots=[path.parse(process.cwd()).root],r=>r.projectSettings.allowedConnections=[],r=>r.members[0].tools=['shell'],r=>r.members[0].connectionId='client:codex',r=>r.version.graph.maxTokens=10000000,r=>r.workflowId='missing',r=>r.taskId='missing',r=>r.goal='Unapproved goal',r=>r.memorySnapshot=[{id:'fake',status:'adopted'}],r=>r.memoryIds=['fake@1']];
 for(const mutate of mutations){const data=store.read(),p=data.projects.p,r=fixtureData.run(p);mutate(r);p.runs.push(r);assert.throws(()=>store.update(data.revision,p),/授权|真实任务/);}
 assert.equal(store.read().projects.p.runs.length,0);
});

test('same-update permission expansion and prepopulated execution evidence are rejected',t=>{
 const {store}=fixture(t);
 let data=store.read(),p=data.projects.p;p.settings.allowedConnections=[];p.runs.push(fixtureData.run(p));assert.throws(()=>store.update(data.revision,p),/已保存/);
 for(const mutate of [r=>r.attempts.push({id:'fake',status:'completed',output:'claimed success'}),r=>r.tokens=1,r=>r.reservations.fake=100,r=>r.visits.node=1,r=>r.queue=['node'],r=>r.events.push({id:'approve',at:1,kind:'approval',approved:true,text:'approved'})]){
  data=store.read();p=data.projects.p;const r=fixtureData.run(p);mutate(r);p.runs.push(r);assert.throws(()=>store.update(data.revision,p),/空执行|创建记录/);
 }
});

test('even a saved workflow cannot exceed project budget or reference an unauthorized member',t=>{
 for(const mutate of [p=>p.workflows[0].versions[0].graph.maxTokens=1001,p=>p.members[0].enabled=false,p=>p.members[0].connectionId='forbidden',p=>p.workflows[0].versions[0].graph.nodes[1].memberId='missing']){
  const {store}=fixture(t); // Save the intentionally bad template in a separate project so version immutability remains intact.
  const data=store.read(),p=fixtureData.project(process.cwd());p.id='bad';mutate(p);store.update(data.revision,p);
  const saved=store.read(),target=saved.projects.bad;target.runs.push(fixtureData.run(target));assert.throws(()=>store.update(saved.revision,target),/预算|授权/);
 }
});

test('empty run and control-node prose cannot satisfy final delivery gate',t=>{
 const {store}=fixture(t,true);store.claim('p','r');update(store,r=>{r.status='waiting_user';r.queue=[];});
 assert.throws(()=>update(store,r=>r.status='completed'),/用户批准/);
 update(store,r=>{r.attempts.push({id:'control',nodeId:'start',status:'completed',output:'Goal text is not work',steps:[]},{id:'end-attempt',nodeId:'end',startedAt:Date.now(),status:'waiting_user',output:'',steps:[]});});
 assert.throws(()=>update(store,fixtureData.approveDelivery),/实际执行步骤/);
});

test('final delivery requires empty queues reservations and explicit current acceptance evidence',t=>{
 const {store}=fixture(t,true);store.claim('p','r');update(store,fixtureData.prepareDelivery);
 for(const mutate of [r=>r.queue=['node'],r=>r.reservations={'a:m':1},r=>r.approvalQueue=[{nodeId:'api:pending',text:'pending'}],r=>r.pendingApproval={nodeId:'api:pending',text:'pending'},r=>r.events.pop(),r=>r.events.at(-1).approved=false,r=>r.attempts.at(-1).outcome='fail']){
  assert.throws(()=>update(store,r=>{fixtureData.approveDelivery(r);mutate(r);}),/不能完成|批准/);
 }
 update(store,fixtureData.approveDelivery);assert.equal(store.read().projects.p.runs[0].status,'completed');
});

test('manufactured completed end cannot skip its waiting-user checkpoint',t=>{
 const {store}=fixture(t,true);store.claim('p','r');update(store,r=>{r.status='waiting_user';r.queue=[];r.attempts.push({id:'work',nodeId:'node',status:'completed',output:'work done',steps:[]});});
 assert.throws(()=>update(store,r=>{r.attempts.push({id:'end-attempt',nodeId:'end',status:'waiting_user',startedAt:Date.now(),steps:[]});fixtureData.approveDelivery(r);}),/本次用户验收/);
});
