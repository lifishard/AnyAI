import {runAgent,buildWire,type RunAgentArgs,type AgentHandle} from './agent';
import {desktop} from './transport';
import type {RunState} from '../types';
import type {ClientTurnResult} from './connections';
import {formatUserAnswers,parseUserQuestions,validateUserAnswers} from './user-questions';
import {taskSeed,harnessInstructions,planOnly,completionBlocker} from './harness';
import {runDesktopConversation} from './desktop-conversation';

/** Native adapters receive a portable transcript; vendor session IDs are evidence, not the sole memory. */
export function runConnectedAgent(args:RunAgentArgs):AgentHandle {
  if(args.config.client?.kind==='claude-desktop')return runDesktopConversation(args);
  if(!args.config.client){
    const pending=args.resume?.userQuestion;
    if(pending?.callId.startsWith('native-question-')){
      if(!pending.answers){void Promise.resolve().then(()=>args.events.onPaused?.('请先回答待处理的问题'));return {abort(){}};}
      const state=structuredClone(args.resume!);const answers=validateUserAnswers(pending.request,pending.answers),content=formatUserAnswers(pending.request,answers),input={id:pending.callId+'-answer',content,createdAt:Date.now()};
      state.working.push({...input,role:'user'});state.supplementalInputs=[...(state.supplementalInputs || []),input];
      state.userQuestionHistory=[...(state.userQuestionHistory || []),{request:pending.request,answers,at:Date.now()}];
      state.userQuestion=undefined;state.waitKind=undefined;state.phase='request';
      return runAgent({...args,resume:state});
    }
    return runAgent(args);
  }
  const bridge=desktop(), events=args.events;
  let cancelled=false;
  let off=()=>{};
  const state:RunState={...structuredClone(args.resume),working:structuredClone(args.resume?.working ?? args.conversationMemory?.history ?? args.history),
    contextArchive:structuredClone(args.resume?.contextArchive ?? args.conversationMemory?.archive ?? []),
    requirementSourceIds:args.resume?.requirementSourceIds ?? args.history.filter(m=>m.role==='user'&&!m.contextKind).map(m=>m.id),
    version:2,runId:args.resume?.runId || args.requestId,at:Date.now(),round:args.resume?.round || 1,stoppedBy:'unknown',status:'running',
    content:args.resume?.content || '',lastModel:args.config.model,attemptId:args.requestId,phase:'request',steps:args.resume?.steps || [],sources:args.resume?.sources || []};
  const save=async()=>{state.at=Date.now();await events.onRunState(structuredClone(state));};
  state.harness=taskSeed(state.working,args.config,state.harness);
  void (async()=>{
    try{
      if(!bridge)throw Error('本机连接需要使用桌面版。');
      let recovered:ClientTurnResult|null=null;
      if(state.uncertainCallId){
        if(state.uncertainCallId.startsWith('native-')){
          const previous=await bridge.conversationClientRecover(state.runId!,state.uncertainCallId);
          if(previous?.status==='completed')recovered=previous;
          else if(!previous)state.uncertainCallId=undefined;
          else if(args.resolveUncertain==='skip')recovered={status:'completed',text:'你已核实并跳过先前未确认的操作；本次没有重新执行。'};
          else if(args.resolveUncertain!=='retry'){
            if(previous.text){state.content=previous.text;events.onContentReplace?.(previous.text,'');}
            throw Error('上次本机操作尚未确认。请核实产物后选择跳过或明确重试，避免重复执行。');
          }
        }else throw Error('此前 API 工具的执行结果尚未确认，请先在原连接中核实该操作，再切换本机连接。');
      }
      if(state.userQuestion && !state.userQuestion.answers){state.status='paused';state.waitKind='question';state.reason='等待用户回答';await save();events.onPaused?.(state.reason);return;}
      if(state.working.some(m=>m.attachments?.some(a=>a.kind==='image')))throw Error('当前本机连接仅接收文字和文本附件。图片仍保留在会话中，请切换支持图片的 API 模型处理。');
      // A previous native response may have paused on a renderer-owned
      // question.  Add the validated answer to the portable transcript before
      // starting the next native turn, so a fresh vendor session still has the
      // complete conversation/task context.
      if(state.userQuestion?.answers){
        const pending=state.userQuestion;
        const submittedAnswers=pending.answers;
        if(!submittedAnswers)throw Error('问题回答尚未准备好。');
        const answers=validateUserAnswers(pending.request,submittedAnswers);
        const content=formatUserAnswers(pending.request,answers);
        const input={id:`${pending.callId}-answer`,content,createdAt:Date.now()};
        state.working.push({...input,role:'user'});
        state.supplementalInputs=[...(state.supplementalInputs || []).filter(m=>m.id!==input.id),input];
        state.userQuestionHistory=[...(state.userQuestionHistory??[]).filter(item=>item.request.id!==pending.request.id),{request:structuredClone(pending.request),answers:structuredClone(answers),at:Date.now()}];
        state.userQuestion=undefined;
        state.waitKind=undefined;
        state.reason='已收到回答，正在继续';
      }
      await save();
      if(cancelled)throw Error('已暂停，尚未派发本机请求。');
      let streamed='';
      let questionMarkupSeen=false;
      off=bridge.onClientEvent(event=>{
        if(event.requestId!==args.requestId || cancelled)return;
        if(event.type==='delta' && event.text){
          streamed+=event.text;
          if(/<wickrun_question\b/i.test(streamed))questionMarkupSeen=true;
          if(!questionMarkupSeen){state.content=(state.content || '')+event.text;events.onContentDelta(event.text);}
        }
        if(event.type==='approval' && event.id){
          const id=event.id,step={id,callId:id,name:'native_client_operation',args:event.event || {},status:'running' as const,summary:'官方客户端请求执行操作',startedAt:Date.now()};
          state.status='waiting';state.waitKind='approval';events.onNotice('官方客户端正在等待操作确认');
          void save().then(()=>args.confirm(step)).then(approved=>bridge.conversationClientApprove(args.requestId,id,approved && !cancelled)).catch(()=>bridge.conversationClientApprove(args.requestId,id,false).catch(()=>{})).finally(()=>{if(!cancelled){state.status='running';state.waitKind=undefined;events.onNotice('正在等待官方客户端返回结果…');}});
        }
      });
      const context=buildWire(state.working,{...args.config,toolsEnabled:false,historyLimit:0},args.extraSystem+harnessInstructions(args.config,state));
      const prompt=`You are continuing the user's conversation inside wickrunAI. The following JSON is the conversation transcript, with role labels and attached text. Answer the most recent user request while preserving earlier requirements. Do not repeat completed operations from prior turns. ${args.config.toolsEnabled?'Work only within the authorized working directory. Report output paths and unresolved requirements.':'This is Chat mode: discuss only. Do not execute commands or change files.'}

If you need a blocking answer from the user before you can continue, emit exactly one <wickrun_question> marker containing JSON in this schema: {"questions":[{"id":"stable-id","header":"short optional heading","question":"question text","options":[{"label":"choice","description":"optional explanation"}],"multiple":false}]}. Include 1 to 3 questions, at most 6 options per question, and use an empty options array for a free-text question. Do not put markdown around the marker. You may put a short user-visible explanation before or after it. Never use this marker unless the turn has completed successfully.

${JSON.stringify(context)}`;
      events.onNotice('正在等待官方客户端返回结果…');
      // Save dispatch uncertainty before invoking: a renderer restart cannot imply that nothing ran.
      if(!recovered){state.uncertainCallId='native-'+args.requestId;await save();}
      const result=recovered ?? await bridge.conversationClientRun({runId:state.runId!,requestId:args.requestId,prompt,cwd:args.config.toolsEnabled?args.toolCtx().workspaceRoots[0]:undefined});
      // A question marker is actionable only on a verified terminal result.
      // Unknown/failed native outcomes must stay uncertain so recovery cannot
      // silently turn an interrupted request into a user question.
      const questionMatch=result.status==='completed'
        ? /<wickrun_question\b[^>]*>([\s\S]*?)<\/wickrun_question\s*>/i.exec(result.text||'')
        : null;
      if(questionMatch){
        let request;
        try{request=parseUserQuestions(JSON.parse(questionMatch[1]),`question-${state.runId??args.requestId}-${args.requestId}`);}
        catch(error){throw Error(`本机客户端的问题格式无效：${error instanceof Error?error.message:String(error)}`);}
        const visible=(result.text||'').replace(questionMatch[0],'').trim();
        state.content=visible;
        state.working.push({id:`${args.requestId}-question`,role:'assistant',content:visible,createdAt:Date.now()});
        state.userQuestion={request,callId:`native-question-${args.requestId}`,toolIndex:0};
        state.status='paused';state.waitKind='question';state.reason='等待用户回答';state.uncertainCallId=undefined;
        events.onContentReplace?.(visible,'');
        await save();events.onNotice('');events.onPaused?.('等待用户回答');return;
      }
      if(result.text){state.content=result.text;events.onContentReplace?.(result.text,'');}
      if(result.status!=='unknown')state.uncertainCallId=undefined;
      if(result.status!=='completed')throw Error(result.error || `官方客户端已暂停（${result.status}），已有内容已保留。`);
      const blocker=completionBlocker(state,result.text,args.config);if(blocker)throw Error(blocker);
      if(state.harness?.action&&planOnly(result.text)){
        state.harness.completion={status:'needs_work',reason:'本机客户端仅返回了计划，尚未确认完成。',evidence:[],at:Date.now()};
        throw Error('本机客户端只返回了下一步计划，任务尚未完成。请继续本轮以核实进度；应用没有自动重发可能已执行的本机操作。');
      }
      state.working.push({id:args.requestId+'-answer',role:'assistant',content:result.text,createdAt:Date.now()});
      state.status='completed';state.reason=undefined;state.pendingCalls=undefined;state.toolCursor=undefined;
      await save();await events.onRunState(null);events.onNotice('');events.onDone();
    }catch(error){
      state.status='paused';state.reason=error instanceof Error?error.message:String(error);state.stoppedBy=cancelled?'user':'error';
      try{await save();}catch{state.reason='执行记录写入失败，已停止；请核实本机客户端的运行状态。';}
      events.onNotice('');events.onPaused?.(state.reason);
    }finally{off();}
  })();
  return {abort(){cancelled=true;void bridge?.toolAbort(state.runId!);}};
}
