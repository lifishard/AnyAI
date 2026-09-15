import type { RunRecord } from '../types';
import { getTransport } from './transport';
import { TOOL_BY_NAME } from './tools/registry';
import { recoveryInfo } from './delivery';
import { APP_VERSION as appVersion } from './version';

export type UserOutcome = 'usable' | 'partial' | 'unresolved';
export type FeedbackReason = 'omission' | 'incorrect' | 'artifact' | 'interrupted' | 'other';
export interface TaskFeedback { outcome:UserOutcome;reason?:FeedbackReason;at:number;attemptId?:string }
export interface ObservationEvent { id:string;key:string;seq:number;at:number;attemptId:string;type:string;data:Record<string,string|number|boolean|null> }
export interface AttemptObservation {id:string;sourceId:string;startedAt:number;lastAt:number;endedAt?:number;model:string;effort:string;route:string;appVersion:string;runtimeVersion:string;status:string;waitMs:number;humanWaitMs:number;activeMs:number;lastPhase:string;lastObservedAt:number;contextWindow?:number;workingBudget?:number}
export interface TaskObservation {
  id:string;recordId:string;conversationId:string;answerId:string;startedAt:number;lastAt:number;status:string;appVersion:string;runtimeVersion:string;
  acceptance:{coverage:string;total:number;passed:number;failed:number;unverifiable:number;unchecked:number;program:number;model:number};
  feedback?:TaskFeedback;attempts:AttemptObservation[];droppedAttempts:number;events:ObservationEvent[];nextSeq:number;droppedEvents:number;seenEvents:Record<string,boolean>;detailLimitReached?:boolean;
  requests:{total:number;accepted:number;failed:number;rejected:number;cancelled:number;pending:number;actualInput:number;actualOutput:number;missingInput:number;missingOutput:number;estimatedInput:number;reservedOutput:number;requestMs:number;missingDispatch:number};
  tools:{total:number;ok:number;failed:number;denied:number;elapsedMs:number};
  compactions:{total:number;latestBeforeTokens:number|null;latestAfterTokens:number|null};
  requirementStates:Record<string,string>;
  harness?:{mode:string;continuations:number;completion:string;foldedMessages:number;subagents:number;subagentsCompleted:number};
  pauseCount:number;resumeCount:number;pauseReasons:Record<string,number>;supplements:number;recoveredWrites:number;missing:string[];
}
export interface ObservationStore {version:1;epoch:string;createdAt:number;tasks:TaskObservation[];droppedTasks:number;writeFailures:number;lastError?:string;clearedAt?:number;ignoredRecordIds:string[]}
export const OBSERVATION_KEY='anyai:observations:v1';
export const RETENTION_DAYS=90;
export const MAX_TASKS=500;
export const MAX_EVENTS=200;
export const MAX_INDEX_BYTES=4*1024*1024;
const newid=()=>globalThis.crypto.randomUUID();
export const emptyObservations=():ObservationStore=>({version:1,epoch:newid(),createdAt:Date.now(),tasks:[],droppedTasks:0,writeFailures:0,ignoredRecordIds:[]});
let data:ObservationStore|undefined, loading:Promise<ObservationStore>|undefined, chain=Promise.resolve();
const routes = new Map<string,string>();
const changed=()=>{ if (typeof window !== 'undefined') window.dispatchEvent(new Event('anyai:observations')); };
export async function observationStore():Promise<ObservationStore> {
  if(data)return data;
  if(!loading)loading=(async()=>{
    try {
      const raw=await getTransport().kvGet(OBSERVATION_KEY);
      if(raw){const parsed=JSON.parse(raw);if(parsed.version!==1||!Array.isArray(parsed.tasks))throw new Error('unsupported');data=parsed;}
      else data=emptyObservations();
    }catch{data=emptyObservations();data.lastError='统计记录无法读取；本次数据覆盖不完整';data.writeFailures=1;}
    return data!;
  })();
  return loading;
}
async function routeAlias(url:string,epoch:string):Promise<string> {
  const key=epoch+'::'+url;
  if(routes.has(key))return routes.get(key)!;
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
  const alias='route-'+[...new Uint8Array(hash)].slice(0,8).map(x=>x.toString(16).padStart(2,'0')).join('');routes.set(key,alias);return alias;
}
function event(t:TaskObservation,key:string,type:string,at:number,attemptId:string,payload:ObservationEvent['data']) {
  const old=t.events.find(e=>e.key===key);
  if(old){old.data=payload;return;}
  if(t.seenEvents[key] || t.detailLimitReached)return;
  if(t.nextSeq>=2000){t.detailLimitReached=true;return;}
  t.seenEvents[key]=true;
  const seq=++t.nextSeq;t.events.push({id:`${t.id}:${seq}`,key,seq,type,at,attemptId,data:payload});
  if(t.events.length>MAX_EVENTS){t.droppedEvents+=t.events.length-MAX_EVENTS;t.events=t.events.slice(-MAX_EVENTS);}
}
function countStatus(items:{status?:string}[],status:string){return items.filter(i=>i.status===status).length;}

/** Pure snapshot projection; raw text, titles, paths, headers and error messages never enter the index. */
export function projectObservation(previous:TaskObservation|undefined,record:RunRecord,route:string):TaskObservation {
  const s=record.state,at=s.at,stageSource=s.attemptId ?? 'legacy';
  const t:TaskObservation=previous ? structuredClone(previous):{
    id:newid(),recordId:record.id,conversationId:record.conversationId,answerId:record.answerId,
    startedAt:s.startedAt ?? record.question.createdAt,lastAt:at,status:'unknown',appVersion,runtimeVersion:s.runtimeVersion ?? 'unknown',
    acceptance:{coverage:'not_defined',total:0,passed:0,failed:0,unverifiable:0,unchecked:0,program:0,model:0},attempts:[],droppedAttempts:0,events:[],nextSeq:0,droppedEvents:0,seenEvents:{},
    requests:{total:0,accepted:0,failed:0,rejected:0,cancelled:0,pending:0,actualInput:0,actualOutput:0,missingInput:0,missingOutput:0,estimatedInput:0,reservedOutput:0,requestMs:0,missingDispatch:0},
    tools:{total:0,ok:0,failed:0,denied:0,elapsedMs:0},compactions:{total:0,latestBeforeTokens:null,latestAfterTokens:null},requirementStates:{},pauseCount:0,resumeCount:0,pauseReasons:{},supplements:0,recoveredWrites:0,missing:[],
  };
  if(previous && at<previous.lastAt)return t;
  t.seenEvents ??= {};
  if(!previous&&s.isResumedAttempt){t.resumeCount=1;t.missing.push('本任务较早阶段没有统计，仅记录本次续跑及之后阶段');}
  let attempt=t.attempts.find(a=>a.sourceId===stageSource);
  if(!attempt){
    if(t.attempts.length){t.resumeCount++;const old=t.attempts.at(-1)!;if(!old.endedAt){old.endedAt=old.lastAt;old.status='interrupted';}}
    attempt={id:newid(),sourceId:stageSource,startedAt:s.attemptStartedAt ?? at,lastAt:at,model:record.config.model,effort:record.config.effortLevel,route,appVersion,runtimeVersion:s.runtimeVersion ?? 'unknown',status:s.status ?? 'unknown',waitMs:0,humanWaitMs:0,activeMs:0,lastPhase:s.status ?? 'unknown',lastObservedAt:at};
    t.attempts.push(attempt);event(t,`attempt:${stageSource}`,t.attempts.length===1&&!s.isResumedAttempt?'task_started':'task_resumed',at,attempt.id,{legacy:!s.attemptId,priorHistoryMissing:!previous&&!!s.isResumedAttempt});
    if(t.attempts.length>100){t.droppedAttempts=(t.droppedAttempts??0)+t.attempts.length-100;t.attempts=t.attempts.slice(-100);}
  }
  const gap=Math.max(0,at-attempt.lastObservedAt);
  if(!attempt.endedAt && gap<=5*60000){if(attempt.lastPhase==='waiting')attempt.waitMs+=gap;else if(attempt.lastPhase==='awaiting_user')attempt.humanWaitMs=(attempt.humanWaitMs??0)+gap;else if(attempt.lastPhase==='running')attempt.activeMs+=gap;}
  else if(!attempt.endedAt && gap>5*60000 && !t.missing.includes('存在超过五分钟的观测间隔，耗时分段不完整'))t.missing.push('存在超过五分钟的观测间隔，耗时分段不完整');
  attempt.lastObservedAt=at;attempt.lastAt=at;attempt.lastPhase=s.status==='waiting'&&s.waitKind==='approval'?'awaiting_user':s.status ?? 'unknown';attempt.status=attempt.lastPhase;
  attempt.contextWindow=s.contextSnapshot?.contextWindow;attempt.workingBudget=s.contextSnapshot?.workingBudget;
  if(['paused','completed'].includes(attempt.status))attempt.endedAt=at;
  if(t.status!==attempt.status){
    const reason=attempt.status==='paused'?recoveryInfo(s).kind:'none';
    if(attempt.status==='paused'){t.pauseCount++;t.pauseReasons[reason]=(t.pauseReasons[reason]??0)+1;}
    event(t,`state:${stageSource}:${t.nextSeq+1}`,'state_changed',at,attempt.id,{from:t.status,to:attempt.status,reason,errorKind:s.errorInfo?.kind??'none'});
  }
  t.status=attempt.status;t.lastAt=at;t.appVersion=appVersion;t.runtimeVersion=s.runtimeVersion ?? 'unknown';
  if(s.harness){
    t.harness={mode:s.harness.mode,continuations:s.harness.continuations,completion:s.harness.completion?.status??'unchecked',foldedMessages:s.harness.context?.foldedMessages??0,subagents:s.subagents?.length??0,subagentsCompleted:s.subagents?.filter(j=>j.status==='completed').length??0};
    event(t,`harness:${stageSource}:${s.harness.continuations}`,'completion_guard',s.harness.completion?.at??at,attempt.id,{mode:s.harness.mode,continuations:s.harness.continuations,status:s.harness.completion?.status??'unchecked',foldedMessages:t.harness.foldedMessages,subagents:t.harness.subagents});
  }
  if(s.handoff)event(t,`handoff:${stageSource}`,'context_handoff',s.handoff.at,attempt.id,{
    mode:s.handoff.mode,status:s.handoff.status,modelChanged:Boolean(s.handoff.fromModel&&s.handoff.fromModel!==s.handoff.toModel),
    sourceMessages:s.handoff.sourceMessages,savedSteps:s.handoff.savedSteps,checkpoints:s.handoff.checkpoints,summaryAvailable:s.handoff.summaryAvailable,
  });
  const req=s.requirements ?? [], current=req.map(r=>r.verification?.revision===r.revision?r.verification:undefined);
  t.acceptance={coverage:req.length?'model_defined':'not_defined',total:req.length,passed:current.filter(v=>v?.status==='passed').length,failed:current.filter(v=>v?.status==='failed').length,
    unverifiable:current.filter(v=>v?.status==='unverifiable').length,unchecked:current.filter(v=>!v).length,program:current.filter(v=>v?.method==='program').length,model:current.filter(v=>v?.method==='model').length};
  req.forEach((r,i)=>{
    t.requirementStates ??= {};const nextState=`${r.revision}:${r.verification?.status??'unchecked'}`;
    if(t.requirementStates[r.id]&&!t.requirementStates[r.id].endsWith('unchecked')&&!r.verification)event(t,`invalidate:${r.id}:${at}`,'verification_invalidated',at,attempt!.id,{requirement:i+1,revision:r.revision});
    t.requirementStates[r.id]=nextState;
    event(t,`req:${r.id}:${r.revision}`,'requirement_recorded',r.at,attempt!.id,{requirement:i+1,revision:r.revision,check:r.check.kind});
    if(r.verification)event(t,`verify:${r.id}:${r.revision}:${r.verification.at}`,'requirement_checked',r.verification.at,attempt!.id,{requirement:i+1,revision:r.revision,status:r.verification.status,method:r.verification.method});
  });
  const stats=s.requestStats ?? [], sum=(key:'actualInput'|'output'|'estimatedInput'|'reservedOutput'|'elapsedMs')=>stats.reduce((n,r)=>n+(typeof r[key]==='number'?r[key]!:0),0);
  t.requests={total:stats.length,accepted:stats.filter(r=>r.outcome==='accepted').length,failed:stats.filter(r=>r.outcome==='failed').length,rejected:stats.filter(r=>r.outcome==='rejected').length,cancelled:stats.filter(r=>r.outcome==='cancelled').length,pending:stats.filter(r=>r.outcome==='pending'||!r.outcome).length,
    actualInput:sum('actualInput'),actualOutput:sum('output'),missingInput:stats.filter(r=>r.actualInput===undefined).length,missingOutput:stats.filter(r=>r.output===undefined).length,estimatedInput:sum('estimatedInput'),reservedOutput:sum('reservedOutput'),requestMs:sum('elapsedMs'),missingDispatch:stats.filter(r=>!r.dispatchedAt).length};
  stats.forEach((r,i)=>event(t,`request:${i}`,'request',r.at,attempt!.id,{index:i+1,purpose:['agent','final','compaction'].includes(r.purpose)?r.purpose:'other',outcome:r.outcome ?? 'unknown',httpStatus:r.httpStatus??null,failureKind:r.failureKind??null,actualInput:r.actualInput ?? null,actualOutput:r.output ?? null,estimatedInput:r.estimatedInput,reservedOutput:r.reservedOutput,elapsedMs:r.elapsedMs ?? null,queueMs:r.dispatchedAt?Math.max(0,r.dispatchedAt-r.at):null}));
  const steps=s.steps ?? [];t.tools={total:steps.length,ok:countStatus(steps,'ok'),failed:countStatus(steps,'error'),denied:countStatus(steps,'denied'),elapsedMs:steps.reduce((n,x)=>n+(x.elapsedMs ?? 0),0)};
  steps.forEach((step,i)=>event(t,`tool:${step.id}`,'tool',step.startedAt,attempt!.id,{index:i+1,name:TOOL_BY_NAME[step.name]?step.name:'unknown',status:step.status,elapsedMs:step.elapsedMs ?? null}));
  const comps=s.compactions ?? [];t.compactions={total:comps.length,latestBeforeTokens:comps.at(-1)?.beforeTokens??null,latestAfterTokens:comps.at(-1)?.afterTokens??null};
  comps.forEach((c,i)=>event(t,`compaction:${c.id}`,'compaction',c.createdAt,attempt!.id,{index:i+1,beforeTokens:c.beforeTokens,afterTokens:c.afterTokens}));
  t.supplements=s.supplementalInputs?.length ?? 0;t.recoveredWrites=steps.filter(x=>x.summary==='已核实中断前的文件写入').length;
  s.supplementalInputs?.forEach((input,i)=>event(t,`input:${input.id}`,'user_supplement',input.createdAt,attempt!.id,{index:i+1}));
  if(!s.attemptId&&!t.missing.includes('旧任务缺少执行阶段信息'))t.missing.push('旧任务缺少执行阶段信息');
  if(!s.requestStats&&!t.missing.includes('旧任务缺少请求用量记录'))t.missing.push('旧任务缺少请求用量记录');
  return t;
}
export function pruneObservations(store:ObservationStore,now=Date.now()):void {
  const kept=store.tasks.filter(t=>now-t.lastAt<=RETENTION_DAYS*86400000).sort((a,b)=>a.lastAt-b.lastAt).slice(-MAX_TASKS);
  store.droppedTasks+=store.tasks.length-kept.length;store.tasks=kept;
  while(store.tasks.length>1 && new TextEncoder().encode(JSON.stringify(store)).length>MAX_INDEX_BYTES){store.tasks.shift();store.droppedTasks++;}
}
type StoreMutation = (store:ObservationStore)=>Promise<void>|void;
async function mutate(fn:StoreMutation):Promise<void> {
  const applyMutation=fn;
  chain=chain.catch(()=>{}).then(async()=>{
    const store=await observationStore();
    try {await applyMutation(store);pruneObservations(store);store.lastError=undefined;await getTransport().kvSet(OBSERVATION_KEY,JSON.stringify(store));}
    catch{store.writeFailures++;store.lastError='部分统计未能保存；任务本身不受影响，当前分析可能不完整';}
    changed();
  });
  return chain;
}
export async function observeRun(record:RunRecord):Promise<void>{
  return mutate(async store=>{
    if(store.ignoredRecordIds.includes(record.id) || (store.clearedAt && (record.state.startedAt ?? record.question.createdAt)<=store.clearedAt))return;
    const index=store.tasks.findIndex(t=>t.recordId===record.id),previous=store.tasks[index];
    const route=await routeAlias(record.config.model+'::'+record.keyProfileId+'::'+(record.state.contextSnapshot?.routeKey ?? ''),store.epoch);
    const next=projectObservation(previous,record,route);
    if(index<0)store.tasks.push(next);else store.tasks[index]=next;
  });
}
export async function reconcileObservations(records:RunRecord[]):Promise<void>{
  await mutate(store=>{
    const ids=new Set(records.map(r=>r.id));store.tasks=store.tasks.filter(t=>ids.has(t.recordId));
    for(const t of store.tasks)if(['running','waiting','awaiting_user'].includes(t.status)){
      t.status='interrupted';const a=t.attempts.at(-1);if(a){a.status='interrupted';a.endedAt=a.lastAt;}
      if(!t.missing.includes('应用中断后的实际执行结果尚未核实'))t.missing.push('应用中断后的实际执行结果尚未核实');
    }
  });
}
export async function removeObservations(conversationId:string,answerIds?:Set<string>):Promise<void>{
  await mutate(store=>{store.tasks=store.tasks.filter(t=>t.conversationId!==conversationId || (answerIds && !answerIds.has(t.answerId)));});
}
export async function setTaskFeedback(recordId:string,feedback:TaskFeedback|undefined):Promise<void>{
  await mutate(store=>{
    const t=store.tasks.find(t=>t.recordId===recordId);if(!t)return;
    t.feedback=feedback?{...feedback,attemptId:t.attempts.at(-1)?.id}:undefined;event(t,`feedback:${t.nextSeq+1}`,'user_feedback',Date.now(),t.attempts.at(-1)?.id ?? 'unknown',{outcome:feedback?.outcome ?? 'removed',reason:feedback?.reason ?? 'none'});
  });
}
export async function clearObservations():Promise<void>{
  await mutate(store=>{const ignoredRecordIds=store.tasks.map(t=>t.recordId);Object.assign(store,emptyObservations(),{clearedAt:Date.now(),ignoredRecordIds});routes.clear();});
}
export async function observationSnapshot():Promise<ObservationStore>{await chain;const s=structuredClone(await observationStore());pruneObservations(s);return s;}
export function isCurrentFeedback(t:TaskObservation):boolean{return !!t.feedback?.attemptId&&t.feedback.attemptId===t.attempts.at(-1)?.id;}
export async function feedbackSnapshot(recordId:string):Promise<{available:boolean;feedback?:TaskFeedback;current:boolean}>{const s=await observationStore(),t=s.tasks.find(t=>t.recordId===recordId);return {available:!!t,feedback:t?.feedback?{...t.feedback}:undefined,current:t?isCurrentFeedback(t):false};}
