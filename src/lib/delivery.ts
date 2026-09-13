import type { AcceptanceCheck, DeliveryReport, DeliveryRequirement, RecoveryInfo, RequirementVerification, RunState, ToolResult } from '../types';

export function addRunInput(state:RunState,message:{id:string;content:string;createdAt:number}):RunState {
  const next=structuredClone(state);
  next.supplementalInputs=[...(next.supplementalInputs??[]),message];
  const input={...message,role:'user' as const};
  if(next.phase==='tools' && (next.toolCursor??0)<(next.pendingCalls?.length??0)){
    next.replanPending=true;next.pendingInputMessages=[...(next.pendingInputMessages??[]),input];
  }else {next.working.push(input);next.requirementSourceIds=[...(next.requirementSourceIds??[]),message.id];}
  for(const r of next.requirements??[])if(r.verification){r.verificationHistory=[...(r.verificationHistory??[]),r.verification];r.verification=undefined;}
  next.delivery=deliveryReport(next);return next;
}

const kinds = new Set(['file_exists','json','ics','answer_contains','review']);
const versionOf = (r: DeliveryRequirement) => ({ revision:r.revision,title:r.title,sourceId:r.sourceId,sourceQuote:r.sourceQuote,check:r.check,at:r.at });
const error = (e: unknown): ToolResult => ({ok:false,content:'',error:e instanceof Error ? e.message : String(e)});
export function updateRequirements(state: RunState, args: Record<string,unknown>): ToolResult {
  try {
    if (!Array.isArray(args.requirements) || !args.requirements.length || args.requirements.length > 20) throw new Error('提供 1–20 项要求更新；同 id 修订，未提交项保留');
    const next = structuredClone(state.requirements ?? []), seen = new Set<string>();
    for (const raw of args.requirements) {
      const r = raw as DeliveryRequirement;
      if (!r || typeof r.id !== 'string' || !r.id.trim() || r.id.length > 120 || seen.has(r.id)) throw new Error('要求需要唯一 id（最多 120 字符）');
      seen.add(r.id);
      if (typeof r.title !== 'string' || !r.title.trim() || r.title.length > 500) throw new Error('要求标题不能为空，最多 500 字符');
      const source = state.working.find(m => m.id === r.sourceId && m.role === 'user' && state.requirementSourceIds?.includes(m.id));
      if (!source || typeof r.sourceQuote !== 'string' || !r.sourceQuote.trim() || r.sourceQuote.length > 2000 || !source.content.includes(r.sourceQuote)) throw new Error('要求必须引用真实用户消息 ID 和其中的原文；不能引用模型或内部继续指令');
      const c = r.check;
      if (!c || !kinds.has(c.kind)) throw new Error('检查类型无效');
      const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 30 && v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 1000));
      if (!strings(c.contains) || !strings(c.requiredKeys) || (c.count !== undefined && (!Number.isSafeInteger(c.count) || c.count < 0))) throw new Error('检查条件无效');
      if (['file_exists','json','ics'].includes(c.kind) && (typeof c.path !== 'string' || !c.path.trim() || c.path.length > 2000)) throw new Error('文件检查需要真实绝对路径');
      if (c.kind === 'answer_contains' && !c.contains?.length) throw new Error('答案匹配需要 contains；它只核对字面内容，不证明语义正确');
      const check: AcceptanceCheck = {kind:c.kind,...(c.path ? {path:c.path}:{}),...(c.contains ? {contains:c.contains}:{}),...(c.requiredKeys ? {requiredKeys:c.requiredKeys}:{}),...(c.count !== undefined ? {count:c.count}:{})};
      if (r.milestoneId && !state.milestones?.some(m => m.id === r.milestoneId)) throw new Error('里程碑 ID 不存在');
      const index = next.findIndex(n => n.id === r.id), old = next[index];
      if (old && (r.sourceId !== old.sourceId || r.sourceQuote !== old.sourceQuote || r.title !== old.title || JSON.stringify(check) !== JSON.stringify(old.check))) {
        const oldIndex = state.working.findIndex(m => m.id === old.sourceId), newIndex = state.working.findIndex(m => m.id === r.sourceId);
        const sameConditions = r.title === old.title && r.sourceId === old.sourceId && r.sourceQuote === old.sourceQuote && JSON.stringify({...check,path:undefined}) === JSON.stringify({...old.check,path:undefined});
        if (newIndex <= oldIndex && !sameConditions && (old.verification || old.verificationHistory?.length)) throw new Error('已核验要求的变更需要更新的用户消息作为依据；不能为获得通过而放宽检查');
      }
      const unchanged = old && r.title === old.title && r.sourceId === old.sourceId && r.sourceQuote === old.sourceQuote && JSON.stringify(check) === JSON.stringify(old.check);
      const item: DeliveryRequirement = unchanged ? {...old,milestoneId:r.milestoneId ?? old.milestoneId} : {
        id:r.id,title:r.title,sourceId:r.sourceId,sourceQuote:r.sourceQuote,check,milestoneId:r.milestoneId,
        revision:(old?.revision ?? 0)+1,at:Date.now(),history:old ? [...old.history,versionOf(old)] : [],
        verificationHistory:[...(old?.verificationHistory ?? []),...(old?.verification ? [old.verification]:[])],
      };
      if (index < 0) next.push(item); else next[index] = item;
    }
    if (next.length > 20) throw new Error('最多 20 项验收要求；请修订现有项');
    state.requirements = next; state.delivery = deliveryReport(state);
    return {ok:true,content:JSON.stringify(next),summary:`记录 ${next.length} 项交付要求`};
  } catch(e) { return error(e); }
}

export async function verifyRequirements(state: RunState, args: Record<string,unknown>, inspect: (check: AcceptanceCheck) => Promise<ToolResult>): Promise<ToolResult> {
  try {
    if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 20 || args.ids.some(id => typeof id !== 'string' || !state.requirements?.some(r => r.id === id))) throw new Error('ids 必须引用已有要求');
    const next = structuredClone(state.requirements ?? []), results: {id:string;verification:RequirementVerification}[] = [];
    for (const id of [...new Set(args.ids as string[])]) {
      const r = next.find(r => r.id === id)!;
      let v: RequirementVerification;
      if (r.check.kind === 'review') {
        const reviews = Array.isArray(args.reviews) ? args.reviews : [];
        const review = reviews.find((x: {id?:string}) => x.id === id) as {status?:string;detail?:string;evidence?:string[]} | undefined;
        const evidence = review?.evidence;
        const valid = Array.isArray(evidence) && evidence.length > 0 && evidence.length <= 20 && evidence.every(e => typeof e === 'string' && (
          state.steps?.some(s => (s.id === e || s.callId === e) && s.status === 'ok' && !['update_plan','update_requirements','verify_requirements'].includes(s.name)) ||
          (e.startsWith('text:') && e.length > 15 && state.content?.includes(e.slice(5)))));
        if (!review || !['passed','failed','unverifiable'].includes(review.status ?? '') || typeof review.detail !== 'string' || review.detail.length < 8 || review.detail.length > 1600 || (review.status !== 'unverifiable' && !valid)) throw new Error(`要求 ${id} 的模型复核需要具体覆盖说明及已有证据；无法核验时明确标记 unverifiable`);
        v = {revision:r.revision,status:review.status as RequirementVerification['status'],method:'model',detail:review.detail,evidence:valid ? evidence! : [],at:Date.now()};
      } else if (r.check.kind === 'answer_contains') {
        const missing = r.check.contains!.filter(s => !(state.content ?? '').includes(s));
        v = {revision:r.revision,status:missing.length ? 'failed':'passed',method:'program',detail:missing.length ? `答案缺少指定原文：${missing.join('、')}`:'已匹配指定原文；仅证明字面覆盖，不证明内容正确或任务完整',evidence:['answer'],at:Date.now()};
      } else {
        const result = await inspect(r.check);
        let data: {status?:string;detail?:string} = {};
        try { data = JSON.parse(result.content); } catch { /* A transport error is not a failed content check. */ }
        v = {revision:r.revision,status:['passed','failed','unverifiable'].includes(data.status ?? '') ? data.status as RequirementVerification['status']:'unverifiable',method:'program',
          detail:data.detail ?? result.error ?? '当前环境无法核验该文件',evidence:[r.check.path!],at:Date.now()};
      }
      if (r.verification) r.verificationHistory = [...(r.verificationHistory ?? []),r.verification];
      r.verification = v; results.push({id,verification:v});
    }
    state.requirements = next; state.delivery = deliveryReport(state);
    return {ok:true,content:JSON.stringify(results),summary:`已核验 ${results.length} 项：${results.filter(r => r.verification.status === 'passed').length} 项通过`};
  } catch(e) { return error(e); }
}

export function deliveryReport(state: RunState): DeliveryReport {
  const requirements = state.requirements ?? [];
  const status = requirements.some(r => r.verification?.revision === r.revision && r.verification.status === 'failed') ? 'failed'
    : !requirements.length || requirements.some(r => !r.verification || r.verification.revision !== r.revision) ? 'unchecked'
    : requirements.some(r => r.verification?.status === 'unverifiable') ? 'unverifiable':'passed';
  return {requirements:structuredClone(requirements),coverage:requirements.length ? 'model_defined':'not_defined',status,at:Date.now()};
}

export function recoveryInfo(state: RunState): RecoveryInfo {
  const blockedNotes=(state.milestones??[]).filter(m=>m.status==='blocked'&&m.note).map(m=>m.note).join('；');
  const reason = (state.reason || '执行记录已保存，可以从中断处继续')+(blockedNotes?`。具体阻塞：${blockedNotes}`:'');
  const current = state.pendingCalls?.[state.toolCursor ?? 0];
  let target: string | undefined;
  try { const a = JSON.parse(current?.arguments ?? '{}'); target = typeof a.path === 'string' ? a.path : typeof a.url === 'string' ? a.url : undefined; } catch { /* show tool name */ }
  const kind: RecoveryInfo['kind'] = state.uncertainCallId ? 'uncertain' : state.stoppedBy === 'user' ? 'user'
    : /缺少|资料不足|需要补充/.test(blockedNotes) ? 'input'
    : /验收|核实到实际|未完成里程碑/.test(reason) ? 'verification' : /预算|阶段轮次/.test(reason) ? 'budget'
    : /额度|限流|429/.test(reason) ? 'quota' : /授权|权限|拒绝/.test(reason) ? 'permission'
    : /缺少|资料|输入|没有可用工具/.test(reason) ? 'input' : /连接|网络|超时|中断|关闭/.test(reason) ? 'connection':'other';
  const remaining = [...(state.requirements ?? []).filter(r => r.verification?.status !== 'passed').map(r => r.title),
    ...(state.milestones ?? []).filter(m => m.status !== 'completed').map(m => m.title)];
  const hints: Record<RecoveryInfo['kind'],string> = {
    user:'准备好后接着跑，也可以补充要求。',quota:'额度恢复后接着跑；已有结果会继续使用。',budget:'接着跑将开启新的执行阶段，仍使用现有结果。',
    input:'补充缺少的信息后接着跑；工具能力可在配置中调整。',permission:'先检查所需权限，或补充一种已获准的执行方式。',
    uncertain:'先核实下列操作是否生效；重试可能重复修改或提交。',verification:'查看未通过或未检查的要求，接着跑以修复，也可以补充信息。',
    connection:'连接恢复后接着跑；已确认完成的操作不会重新执行。',other:'查看具体原因，补充信息或调整配置后接着跑。',
  };
  return {kind,reason,next:hints[kind],target:target ?? current?.name,completed:(state.milestones ?? []).filter(m => m.status === 'completed').map(m => m.title),
    remaining:[...new Set(remaining)],outputPaths:[...new Set((state.steps ?? []).flatMap(s => s.files ?? []).filter(f => f.direction === 'output').map(f => f.path))],canAddInput:kind !== 'uncertain'};
}
