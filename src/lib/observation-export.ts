import type { ObservationStore, TaskObservation } from './observations';
import { MAX_EVENTS, MAX_TASKS, RETENTION_DAYS, MAX_INDEX_BYTES, isCurrentFeedback } from './observations';

export interface ObservationFilter {from?:number;to?:number;model?:string;version?:string}
export const statusLabel:Record<string,string>={completed:'执行结束',paused:'已暂停',running:'执行中',waiting:'等待额度',awaiting_user:'等待用户确认',interrupted:'中断待核实',unknown:'状态未知'};
export const outcomeLabel={usable:'确认可用',partial:'部分可用',unresolved:'未解决'};
export function filterTasks(tasks:TaskObservation[],filter:ObservationFilter):TaskObservation[]{
  return tasks.filter(t=>(filter.from===undefined||t.startedAt>=filter.from)&&(filter.to===undefined||t.startedAt<=filter.to)&&
    (!filter.model||t.attempts.some(a=>a.model===filter.model))&&(!filter.version||t.attempts.some(a=>a.appVersion===filter.version)));
}
export function acceptanceLabel(t:TaskObservation):string {
  const a=t.acceptance;
  if(!a.total)return '未建立验收清单';
  if(a.failed)return `${a.failed} 项未通过`;
  if(a.unchecked)return `${a.unchecked} 项未检查`;
  if(a.unverifiable)return `${a.unverifiable} 项无法核验`;
  return `已列 ${a.total} 项通过（程序 ${a.program}／模型 ${a.model}）`;
}
export function summarizeTasks(tasks:TaskObservation[]){
  const stateCounts:Record<string,number>={};for(const t of tasks)stateCounts[t.status]=(stateCounts[t.status]??0)+1;
  const feedback=tasks.filter(isCurrentFeedback),accepted=tasks.filter(t=>t.acceptance.total>0&&t.acceptance.passed===t.acceptance.total);
  return {total:tasks.length,stateCounts,accepted:accepted.length,unchecked:tasks.filter(t=>!t.acceptance.total||t.acceptance.unchecked>0).length,
    failedAcceptance:tasks.filter(t=>t.acceptance.failed>0).length,unverifiable:tasks.filter(t=>t.acceptance.unverifiable>0).length,
    feedback:feedback.length,historicalFeedback:tasks.filter(t=>t.feedback&&!isCurrentFeedback(t)).length,usable:feedback.filter(t=>t.feedback?.outcome==='usable').length,partial:feedback.filter(t=>t.feedback?.outcome==='partial').length,unresolved:feedback.filter(t=>t.feedback?.outcome==='unresolved').length,
    paused:tasks.filter(t=>t.pauseCount>0).length,resumed:tasks.filter(t=>t.resumeCount>0).length,resumedEnded:tasks.filter(t=>t.resumeCount>0&&t.status==='completed').length};
}
export function reportMarkdown(store:ObservationStore,tasks:TaskObservation[],filter:ObservationFilter,now=Date.now()):string {
  const s=summarizeTasks(tasks),sum=(f:(t:TaskObservation)=>number)=>tasks.reduce((n,t)=>n+f(t),0);
  const feedback=`${s.feedback}/${s.total} 个任务有当前阶段反馈；其中确认可用 ${s.usable}、部分可用 ${s.partial}、未解决 ${s.unresolved}。另有 ${s.historicalFeedback} 个任务只有较早阶段的反馈，不作为对当前结果的确认。未反馈不计成功或失败，主动反馈的样本可能有选择偏差。`;
  const pauses:Record<string,number>={};for(const t of tasks)for(const [k,n]of Object.entries(t.pauseReasons))pauses[k]=(pauses[k]??0)+n;
  const cause:Record<string,string>={user:'用户暂停',quota:'额度',budget:'阶段预算',input:'缺少信息/能力',permission:'权限',uncertain:'外部结果不确定',verification:'验收',connection:'连接',other:'其他'};
  const failures=tasks.filter(t=>t.feedback?.outcome==='unresolved'||t.feedback?.outcome==='partial'||t.acceptance.failed>0||t.pauseCount>0).slice().sort((a,b)=>b.lastAt-a.lastAt);
  return `# AnyAI 使用分析\n\n生成时间：${new Date(now).toISOString()}。统计单位为任务，续跑阶段归属于原任务。\n\n`+
    `## 实际交付和未解决事项\n\n本次范围 ${s.total} 个任务。${Object.entries(s.stateCounts).map(([k,n])=>`${statusLabel[k]??'未知状态'} ${n}`).join('；')||'暂无记录'}。\n\n`+
    `已列验收条件全部通过 ${s.accepted} 个任务；含未通过条件 ${s.failedAcceptance} 个、未建清单或含未检查条件 ${s.unchecked} 个、含无法核验条件 ${s.unverifiable} 个。这些类别可能重叠，不能相加当成任务总数。清单由模型整理，程序与模型检查的方法见 tasks.jsonl，不能据此断言覆盖全部用户意图。\n\n${feedback}\n\n`+
    `## 主要阻塞与返工线索\n\n${s.paused} 个任务曾暂停，${s.resumed} 个任务已续跑，${s.resumedEnded} 个续跑任务当前执行结束；尚未继续不等于失败。\n\n暂停事件原因：${Object.entries(pauses).map(([k,n])=>`${cause[k]??'其他'} ${n}`).join('；')||'没有观察到暂停'}。这些是事件数，一个任务可能暂停多次。\n\n`+
    `## 时间和用量\n\n已报告输入 ${sum(t=>t.requests.actualInput)} token、输出 ${sum(t=>t.requests.actualOutput)} token；分别有 ${sum(t=>t.requests.missingInput)} 和 ${sum(t=>t.requests.missingOutput)} 个请求缺少对应报告，以上是已知部分，不能当成总成本。\n\n`+
    `输入估算合计 ${sum(t=>t.requests.estimatedInput)} token；输出预留合计 ${sum(t=>t.requests.reservedOutput)} token。预留不是实际消耗，不与实际值相加。无可靠价格时不换算金额。\n\n`+
    `已观测运行分段约 ${Math.round(sum(t=>t.attempts.reduce((n,a)=>n+a.activeMs,0))/1000)} 秒、额度等待分段约 ${Math.round(sum(t=>t.attempts.reduce((n,a)=>n+a.waitMs,0))/1000)} 秒。五分钟以上观测间隔不归因，用户离开时间不计为运行时间。工具耗时与模型请求耗时可能重叠，不能直接相加。\n\n`+
    `## 值得核查的任务\n\n选取规则：当前范围中出现暂停、验收失败或用户反馈部分可用/未解决的全部任务，按最近活动排列；这里最多列 20 个，完整样本见 tasks.jsonl。\n\n`+
    (failures.slice(0,20).map(t=>`- ${t.id}：${statusLabel[t.status]??'未知'}；${acceptanceLabel(t)}；${t.feedback?(isCurrentFeedback(t)?'':'较早阶段反馈：')+outcomeLabel[t.feedback.outcome]:'未反馈'}。`).join('\n')||'当前没有符合以上规则的记录；这不证明所有任务正确。')+
    `\n\n## 数据限制和观察期\n\n记录系统启用时间 ${new Date(store.createdAt).toISOString()}。按任务开始时间筛选 ${filter.from?new Date(filter.from).toISOString():'不限起点'} 至 ${filter.to?new Date(filter.to).toISOString():'导出时'}；反馈和后续事件截至导出时。模型/版本筛选会包含匹配过的整个任务；跨模型续跑不归因给最后模型。\n\n`+
    `累计因保留范围裁剪 ${store.droppedTasks} 个任务；本包所选任务裁剪 ${sum(t=>t.droppedEvents)} 条事件，${tasks.filter(t=>t.detailLimitReached).length} 个任务达到明细追踪上限；发生 ${store.writeFailures} 次统计读写问题。${store.lastError??''}\n\n`+
    `压缩后发生错误只构成排查线索，不能证明因果；不同任务组合不能直接比较模型优劣。默认包不包含任务正文，无法据此判断答案语义正确性。${tasks.some(t=>t.missing.length)?'部分任务有额外观测缺口，详见 tasks.jsonl。':''}\n`;
}
export function buildAnalysisFiles(store:ObservationStore,tasks:TaskObservation[],filter:ObservationFilter={},hideModels=false,now=Date.now()):Record<string,string>{
  const exportTasks=tasks.map(t=>({id:t.id,startedAt:t.startedAt,lastAt:t.lastAt,status:t.status,appVersion:t.appVersion,runtimeVersion:t.runtimeVersion,
    acceptance:t.acceptance,feedback:t.feedback??null,feedbackAppliesToCurrentAttempt:isCurrentFeedback(t),attempts:t.attempts.map(a=>({id:a.id,startedAt:a.startedAt,lastAt:a.lastAt,endedAt:a.endedAt??null,model:hideModels?'hidden':a.model,effort:a.effort,route:a.route,appVersion:a.appVersion,runtimeVersion:a.runtimeVersion,status:a.status,observedActiveMs:a.activeMs,observedQuotaWaitMs:a.waitMs,observedUserWaitMs:a.humanWaitMs??null,contextWindow:a.contextWindow??null,workingBudget:a.workingBudget??null})),
    requests:t.requests,tools:t.tools,compactions:t.compactions,pauseCount:t.pauseCount,resumeCount:t.resumeCount,pauseReasons:t.pauseReasons,supplements:t.supplements,recoveredWrites:t.recoveredWrites,
    missing:t.missing,droppedEvents:t.droppedEvents,droppedAttempts:t.droppedAttempts,detailLimitReached:!!t.detailLimitReached}));
  const events=tasks.flatMap(t=>t.events.map(e=>({id:e.id,taskId:t.id,attemptId:e.attemptId,seq:e.seq,at:e.at,type:e.type,data:e.data})));
  const files:Record<string,string>={'report.md':reportMarkdown(store,tasks,filter,now),'tasks.jsonl':exportTasks.map(t=>JSON.stringify(t)).join('\n'),'events.jsonl':events.map(e=>JSON.stringify(e)).join('\n')};
  files['manifest.json']=JSON.stringify({schemaVersion:1,metricVersion:1,exportEpoch:store.epoch,generatedAt:new Date(now).toISOString(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,observationStartedAt:store.createdAt,
    filter:{...filter,...(hideModels&&filter.model?{model:'hidden'}:{})},tasks:tasks.length,events:events.length,appVersions:[...new Set(tasks.flatMap(t=>t.attempts.map(a=>a.appVersion)))],
    retention:{days:RETENTION_DAYS,tasks:MAX_TASKS,eventsPerTask:MAX_EVENTS,indexBytes:MAX_INDEX_BYTES,attemptsPerTask:100},droppedTasks:store.droppedTasks,writeFailures:store.writeFailures,clearedAt:store.clearedAt??null,
    redaction:{body:false,reasoning:false,credentials:false,fullPaths:false,fullEndpoints:false,modelNames:!hideModels,routeAliases:true},
    identifiers:'Stable within exportEpoch; de-duplicate tasks by id, events by id, keeping the later export snapshot. After clearing statistics a new epoch is used.',
    limitations:['Model-defined acceptance coverage is not proof of complete user intent coverage.','Unanswered feedback is unknown, not success or failure.','Usage reserves are not measured consumption.','Observed timing excludes unobserved gaps over five minutes.'],files:[...Object.keys(files),'manifest.json']},null,2);
  return files;
}

export function redactSelectedText(text:string):string{
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[私钥已移除]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi,'Bearer [已移除]')
    .replace(/\b(?:sk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{12,}/g,'[凭据已移除]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi,'$1[已移除]');
}
