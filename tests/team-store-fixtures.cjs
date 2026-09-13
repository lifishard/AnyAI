'use strict';
function project(root) {
 const node=(id,type)=>({id,type,title:id,x:0,y:0,maxVisits:10,inputRefs:[],instructions:'Do the work',outputRequirement:'Verified result',join:'all',...(type==='agent'?{memberId:'m'}:{})});
 const graph={nodes:[node('start','start'),node('node','agent'),node('end','end')],edges:[{id:'s-a',from:'start',to:'node',port:'next',maxTraversals:10},{id:'a-e',from:'node',to:'end',port:'next',maxTraversals:10}],maxSteps:50,maxTokens:1000,maxMinutes:30};
 return {id:'p',members:[{id:'m',name:'Member',instructions:'Role',connectionId:'key',model:'fixture',effort:'medium',enabled:true,tools:[],maxTokens:500,maxMinutes:20}],workflows:[{id:'flow',versions:[{id:'v',number:1,createdAt:1,graph}],archived:false}],tasks:[{id:'task',goal:'Produce a report',acceptance:'Verify the report',entries:[]}],runs:[],memories:[],schedules:[],files:[],preferences:{},settings:{roots:[root],allowedConnections:['key'],maxConcurrent:2,maxTokens:1000,maxMinutes:30,approvalMode:'ask'}};
}
function run(p,id='r') {
 const now=Date.now();
 return {id,taskId:'task',workflowId:'flow',version:structuredClone(p.workflows[0].versions[0]),members:structuredClone(p.members),config:{},status:'ready',goal:p.tasks[0].goal,acceptance:p.tasks[0].acceptance,queue:['start'],arrivals:{},visits:{},traversals:{},reservations:{},attempts:[],events:[{id:'created-'+id,at:now,kind:'created',text:'Created from saved version'}],tokens:0,createdAt:now,updatedAt:now,projectSettings:structuredClone(p.settings),memorySnapshot:[],memoryIds:[]};
}
function install(store,root) { const p=project(root);store.update(0,p);p.runs.push(run(p));store.update(1,p);return p; }
function prepareDelivery(r) {
 r.status='waiting_user';r.queue=[];r.reservations={};
 if(!r.attempts.some(a=>a.nodeId==='node'&&a.status==='completed'))r.attempts.push({id:'work',nodeId:'node',visit:1,startedAt:1,status:'completed',output:'Verified result',steps:[]});
 r.attempts.push({id:'end-attempt',nodeId:'end',visit:1,startedAt:Date.now(),status:'waiting_user',output:'',steps:[]});
 r.pendingApproval={nodeId:'end',text:'Review deliverable'};r.approvalQueue=[r.pendingApproval];
}
function approveDelivery(r) {
 const a=r.attempts.find(a=>a.id==='end-attempt');a.status='completed';a.outcome='pass';a.output='User accepted';a.endedAt=Date.now();
 r.events.push({id:'approval-'+Date.now(),at:Date.now(),kind:'approval',nodeId:'end',approved:true,text:'User approved delivery'});
 r.approvalQueue=[];delete r.pendingApproval;r.status='completed';
}
module.exports={project,run,install,prepareDelivery,approveDelivery};
