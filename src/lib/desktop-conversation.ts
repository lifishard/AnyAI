import type {RunAgentArgs,AgentHandle} from './agent';
import {buildWire} from './agent';
import type {RunState} from '../types';
import {desktop} from './transport';
import {taskSeed,harnessInstructions,planOnly,completionBlocker} from './harness';

/** Claude Desktop owns its subscription and interaction. MCP returns the result to this turn. */
export function runDesktopConversation(args:RunAgentArgs):AgentHandle {
  const bridge=desktop(),events=args.events;
  let cancelled=false,wake:undefined|(()=>void);
  const state:RunState={...structuredClone(args.resume),version:2,runId:args.resume?.runId||args.requestId,
    working:structuredClone(args.resume?.working??args.history),round:args.resume?.round||1,at:Date.now(),stoppedBy:'unknown',status:'running',phase:'request',
    content:args.resume?.content||'',steps:args.resume?.steps||[],sources:[],attemptId:args.requestId,attemptStartedAt:Date.now()};
  state.harness=taskSeed(args.history,args.config,state.harness);
  const save=async()=>{state.at=Date.now();await events.onRunState(structuredClone(state));};
  void(async()=>{
    try{
      if(!bridge?.nativeAiCreate)throw Error('Claude Desktop 连接需要桌面版。');
      if(state.working.some(m=>m.attachments?.some(a=>a.kind==='image')))throw Error('Claude Desktop 交接暂不自动传图片。图片已保留，可在官方应用添加，或使用支持图片的 API 模型。');
      if(!state.nativeDesktop?.taskId){
        const goal=JSON.stringify(buildWire(state.working,{...args.config,toolsEnabled:false,historyLimit:0},args.extraSystem+harnessInstructions(args.config,state)));
        if(goal.length>24000)throw Error('Claude Desktop 的交接材料超过 24000 字符。请使用新对话明确本次目标，或改用 Claude Code / API 模型处理长上下文；原文未裁剪。');
        await save();
        const created=await bridge.nativeAiCreate({provider:'claude-desktop',goal,requestKey:state.runId,
          workers:args.config.subagents?.enabled?args.config.subagents.workers.map(w=>({profileId:w.profileId,model:w.model,outputField:'max_tokens' as const})):[],
          maxJobs:Math.max(1,Math.min(8,args.config.subagents?.maxCalls||4)),maxOutputTokens:2048});
        state.nativeDesktop={taskId:created.task.id,prompt:created.prompt,status:created.task.status};await save();
      }
      const taskId=state.nativeDesktop.taskId!;
      if(cancelled){await bridge.nativeAiCancel(taskId);throw Error('已停止 Claude Desktop 交接。');}
      await bridge.nativeAiOpen('claude-desktop',taskId);
      events.onNotice('已打开 Claude Desktop。请在官方应用点发送并授权连接器；任务进度和结果会回到此处。');
      const deadline=Date.now()+(args.config.runtime?.maxMinutes||60)*60000;
      let signature='';
      while(!cancelled){
        const task=(await bridge.nativeAiState()).tasks.find(t=>t.id===taskId);
        if(!task)throw Error('原 Claude Desktop 任务记录已不可用，未自动重发。');
        const next=JSON.stringify(task);
        if(next!==signature){
          signature=next;state.nativeDesktop.status=task.status;
          state.subagents=task.jobs.map(j=>({id:j.id,requestKey:j.id,workerId:j.workerId,model:task.workers.find(w=>w.id===j.workerId)?.model||'',task:j.prompt,
            status:j.status,content:j.text||'',error:j.error,startedAt:task.createdAt,steps:0,tokens:(j.usage?.prompt_tokens||0)+(j.usage?.completion_tokens||0)}));
          const progress=task.progress.at(-1)?.text;
          if(progress)events.onNotice(progress);
          if(task.result){state.content=task.result;events.onContentReplace?.(task.result,'');}
          await save();
        }
        if(task.status==='completed'){
          const blocker=completionBlocker(state,task.result||'',args.config);if(blocker)throw Error(blocker);
          if(!task.result?.trim()||state.harness?.action&&planOnly(task.result))throw Error('Claude Desktop 已回传，但内容仍只有计划，任务尚未确认完成。');
          state.status='completed';state.reason=undefined;state.harness!.stage='deliver';
          state.working.push({id:args.requestId+'-answer',role:'assistant',content:task.result,createdAt:Date.now()});
          await save();await events.onRunState(null);events.onNotice('');events.onDone();return;
        }
        if(task.status==='cancelled')throw Error('Claude Desktop 任务已取消，已有记录保留。');
        if(Date.now()>=deadline)throw Error('等待 Claude Desktop 达到本阶段时间上限，可继续检查原任务；未自动重发。');
        await new Promise<void>((resolve)=>{const timer=setTimeout(()=>{wake=undefined;resolve();},3000);wake=()=>{clearTimeout(timer);resolve();};});
      }
      throw Error('已停止等待 Claude Desktop，已有结果保留。');
    }catch(error){
      state.status='paused';state.reason=error instanceof Error?error.message:String(error);state.stoppedBy=cancelled?'user':'error';
      try{await save();}catch{state.reason='交接记录保存失败，请先核实 Claude Desktop 中的原任务。';}
      events.onNotice('');events.onPaused?.(state.reason);
    }
  })();
  return {abort(){cancelled=true;wake?.();if(state.nativeDesktop?.taskId)void bridge?.nativeAiCancel(state.nativeDesktop.taskId).catch(()=>{});}};
}
