import type {GenerationConfig,RunState,ToolResult} from '../types';
import type {AgentHandle,RunAgentArgs} from './agent';
import {TOOL_BY_NAME} from './tools/registry';
import type {SubagentJob} from './subagents';
const WORKER_BUDGET=24000;
const INTERNAL=new Set(['spawn_subagent','list_subagents','wait_subagents','request_access']);
export function createSubagentRuntime(args:RunAgentArgs,state:RunState,save:()=>Promise<void>,run:(args:RunAgentArgs)=>AgentHandle) {
  const pool=structuredClone(args.config.subagents);
  const active=new Map<string,{handle?:AgentHandle;done:Promise<void>;finish:()=>void}>();
  let stopped=false;
  const startingTokens=state.spentTokens || 0;
  state.subagents=structuredClone(state.subagents || []);
  // Resuming a parent does not prove that a previously dispatched child did not run.
  for(const job of state.subagents)if(job.status==='running'||job.status==='queued'){job.status='uncertain';job.error='先前子代理结果未确认，未自动重发。可查阅已保存内容，必要时明确派发新的任务。';}
  const enabled=Boolean(pool?.enabled&&pool.workers.length&&args.resolveWorker);
  const publicJob=({checkpoint,...job}:SubagentJob)=>({...job,content:job.content.slice(0,24000),truncated:job.content.length>24000});
  const snapshot=(ids?:string[])=>({workers:pool?.workers.map(({id,model,label})=>({id,model,label})) || [],jobs:state.subagents!.filter(j=>!ids||ids.includes(j.id)).map(publicJob),maxCalls:Math.max(1,Math.min(8,pool?.maxCalls || 4)),remaining:Math.max(0,(pool?.maxCalls || 4)-state.subagents!.length)});
  async function tool(name:string,input:Record<string,unknown>):Promise<ToolResult>{
    if(!enabled)return {ok:false,content:'',error:'请先在对话框的临时协作设置中启用并选择工作模型。'};
    if(name==='list_subagents')return {ok:true,content:JSON.stringify(snapshot()),summary:'已读取临时协作状态'};
    if(name==='wait_subagents'){
      const ids=input.ids===undefined?undefined:Array.isArray(input.ids)&&input.ids.every(x=>typeof x==='string')?input.ids as string[]:[];
      if(ids?.some(id=>!state.subagents!.some(j=>j.id===id)))return {ok:false,content:'',error:'只能读取当前任务的子代理。'};
      const waits=state.subagents!.filter(j=>!ids||ids.includes(j.id)).map(j=>active.get(j.id)?.done).filter(Boolean);
      const wait=Math.min(8000,Math.max(0,Number(input.wait_ms) || 0));let timer:ReturnType<typeof setTimeout>|undefined;
      if(waits.length&&wait)try{await Promise.race([Promise.all(waits),new Promise(r=>{timer=setTimeout(r,wait);})]);}finally{clearTimeout(timer);}
      const jobs=state.subagents!.filter(j=>!ids||ids.includes(j.id));
      return {ok:true,content:JSON.stringify(snapshot(ids)),summary:`子代理 ${jobs.filter(j=>j.status==='completed').length}/${jobs.length} 已完成`,files:jobs.flatMap(j=>j.checkpoint?.steps?.flatMap(s=>s.files || []) || [])};
    }
    if(name!=='spawn_subagent')return {ok:false,content:'',error:'未知子代理工具'};
    const worker=pool!.workers.find(w=>w.id===input.worker_id),key=typeof input.request_key==='string'?input.request_key.trim():'',task=typeof input.task==='string'?input.task.trim():'';
    if(!worker||!key||key.length>100||!task||task.length>16000)return {ok:false,content:'',error:'选择已授权的 worker_id、稳定 request_key，以及不超过 16000 字符的独立任务。'};
    const prior=state.subagents!.find(j=>j.requestKey===key);
    if(prior)return prior.task===task&&prior.workerId===worker.id?{ok:true,content:JSON.stringify(publicJob(prior)),summary:'返回已有子代理，未重复调用'}:{ok:false,content:'',error:'此 request_key 已对应不同任务，请核对后使用新编号。'};
    if(stopped)return {ok:false,content:'',error:'主任务已暂停，不能派发新子代理'};
    if(active.size>=2)return {ok:false,content:'',error:'已有两个子代理运行中，请先等待结果或处理其他工作。'};
    if(state.subagents!.length>=Math.max(1,Math.min(8,pool!.maxCalls || 4)))return {ok:false,content:'',error:'已达到本轮临时子代理次数上限。'};
    const max=args.config.runtime?.maxTokens || 0;
    if(max>0&&(state.spentTokens || 0)-startingTokens+WORKER_BUDGET>max)return {ok:false,content:'',error:'剩余任务预算不足以预留子代理额度。'};
    const job:SubagentJob={id:crypto.randomUUID(),requestKey:key,workerId:worker.id,model:worker.model,task,status:'queued',content:'',startedAt:Date.now(),steps:0,tokens:WORKER_BUDGET};
    state.subagents!.push(job);state.spentTokens=(state.spentTokens || 0)+WORKER_BUDGET;
    let finish!:()=>void;const done=new Promise<void>(r=>{finish=r;});const running={handle:undefined as AgentHandle|undefined,done,finish};active.set(job.id,running);
    await save();
    let settling=false;
    const terminal=async(status:SubagentJob['status'],error?:string)=>{
      if(!active.has(job.id)||settling)return;
      settling=true;
      job.status=stopped?'cancelled':status;job.error=error;job.finishedAt=Date.now();
      const actual=job.checkpoint?.spentTokens;
      // A child cancelled before dispatch has no checkpoint, so its reservation must
      // be returned just like a profile-resolution failure. Once a checkpoint
      // exists, charge only the child's recorded work.
      if(actual!==undefined || status==='failed' || status==='cancelled'){
        job.tokens=actual??0;state.spentTokens=Math.max(0,(state.spentTokens || 0)-WORKER_BUDGET+job.tokens);
      }
      const usage=job.checkpoint?.usage;
      state.usage ||= {};
      for(const field of ['prompt_tokens','completion_tokens','total_tokens','cached_tokens','reasoning_tokens'] as const)if(usage?.[field]!==undefined)state.usage[field]=(state.usage[field]??0)+usage[field]!;
      (state.requestStats ||= []).push(...(job.checkpoint?.requestStats??[]).map(stat=>({...stat,purpose:'subagent:'+job.id})));
      args.events.onUsage({...state.usage});
      try{await save();}finally{active.delete(job.id);finish();}
    };
    void (async()=>{
      try{
        const selected=await args.resolveWorker!(worker.profileId);
        if(stopped){await terminal('cancelled','主任务已暂停，尚未发送模型请求');return;}
        const tools=args.config.enabledTools.filter(name=>!INTERNAL.has(name)&&TOOL_BY_NAME[name]&&(!TOOL_BY_NAME[name].dangerous||pool!.allowEdits&&args.config.toolsEnabled));
        const config:GenerationConfig={...args.config,client:undefined,model:worker.model,subagents:undefined,customBody:'',systemPrompt:'',historyLimit:0,
          toolsEnabled:args.config.toolsEnabled,enabledTools:tools,maxToolRounds:8,
          params:{...args.config.params,max_tokens:{enabled:true,value:2048},max_completion_tokens:{enabled:false,value:2048}},
          runtime:{contextTokens:32000,tpm:0,rpm:0,maxTokens:WORKER_BUDGET,maxMinutes:10,recoveryMinutes:1,harness:'guided',semanticCompression:true}};
        job.status='running';await save();
        running.handle=run({...args,requestId:`${args.requestId}-sub-${job.id}`,profile:selected.profile,apiKey:selected.apiKey,config,
          history:[{id:'subtask-'+job.id,role:'user',content:task,createdAt:Date.now()}],resume:undefined,conversationMemory:undefined,compactBeforeRun:false,
          resolveWorker:undefined,previousModel:undefined,limitOf:undefined,onLearnLimit:undefined,modelInfo:selected.models?.find(m=>m.id===worker.model),autoRetry:0,
          extraSystem:'你是临时子代理，只完成指定子任务并返回结果、证据与局限。不要假设拥有父任务的完整历史，不要派发其他子代理，不要扩大范围。'+(pool!.allowEdits?'编辑仍需遵守用户当前权限和逐步审批。':'仅可查阅资料和给出文字结果，不能修改文件或执行写操作。'),
          events:{onContentDelta:text=>{job.content=(job.content+text).slice(0,100000);},onContentReplace:text=>{job.content=text.slice(0,100000);},onReasoningDelta(){},
            onStep:()=>{job.steps=job.checkpoint?.steps?.length || job.steps;},onSources(){},onUsage(){},onRound(){},onNotice:text=>{if(text)job.error=text;},onStopReason(){},
            onRunState:async child=>{if(child){job.checkpoint=structuredClone(child);job.steps=child.steps?.length || 0;job.content=child.content || job.content;await save();}},
            onDone:()=>{void terminal('completed').catch(()=>{});},onPaused:reason=>{void terminal('paused',reason).catch(()=>{});},onError:message=>{void terminal('failed',message).catch(()=>{});}}});
      }catch(error){await terminal('failed',error instanceof Error?error.message:String(error));}
    })().catch(()=>{});
    return {ok:true,content:JSON.stringify(publicJob(job)),summary:`已派发 ${worker.label || worker.model}`};
  }
  return {enabled,tool,async waitRunning(){await Promise.all([...active.values()].map(r=>r.done));},stop(){stopped=true;for(const run of active.values())run.handle?.abort();},running:()=>active.size};
}
