import React from 'react';
import { Modal } from './ui';
import { clearObservations, observationSnapshot, isCurrentFeedback, type ObservationStore } from '../lib/observations';
import { acceptanceLabel, buildAnalysisFiles, filterTasks, outcomeLabel, redactSelectedText, statusLabel, summarizeTasks, type ObservationFilter } from '../lib/observation-export';
import { zipTextFiles } from '../lib/export-zip';
import { runRecord, runTitle } from '../lib/runs';
import { desktop } from '../lib/transport';

export default function ObservationPanel({onClose,onOpenTask}:{onClose:()=>void;onOpenTask:(conversationId:string,answerId:string)=>void}) {
  const [store,setStore]=React.useState<ObservationStore>();const [from,setFrom]=React.useState(''),[to,setTo]=React.useState('');
  const [model,setModel]=React.useState(''),[version,setVersion]=React.useState('');const [selected,setSelected]=React.useState('');
  const [hideModels,setHideModels]=React.useState(false),[include,setInclude]=React.useState<string[]>([]);
  const [preview,setPreview]=React.useState<Record<string,string>>(),[previewFile,setPreviewFile]=React.useState('report.md');
  const [error,setError]=React.useState(''),[saved,setSaved]=React.useState(''),[busy,setBusy]=React.useState(false),[clearConfirm,setClearConfirm]=React.useState(false);
  React.useEffect(()=>{let live=true;let timer:ReturnType<typeof setTimeout>|undefined;const read=()=>{void observationSnapshot().then(s=>{if(live)setStore(s);}).catch(()=>{if(live)setError('统计暂时无法读取');});};const update=()=>{if(timer)clearTimeout(timer);timer=setTimeout(read,200);};read();window.addEventListener('anyai:observations',update);return()=>{live=false;if(timer)clearTimeout(timer);window.removeEventListener('anyai:observations',update);};},[]);
  const filter:ObservationFilter=React.useMemo(()=>({from:from?new Date(from+'T00:00:00').getTime():undefined,to:to?new Date(to+'T23:59:59.999').getTime():undefined,model:model||undefined,version:version||undefined}),[from,to,model,version]);
  const tasks=React.useMemo(()=>store?filterTasks(store.tasks,filter):[],[store,filter]);const summary=React.useMemo(()=>summarizeTasks(tasks),[tasks]);
  const selectedTask=tasks.find(t=>t.id===selected),record=selectedTask?runRecord(selectedTask.recordId):undefined;
  const snippets=React.useMemo(()=>record?[
    {id:'question',label:'用户原始要求',text:record.question.content},
    {id:'answer',label:'已输出的答案',text:record.state.content??''},
    ...(record.state.errorInfo?[{id:'error',label:'错误说明',text:record.state.errorInfo.detail}]:[]),
    ...(record.state.supplementalInputs??[]).map((s,i)=>({id:`input-${i}`,label:`用户补充 ${i+1}`,text:s.content})),
    ...(record.state.requirements??[]).map((r,i)=>({id:`requirement-${i}`,label:`验收说明 ${i+1}`,text:JSON.stringify({title:r.title,sourceQuote:r.sourceQuote,check:r.check,verification:r.verification,verificationHistory:r.verificationHistory,history:r.history})})),
    ...(record.state.steps??[]).filter(s=>s.output||s.error).map((s,i)=>({id:`tool-${i}`,label:`工具结果 ${i+1} · ${s.name}`,text:s.error??s.output??''})),
  ]:[],[record?.state.at,record?.id]);
  const build=()=>{
    if(!store)return;setError('');setSaved('');
    const chosen=selectedTask?[selectedTask]:tasks;
    const files=buildAnalysisFiles(store,chosen,filter,hideModels);
    if(selectedTask){
      files['diagnostic.json']=JSON.stringify({taskId:selectedTask.id,observationOnly:true,selectedSnippets:snippets.filter(s=>include.includes(s.id)).map(s=>({label:s.label,text:redactSelectedText(s.text.slice(0,20000)),truncated:s.text.length>20000})),
        note:'只包含明确选择的片段；不包含凭据存储或思考内容。常见凭据已替换，但分享前仍需检查自行选择的正文。'},null,2);
      const manifest=JSON.parse(files['manifest.json']);manifest.files.push('diagnostic.json');manifest.selectedSnippets=include.length;manifest.redaction.body=include.length>0;files['manifest.json']=JSON.stringify(manifest,null,2);
    }
    setPreview(files);setPreviewFile(selectedTask&&include.length?'diagnostic.json':'report.md');
  };
  const save=async()=>{
    if(!preview)return;setBusy(true);setError('');
    try{
      const bytes=zipTextFiles(preview),name=`wickrunAI-${preview['diagnostic.json']?'task-diagnostic':'usage-analysis'}-${new Date().toISOString().slice(0,10)}.zip`;
      const bridge=desktop();
      if(bridge?.saveAnalysisExport){const file=await bridge.saveAnalysisExport(name,bytes);if(file)setSaved(file.path);}
      else{const url=URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer],{type:'application/zip'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setSaved('已交给浏览器下载，可将导出包交给助手分析。');}
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  };
  return <Modal title="任务记录与分析" onClose={onClose} wide><div className="modal-body observation-panel">
    <p>先看任务实际结果，再定位问题。统计保留最近 90 天、最多 500 个任务，并受 4MB 索引容量限制；未反馈或未继续均不算失败。数据保存于本机。</p>
    {store?.lastError?<p className="observation-error" role="alert">{store.lastError}</p>:null}
    <div className="observation-filters">
      <label>任务开始日期<input type="date" value={from} onChange={e=>{setFrom(e.target.value);setPreview(undefined);}}/></label>
      <label>截至日期<input type="date" value={to} onChange={e=>{setTo(e.target.value);setPreview(undefined);}}/></label>
      <label>曾使用的模型<select value={model} onChange={e=>{setModel(e.target.value);setPreview(undefined);}}><option value="">全部模型</option>{[...new Set(store?.tasks.flatMap(t=>t.attempts.map(a=>a.model))??[])].map(m=><option key={m}>{m}</option>)}</select></label>
      <label>曾使用的版本<select value={version} onChange={e=>{setVersion(e.target.value);setPreview(undefined);}}><option value="">全部版本</option>{[...new Set(store?.tasks.flatMap(t=>t.attempts.map(a=>a.appVersion))??[])].map(v=><option key={v}>{v}</option>)}</select></label>
    </div>
    <div className="observation-summary" aria-live="polite">
      <strong>当前范围：{summary.total} 个任务</strong>
      <p>{Object.entries(summary.stateCounts).map(([k,n])=>`${statusLabel[k]??'未知'} ${n}`).join(' · ')||'新任务运行后会逐步记录；没有记录不代表没有使用过。'}</p>
      <p>已列验收条件全部通过 {summary.accepted} 个；未建清单或含未检查条件 {summary.unchecked} 个；含未通过条件 {summary.failedAcceptance} 个；含无法核验条件 {summary.unverifiable} 个。后三类可重叠。</p>
      <p>当前阶段的用户反馈 {summary.feedback}/{summary.total} 个任务：可用 {summary.usable}、部分可用 {summary.partial}、未解决 {summary.unresolved}。未反馈结果未知。{summary.historicalFeedback?`另有 ${summary.historicalFeedback} 个任务只保留较早阶段的反馈。`:''}</p>
    </div>
    <div className="observation-task-list">{tasks.slice().reverse().map(t=><article key={t.id} className={selected===t.id?'selected':''}>
      <div><strong>{runTitle(t.recordId)??'已保存的任务'}</strong><small> · {new Date(t.startedAt).toLocaleString()}</small><p>{statusLabel[t.status]??'未知'} · {acceptanceLabel(t)} · {t.feedback?(isCurrentFeedback(t)?'':'较早阶段反馈：')+outcomeLabel[t.feedback.outcome]:'未反馈'}</p>
        <small>续跑 {t.resumeCount} 次 · 暂停 {t.pauseCount} 次 · {t.attempts.map(a=>a.model).filter((x,i,a)=>a.indexOf(x)===i).join(' → ')}</small>
        {t.missing.length||t.droppedEvents||t.detailLimitReached?<p className="hint">有观测缺口或明细裁剪，导出报告中会注明。</p>:null}</div>
      <div className="recovery-actions"><button className="btn sm" onClick={()=>onOpenTask(t.conversationId,t.answerId)}>查看任务</button><button className="btn sm" aria-pressed={selected===t.id} onClick={()=>{setSelected(selected===t.id?'':t.id);setInclude([]);setPreview(undefined);}}>选择排查</button></div>
    </article>)}</div>
    <div className="observation-export"><strong>{selectedTask?'导出指定任务排查包':'导出使用分析包'}</strong>
      <p>默认包含状态、检查方法、用量和事件关联；不包含对话正文、完整路径、接口地址、凭据或思考内容。</p>
      <label><input type="checkbox" checked={hideModels} onChange={e=>{setHideModels(e.target.checked);setPreview(undefined);}}/> 隐藏模型名称</label>
      {selectedTask?<><button className="btn sm ghost" onClick={()=>{setSelected('');setInclude([]);setPreview(undefined);}}>改为导出当前范围全部任务</button>
        <details><summary>选择需要分享的具体片段（可选）</summary><p>仅在需要核对内容时选择。常见凭据会替换，请在导出预览中检查剩余私人信息；每个片段最多 20,000 字符。</p>
          {snippets.map(s=><label className="observation-snippet" key={s.id}><input type="checkbox" checked={include.includes(s.id)} onChange={e=>{setInclude(old=>e.target.checked?[...old,s.id]:old.filter(x=>x!==s.id));setPreview(undefined);}}/>{s.label}</label>)}
        </details></>:null}
      <div className="recovery-actions"><button className="btn sm primary" disabled={!tasks.length||busy} onClick={build}>生成导出预览</button></div>
      {preview?<div className="export-preview"><label>预览文件<select value={previewFile} onChange={e=>setPreviewFile(e.target.value)}>{Object.keys(preview).map(name=><option key={name}>{name}</option>)}</select></label>
        <pre>{preview[previewFile]?.slice(0,100000)}</pre>{preview[previewFile]?.length>100000?<p>预览显示前 100,000 字符，导出包含完整文件。</p>:null}
        <button className="btn sm primary" disabled={busy} onClick={()=>void save()}>保存导出包</button><small> 保存当前预览快照；不会自动上传。</small>
      </div>:null}
      {saved?<p role="status" className="delivery-path">{saved}</p>:null}{error?<p role="alert" className="observation-error">{error}</p>:null}
    </div>
    <details className="observation-retention"><summary>记录范围与清理</summary><p>当前索引自 {store?new Date(store.createdAt).toLocaleString():'—'} 开始；此前任务不自动推断成功。累计裁剪 {store?.droppedTasks??0} 个任务、统计读写问题 {store?.writeFailures??0} 次。每任务最多保留 200 条事件；超过追踪上限后仅更新汇总并标明缺口。删除对话会删除关联统计。</p>
      {clearConfirm?<><p>清空会删除统计和反馈，并重置导出标识；原任务和文件仍保留。旧任务不会重新进入统计。</p><button className="btn sm" onClick={()=>{void clearObservations().then(()=>{setPreview(undefined);setSelected('');setInclude([]);setClearConfirm(false);});}}>确认清空统计</button><button className="btn sm ghost" onClick={()=>setClearConfirm(false)}>取消</button></>:<button className="btn sm" onClick={()=>setClearConfirm(true)}>清空统计与反馈</button>}
    </details>
  </div></Modal>;
}
