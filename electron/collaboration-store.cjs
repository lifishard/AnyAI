'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { createDurableJson } = require('./durable-json.cjs');
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const STATES = new Set(['ready','running','pausing','paused','waiting_user','uncertain','failed','cancelled','completed']);
const ATTEMPTS = { running: ['running','completed','failed','uncertain','waiting_user'], waiting_user: ['waiting_user','completed','failed','uncertain'], uncertain: ['uncertain','completed','failed'], failed: ['failed','completed'], completed: ['completed'] };
function finiteCount(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function validate(data) {
 if(!data||data.schemaVersion!==1||!Number.isInteger(data.revision)||!data.projects||typeof data.projects!=='object'||Array.isArray(data.projects))throw Error('协作数据版本不兼容');
 for(const [id,p] of Object.entries(data.projects)){
  if(p.id!==id)throw Error('项目 ID 不一致');
  for(const key of ['members','workflows','tasks','runs','memories','schedules','files'])if(!Array.isArray(p[key])||new Set(p[key].map(x=>x.id)).size!==p[key].length)throw Error(`项目 ${id} 的 ${key} 格式无效`);
  if(!p.preferences||!p.settings)throw Error('项目设置缺失');
  for(const r of p.runs) {
   if(!STATES.has(r.status)||!Array.isArray(r.attempts)||!Array.isArray(r.events))throw Error('运行状态或执行历史无效');
   if(r.tokens!==undefined&&!finiteCount(r.tokens))throw Error('运行用量无效');
   for(const key of ['visits','traversals','reservations'])if(r[key]!==undefined&&(!r[key]||typeof r[key]!=='object'||Array.isArray(r[key])||Object.values(r[key]).some(x=>!finiteCount(x))))throw Error('运行次数或预留用量无效');
   if(new Set(r.attempts.map(a=>a.id)).size!==r.attempts.length||r.attempts.some(a=>!ATTEMPTS[a.status]))throw Error('步骤记录重复或状态无效');
  }
 }
}
function appendOnly(before=[],after=[],label) {
 if(!Array.isArray(after)||after.length<before.length||before.some((entry,index)=>!equal(entry,after[index])))throw Error(label+'历史不可改写或删除');
}
const WORK_NODES = new Set(['agent','discussion','review','handoff']);
function validateRunGraph(run) {
 const graph=run.version?.graph,settings=run.projectSettings;
 if(!graph||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges)||!Array.isArray(run.members)||!settings||!Array.isArray(settings.roots)||settings.roots.some(root=>typeof root!=='string'||!path.isAbsolute(root))||!Array.isArray(settings.allowedConnections)||!Number.isInteger(settings.maxConcurrent)||settings.maxConcurrent<1||settings.maxConcurrent>100||!['ask','auto','all'].includes(settings.approvalMode))throw Error('运行授权或流程快照无效');
 if(!Number.isInteger(graph.maxSteps)||graph.maxSteps<1||graph.maxSteps>10000||![graph.maxTokens,graph.maxMinutes,settings.maxTokens,settings.maxMinutes].every(n=>Number.isFinite(n)&&n>0)||graph.maxTokens>settings.maxTokens||graph.maxMinutes>settings.maxMinutes)throw Error('运行预算超过项目授权上限');
 const nodes=new Map(graph.nodes.map(n=>[n.id,n])),members=new Map(run.members.map(m=>[m.id,m]));
 if(nodes.size!==graph.nodes.length||members.size!==run.members.length||new Set(graph.edges.map(e=>e.id)).size!==graph.edges.length)throw Error('运行节点、成员或连线编号重复');
 const starts=graph.nodes.filter(n=>n.type==='start'),ends=graph.nodes.filter(n=>n.type==='end');
 if(!starts.length||!ends.length)throw Error('运行需要开始与结束节点');
 for(const edge of graph.edges)if(!nodes.has(edge.from)||!nodes.has(edge.to)||(edge.loop&&(!Number.isInteger(edge.maxTraversals)||edge.maxTraversals<1)))throw Error('运行连线或回路次数无效');
 const reach=(seeds,reverse=false)=>{const seen=new Set(seeds),queue=[...seeds];while(queue.length){const id=queue.shift();for(const e of graph.edges)if((reverse?e.to:e.from)===id){const next=reverse?e.from:e.to;if(!seen.has(next)){seen.add(next);queue.push(next);}}}return seen;};
 const reachable=reach(starts.map(n=>n.id)),exits=reach(ends.map(n=>n.id),true);
 for(const node of graph.nodes){
  if(!['start','agent','discussion','condition','parallel','join','review','approval','handoff','end'].includes(node.type)||typeof node.id!=='string'||!node.id||!Number.isInteger(node.maxVisits)||node.maxVisits<1||!Array.isArray(node.inputRefs)||node.inputRefs.some(id=>!nodes.has(id))||!reachable.has(node.id)||!exits.has(node.id))throw Error('运行节点无法可靠到达、退出或引用输入');
  const edges=graph.edges.filter(e=>e.from===node.id);
  if(node.type==='end'&&edges.length)throw Error('结束节点不能继续派发');
  if(node.type!=='end'&&!edges.length)throw Error('运行节点缺少后继');
  if(['condition','review','approval'].includes(node.type)&&['pass','fail','default'].some(port=>!edges.some(e=>e.port===port)))throw Error('运行分支缺少明确结果去向');
  if(node.type==='condition'&&(!nodes.has(node.condition?.source)||typeof node.condition.contains!=='string'||!node.condition.contains))throw Error('条件规则无效');
  if(node.type==='end'&&(typeof node.outputRequirement!=='string'||!node.outputRequirement.trim()))throw Error('结束节点缺少交付要求');
  if(WORK_NODES.has(node.type)){
   const selected=node.type==='discussion'?node.participants:[node.memberId];
   if(!Array.isArray(selected)||!selected.length||new Set(selected).size!==selected.length||typeof node.instructions!=='string'||!node.instructions.trim())throw Error('执行步骤缺少成员或职责');
   for(const id of selected){const member=members.get(id);if(!member?.enabled||typeof member.connectionId!=='string'||!member.connectionId||typeof member.model!=='string'||!member.model||!Array.isArray(member.tools)||![member.maxTokens,member.maxMinutes].every(n=>Number.isFinite(n)&&n>0)||(settings.allowedConnections.length&&!settings.allowedConnections.includes(member.connectionId)))throw Error('运行成员不在项目授权范围');}
  }
 }
}
function validateNewRun(run,source,project) {
 if(!source)throw Error('请先保存项目配置、任务和流程版本，再创建运行');
 const task=source.tasks.find(t=>t.id===run.taskId),flow=source.workflows.find(f=>f.id===run.workflowId),version=flow?.versions.find(v=>v.id===run.version?.id);
 if(!task||typeof task.goal!=='string'||!task.goal.trim()||typeof task.acceptance!=='string'||!task.acceptance.trim()||!version||flow.archived||!equal(version,run.version))throw Error('运行必须引用已保存的真实任务和流程版本');
 const used=new Set(version.graph.nodes.flatMap(n=>[n.memberId,...(n.participants||[])].filter(Boolean)));
 const members=source.members.filter(m=>used.has(m.id)),memories=source.memories.filter(m=>m.status==='adopted');
 if(!equal(run.projectSettings,source.settings)||!equal(project.settings,source.settings)||!equal(run.members,members)||!equal(run.goal,task.goal)||!equal(run.acceptance,task.acceptance)||!equal(run.memorySnapshot,memories)||!equal(run.memoryIds,memories.map(m=>`${m.id}@${m.revision}`)))throw Error('运行配置快照必须来自已保存的项目授权');
 validateRunGraph(run);
 const emptyMap=value=>value&&typeof value==='object'&&!Array.isArray(value)&&!Object.keys(value).length;
 if(run.status!=='ready'||run.owner!==undefined||run.tokens!==0||run.attempts.length||!emptyMap(run.reservations)||!emptyMap(run.visits)||!emptyMap(run.traversals)||!emptyMap(run.arrivals)||run.pendingApproval||(run.approvalQueue?.length)||!equal(run.queue,version.graph.nodes.filter(n=>n.type==='start').map(n=>n.id)))throw Error('新运行必须从空执行记录和初始队列开始');
 if(!Number.isFinite(run.createdAt)||run.createdAt<=0||run.updatedAt!==run.createdAt||run.events.length!==1||run.events[0].kind!=='created'||typeof run.events[0].id!=='string'||!run.events[0].id||run.events[0].at!==run.createdAt||typeof run.events[0].text!=='string'||!run.events[0].text.trim())throw Error('新运行只能包含真实创建记录');
 if(run.scheduleKey&&source.runs.some(r=>r.scheduleKey===run.scheduleKey))throw Error('此调度触发已经创建运行');
}
function validateCompletion(previous,next) {
 const latest=new Map(next.attempts.map(a=>[a.nodeId||a.id,a]));
 if(next.attempts.some(a=>['running','waiting_user','uncertain'].includes(a.status))||[...latest.values()].some(a=>a.status!=='completed'))throw Error('仍有未核实或失败步骤，不能完成运行');
 if(!Array.isArray(next.queue)||next.queue.length||next.pendingApproval||(next.approvalQueue?.length)||Object.keys(next.reservations||{}).length)throw Error('仍有执行、审批队列或预留用量，不能完成运行');
 const nodes=new Map((next.version?.graph?.nodes||[]).map(n=>[n.id,n])),ends=[...latest.values()].filter(a=>nodes.get(a.nodeId)?.type==='end');
 const approved=(event,attempt)=>event.kind==='approval'&&event.nodeId===attempt.nodeId&&(event.approved===true||(event.approved===undefined&&event.text==='用户确认验收'))&&event.at>=attempt.startedAt;
 if(!ends.length||ends.some(a=>a.outcome!=='pass'||!next.events.some(e=>approved(e,a))))throw Error('交付尚未经过结束节点的用户批准');
 if(previous.status!=='completed'&&!ends.some(a=>previous.attempts.some(before=>before.id===a.id&&before.status==='waiting_user')&&next.events.slice(previous.events.length).some(e=>approved(e,a))))throw Error('完成运行需要本次用户验收批准记录');
 if(![...latest.values()].some(a=>WORK_NODES.has(nodes.get(a.nodeId)?.type)&&a.status==='completed'&&typeof a.output==='string'&&a.output.trim()))throw Error('缺少实际执行步骤的可验收输出');
}
function validateRunUpdate(previous,next) {
 for(const key of ['version','members','config','goal','acceptance','memoryIds','projectSettings','memorySnapshot','createdAt','taskId','workflowId','scheduleKey'])if(!equal(next[key],previous[key]))throw Error('运行配置快照不可改写');
 if((next.tokens??0)<(previous.tokens??0))throw Error('运行用量不可减少');
 for(const key of ['visits','traversals'])for(const [id,count] of Object.entries(previous[key]||{}))if((next[key]?.[id]??0)<count)throw Error('运行执行次数不可减少');
 appendOnly(previous.events,next.events,'运行事件');
 if(next.attempts.length<previous.attempts.length)throw Error('步骤历史不可删除');
 for(let i=0;i<previous.attempts.length;i++) {
  const before=previous.attempts[i],after=next.attempts[i];
  if(after.id!==before.id)throw Error('步骤历史不可删除或重新排序');
  for(const key of ['nodeId','visit','startedAt'])if(!equal(after[key],before[key]))throw Error('步骤身份不可改写');
  if(!ATTEMPTS[before.status].includes(after.status))throw Error('步骤状态不可回退');
  if(before.status==='completed'&&!equal(before,after))throw Error('已完成步骤证据不可改写');
  const beforeSteps=before.steps||[],afterSteps=after.steps||[];
  if(afterSteps.length<beforeSteps.length)throw Error('工具证据不可删除');
  for(let j=0;j<beforeSteps.length;j++) {
   const a=beforeSteps[j],b=afterSteps[j];
   if(a.id!==b.id)throw Error('工具证据不可重新排序');
   if(a.status!=='running'&&!equal(a,b))throw Error('已结束工具证据不可改写');
  }
 }
 if(previous.status!==next.status) {
  const transitions={ready:['paused','cancelled'],running:['paused','pausing','waiting_user','uncertain','failed','cancelled'],pausing:['paused','uncertain','failed','cancelled'],paused:['pausing','uncertain','failed','cancelled','waiting_user'],waiting_user:['paused','uncertain','failed','cancelled','completed'],uncertain:['paused','cancelled'],failed:['paused','cancelled'],completed:[],cancelled:[]};
  if(!transitions[previous.status]?.includes(next.status))throw Error('运行状态不能回退或绕过领取');
  if(['uncertain','failed'].includes(previous.status)&&next.status==='paused'&&!next.events.slice(previous.events.length).some(e=>e.kind==='verified'&&typeof e.text==='string'&&e.text.trim()))throw Error('中断运行必须追加核实证据后才能恢复');
 }
 if(next.status==='completed')validateCompletion(previous,next);
}
function createCollaborationStore(root) {
 const doc=createDurableJson(path.join(root,'collaboration-v1.json'),{initial:()=>({schemaVersion:1,revision:0,updatedAt:Date.now(),projects:{}}),validate});
 const owner=crypto.randomUUID();let recovered=false;
 function read(){
  let d=doc.read();
  if(!recovered){
   let dirty=false;
   for(const p of Object.values(d.projects))for(const r of p.runs){
    if(['running','pausing'].includes(r.status)||r.attempts.some(a=>a.status==='running')||Object.values(r.reservations||{}).some(n=>n>0)){
     if(r.status!=='cancelled')r.status='uncertain';delete r.owner;
     for(const a of r.attempts)if(a.status==='running')a.status='uncertain';
     const reserved=Object.values(r.reservations||{}).reduce((sum,n)=>sum+n,0);
     if(reserved){r.tokens=(r.tokens||0)+reserved;r.events.push({id:crypto.randomUUID(),at:Date.now(),kind:'recovery_budget',text:`中断前预留用量 ${reserved} 暂按已用计入；人工核实和重试不会自动扣回。`});}
     r.reservations={};
     r.events.push({id:crypto.randomUUID(),at:Date.now(),kind:'recovery',text:'上次执行中断，需核实当前步骤；不会自动重试。'});dirty=true;
    }
   }
   if(dirty){d.revision++;d.updatedAt=Date.now();d=doc.write(d);}recovered=true;
  }
  return d;
 }
 function update(revision,project){
  const d=read();if(d.revision!==revision)throw Error('协作记录已有更新，请重新读取后合并修改');
  const old=d.projects[project.id];
  if(old){
   for(const f of old.workflows){const next=project.workflows.find(x=>x.id===f.id);if(f.versions.length&&!next)throw Error('已保存版本的流程只能归档');for(const v of f.versions)if(!equal(next?.versions.find(x=>x.id===v.id),v))throw Error('流程历史版本不可改写');}
   for(const r of old.runs){const next=project.runs.find(x=>x.id===r.id);if(!next)throw Error('运行历史不可删除');validateRunUpdate(r,next);}
   for(const task of old.tasks){const next=project.tasks.find(t=>t.id===task.id);if(!next&&old.runs.some(r=>r.taskId===task.id))throw Error('已有运行的任务不可删除');if(next)appendOnly(task.entries,next.entries,'任务讨论');}
  }
  for(const run of project.runs)if(!old?.runs.some(r=>r.id===run.id))validateNewRun(run,old,project);
  d.projects[project.id]=structuredClone(project);d.revision++;d.updatedAt=Date.now();return doc.write(d);
 }
 function claim(projectId,runId){const d=read(),p=d.projects[projectId],r=p?.runs.find(x=>x.id===runId);if(!r||!['ready','paused'].includes(r.status))throw Error('运行尚未就绪或需要核实');const cap=p.settings.maxConcurrent;if(!Number.isInteger(cap)||cap<1||cap>100)throw Error('项目并行数量设置无效');if(p.runs.filter(x=>['running','pausing','waiting_user'].includes(x.status)).length>=cap)throw Error('项目同时运行数量已达上限');r.owner=owner;r.status='running';r.updatedAt=Date.now();d.revision++;return doc.write(d);}
 return {read,update,claim,file:doc.file};
}
module.exports={createCollaborationStore,validate,validateRunUpdate};
