import React from 'react';
import type {AppSettings} from '../types';
import {desktop} from '../lib/transport';
import type {NativeAiState,NativeAiInput} from '../lib/native-ai';
import './NativeAiPanel.css';
const labels={waiting:'等待主脑接任务',working:'处理中',completed:'已收到最终结果',cancelled:'已取消'};
const jobLabels={running:'运行中',completed:'已返回',failed:'调用失败',uncertain:'结果未确认'};
export default function NativeAiPanel({settings}:{settings:AppSettings}) {
  const [state,setState]=React.useState<NativeAiState>({connections:[],tasks:[]});
  const [message,setMessage]=React.useState(''),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
  const [expanded,setExpanded]=React.useState(false),[goal,setGoal]=React.useState(''),[maxJobs,setMaxJobs]=React.useState(6);
  const [workers,setWorkers]=React.useState<NativeAiInput['workers']>([{profileId:settings.keyProfiles[0]?.id || '',model:'',outputField:'max_tokens'}]);
  const [prompt,setPrompt]=React.useState(''),[selected,setSelected]=React.useState('');
  const refresh=React.useCallback(async()=>{const api=desktop();if(api?.nativeAiState)setState(await api.nativeAiState());},[]);
  React.useEffect(()=>{let mounted=true;const poll=async()=>{try{const next=await desktop()?.nativeAiState?.();if(mounted&&next)setState(next);}catch(e){if(mounted)setError(String(e));}};void poll();const timer=setInterval(()=>void poll(),3000);return()=>{mounted=false;clearInterval(timer);};},[]);
  const act=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');try{await fn();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const connection=state.connections.find(c=>c.provider==='claude-desktop');
  const task=state.tasks.find(t=>t.id===selected) || state.tasks[0];
  const configure=()=>act(async()=>{const result=await desktop()!.nativeAiConfigure();setState(result.state);setMessage(result.message);setExpanded(true);try{await desktop()!.nativeAiOpen('claude-desktop');}catch{setMessage(result.message+' 如未打开，请手动启动已安装的 Claude Desktop。');}});
  const create=()=>act(async()=>{const result=await desktop()!.nativeAiCreate({provider:'claude-desktop',goal,workers,maxJobs,maxOutputTokens:2048});setSelected(result.task.id);setPrompt(result.prompt);setGoal('');await refresh();setMessage('任务已保存。请在打开的 Claude Desktop 中发送预填消息，并允许使用 wickrun_ai 连接器；进度和成果会回到这里。');try{await desktop()!.nativeAiOpen('claude-desktop',result.task.id);}catch{setMessage('任务已保存，但未能打开 Claude Desktop。请手动打开，复制下方任务消息发送。');}});
  return <div className="client-row native-ai-panel" aria-label="Claude Desktop 协作">
    <div className="client-heading"><strong>Claude Desktop · 主脑协作</strong><span className="hint" role="status">{connection?.connected?'MCP 已连接':connection?.configured?'已配置 · 等待连接':'尚未配置'}</span></div>
    <p>让桌面中的 Claude 拆解任务、调度你选定的 API 工作模型，再把成果交回灯芯AI。Claude 的账号登录与工具授权在官方桌面应用中完成。</p>
    <div className="client-actions"><button className="btn sm" disabled={busy} onClick={()=>void configure()}>{connection?.configured?'修复连接配置并打开':'一键配置并打开'}</button><button className="btn sm ghost" onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>{expanded?'收起协作面板':'任务与结果'}</button></div>
    {connection?.connected&&<p className="hint">连接客户端：{connection.client}。发送任务后，以实际进度及回传结果确认执行。</p>}
    {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
    {expanded&&<div className="native-ai-content">
      <p className="hint">首次配置后需要完全退出并重新打开 Claude Desktop。若未安装，请先从 <a href="https://claude.ai/download" target="_blank" rel="noreferrer">Claude 官网</a>安装。每个新任务仍需你在 Claude 中点一次发送。</p>
      <label>交给主脑的任务<textarea aria-label="交给主脑的任务" value={goal} onChange={e=>setGoal(e.target.value)} maxLength={24000} rows={4} placeholder="描述目标、材料和验收要求…"/></label>
      <p className="hint">授权以下模型处理子任务。请求使用所选 API 凭据，每次最多输出 2048 tokens；任务内容会发送给这些模型。工作模型本轮提供文字结果。</p>
      {workers.map((worker,index)=><div className="native-worker" key={index}>
        <label>API 凭据<select aria-label={`工作模型 ${index+1} 凭据`} value={worker.profileId} onChange={e=>setWorkers(ws=>ws.map((w,i)=>i===index?{...w,profileId:e.target.value}:w))}>{!worker.profileId&&<option value="">请选择</option>}{settings.keyProfiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>模型 ID<input aria-label={`工作模型 ${index+1} ID`} list={`native-models-${index}`} value={worker.model} onChange={e=>setWorkers(ws=>ws.map((w,i)=>i===index?{...w,model:e.target.value}:w))} placeholder="选择已有模型或填写 ID"/><datalist id={`native-models-${index}`}>{[...new Map([...(settings.cachedModels[worker.profileId] || []),...(settings.customModels[worker.profileId] || [])].map(m=>[m.id,m])).values()].map(m=><option value={m.id} key={m.id}/>)}</datalist></label>
        <details><summary>输出参数</summary><select aria-label={`工作模型 ${index+1} 输出参数`} value={worker.outputField} onChange={e=>setWorkers(ws=>ws.map((w,i)=>i===index?{...w,outputField:e.target.value as 'max_tokens'|'max_completion_tokens'}:w))}><option value="max_tokens">max_tokens（常用兼容接口）</option><option value="max_completion_tokens">max_completion_tokens</option></select></details>
        {workers.length>1&&<button className="btn sm ghost" onClick={()=>setWorkers(ws=>ws.filter((_,i)=>i!==index))}>移除此模型</button>}
      </div>)}
      <div className="client-actions"><button className="btn sm ghost" disabled={workers.length>=8} onClick={()=>setWorkers(ws=>[...ws,{profileId:settings.keyProfiles[0]?.id || '',model:'',outputField:'max_tokens'}])}>添加工作模型</button><label>最多调用次数<input aria-label="最多调用次数" type="number" min={1} max={20} value={maxJobs} onChange={e=>setMaxJobs(Number(e.target.value))}/></label></div>
      <button className="btn sm" disabled={busy||!goal.trim()||workers.some(w=>!w.profileId||!w.model.trim())} onClick={()=>void create()}>创建任务并打开 Claude</button>
      {prompt&&<details><summary>备用任务消息（未自动填入时复制）</summary><textarea aria-label="备用任务消息" value={prompt} readOnly rows={5}/><button className="btn sm ghost" onClick={()=>void act(async()=>{await navigator.clipboard.writeText(prompt);setMessage('任务消息已复制。');})}>复制任务消息</button></details>}
      {state.tasks.length>0&&<label>任务记录<select aria-label="原生 AI 任务记录" value={task?.id || ''} onChange={e=>{setSelected(e.target.value);setPrompt('');}}>{state.tasks.map(t=><option key={t.id} value={t.id}>{labels[t.status]} · {t.goal.slice(0,42)}</option>)}</select></label>}
      {task&&<article className="native-task"><div className="client-heading"><strong>{labels[task.status]}</strong><span>{task.jobs.length} / {task.maxJobs} 次调用</span></div><p>{task.goal}</p>
        <div className="client-actions">{['waiting','working'].includes(task.status)?<><button className="btn sm ghost" disabled={busy} onClick={()=>void act(async()=>{const result=await desktop()!.nativeAiOpen(task.provider,task.id);setPrompt(result.prompt);})}>在 Claude 中继续</button><button className="btn sm ghost" disabled={busy} onClick={()=>void act(async()=>setState(await desktop()!.nativeAiCancel(task.id)))}>取消任务</button></>:<button className="btn sm ghost" disabled={busy} onClick={()=>void act(async()=>setState(await desktop()!.nativeAiRemove(task.id)))}>删除记录</button>}</div>
        {task.progress.length>0&&<p className="native-progress">{task.progress.at(-1)?.text}</p>}
        {task.jobs.map(job=><details key={job.id}><summary>{task.workers.find(w=>w.id===job.workerId)?.model} · {jobLabels[job.status]}</summary><p>{job.prompt}</p><pre>{job.text || job.error || '等待工作模型返回…'}</pre></details>)}
        {task.result&&<div className="native-result"><strong>主脑交回的成果</strong><pre>{task.result}</pre><button className="btn sm ghost" onClick={()=>void act(async()=>{await navigator.clipboard.writeText(task.result!);setMessage('成果已复制。');})}>复制成果</button><button className="btn sm ghost" onClick={()=>void act(async()=>{const file=await desktop()!.saveArtifact('Claude-协作成果.md',task.result!);if(file)setMessage('成果已保存。');})}>保存成果</button></div>}
      </article>}
    </div>}
  </div>;
}
