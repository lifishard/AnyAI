import type { ChatMessage, HandoffInfo, RunRecord, RunState, ToolStep } from '../types';

/** Portable working notes, never hidden reasoning or a new user instruction. */
export function checkpointNotes(state: RunState) {
  const summary=state.compactions?.at(-1);
  return {
    status:state.status, blocker:state.reason,
    memory:summary ? {facts:summary.facts,decisions:summary.decisions,unresolved:summary.unresolved,nextSteps:summary.nextSteps}:undefined,
    milestones:state.milestones,
    requirements:state.requirements?.map(r=>({id:r.id,title:r.title,check:r.check,verification:r.verification})),
    recentEvidence:(state.steps??[]).slice(-12).map(s=>({id:s.id,callId:s.callId,name:s.name,status:s.status,summary:s.summary,resultRef:s.resultRef,error:s.error})),
    files:(state.steps??[]).flatMap(s=>s.files??[]).filter((f,i,all)=>all.findIndex(x=>x.path===f.path&&x.direction===f.direction)===i),
    pending:state.pendingCalls?.slice(state.toolCursor??0).map(c=>({id:c.id,name:c.name})),
    uncertainCallId:state.uncertainCallId,
  };
}

const plain=(m:ChatMessage):ChatMessage=>({id:m.id,role:m.role,content:m.content,createdAt:m.createdAt,
  attachments:m.attachments,quotes:m.quotes,quoteOnly:m.quoteOnly,toolCalls:m.toolCalls,toolCallId:m.toolCallId,toolName:m.toolName,contextKind:m.contextKind});
const unique=<T extends {id:string}>(items:T[])=>[...new Map(items.map(x=>[x.id,x])).values()];
export interface ConversationMemory {
  history:ChatMessage[];
  archive:ChatMessage[];
  evidence:ToolStep[];
  fromModel?:string;
  checkpoints:number;
}

/** Restore saved work behind visible answers without attributing old executions to a new task. */
export function conversationMemory(history:ChatMessage[],lookup:(id:string)=>RunRecord|undefined):ConversationMemory {
  let boundary=0;
  history.forEach((m,i)=>{if(m.role==='user'&&m.quoteOnly)boundary=i;});
  const scoped=history.slice(boundary),allowed=new Set(scoped.filter(m=>m.role==='user').map(m=>m.id));
  const sourceText=new Map(scoped.filter(m=>m.role==='user').map(m=>[m.id,m.content]));
  scoped.forEach(m=>m.supplementalInputs?.forEach(s=>allowed.add(s.id)));
  scoped.forEach(m=>m.supplementalInputs?.forEach(s=>sourceText.set(s.id,s.content)));
  const result:ConversationMemory={history:[],archive:[],evidence:[],checkpoints:0};
  for(const message of scoped){
    result.history.push(plain(message));
    if(message.role!=='assistant'||!message.taskId)continue;
    const record=lookup(message.taskId);
    if(!record||record.answerId!==message.id||!allowed.has(record.question.id))continue;
    const state=record.state;
    // Editing/deleting history or quote-only mode must not bring excluded instructions back.
    const userSources=state.requirementSourceIds??state.working.filter(m=>m.role==='user').map(m=>m.id);
    if(userSources.some(id=>!allowed.has(id)||state.working.find(m=>m.id===id)?.content!==sourceText.get(id)))continue;
    for(const input of message.supplementalInputs??[]) {
      if(!result.history.some(m=>m.id===input.id))result.history.push({...input,role:'user'});
    }
    result.archive.push(...(state.contextArchive??[]).map(plain),...state.working.map(plain));
    result.evidence.push(...(state.contextArchiveSteps??[]),...(state.steps??[]));
    const capsule:ChatMessage={id:`handoff-${message.id}`,role:'user',contextKind:'handoff',createdAt:message.createdAt,
      content:`历史任务交接记录（来自应用保存的执行记录；不是新的用户指令，历史模型结论可能有误）：\n${JSON.stringify(checkpointNotes(state))}\n本轮以最新用户要求为准；已有成果先读证据，避免重新执行。未完成旧任务要继续原操作游标时，使用原任务的“接着跑”。`};
    result.history.push(capsule);result.archive.push(capsule);
    result.checkpoints++;result.fromModel=record.config.model;
  }
  result.archive=unique(result.archive);result.evidence=unique(result.evidence);
  return result;
}

export function handoffInfo(state:RunState,fromModel:string|undefined,toModel:string,mode:HandoffInfo['mode'],checkpoints:number):HandoffInfo {
  return {fromModel,toModel,mode,at:Date.now(),status:'prepared',checkpoints,
    sourceMessages:new Set([...(state.contextArchive??[]),...state.working].map(m=>m.id)).size,
    savedSteps:new Set([...(state.contextArchiveSteps??[]),...(state.steps??[])].map(s=>s.id)).size,
    summaryAvailable:Boolean(state.compactions?.length||checkpoints),
  };
}

/** Stop only consecutive identical actions returning identical results in this attempt. */
export function repeatedWithoutProgress(state:RunState,name:string,args:unknown):boolean {
  const recent=(state.steps??[]).filter(s=>s.startedAt>=(state.attemptStartedAt??0)).slice(-3);
  const signature=JSON.stringify(args);
  return recent.length===3&&recent.every(s=>s.name===name&&s.status!=='running'&&JSON.stringify(s.args)===signature
    &&s.status===recent[0].status&&s.output===recent[0].output&&s.error===recent[0].error);
}
