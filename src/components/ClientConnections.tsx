import React from 'react';
import {desktop} from '../lib/transport';
import {CLIENT_LABELS,type ClientKind,type ClientSelection,type ClientStatus} from '../lib/connections';
import type {AppSettings} from '../types';
import './ClientConnections.css';
import ClaudeRepair from './ClaudeRepair';
let sessionStatuses:Partial<Record<ClientKind,ClientStatus>>={};

export default function ClientConnections({selection,onSelect,settings,onSettings}:{selection?:ClientSelection;onSelect:(value:ClientSelection|undefined)=>void;settings:AppSettings;onSettings:(patch:Partial<AppSettings>)=>void}) {
  const [statuses,setStatusState]=React.useState<Partial<Record<ClientKind,ClientStatus>>>(()=>sessionStatuses);
  const setStatuses=(update:(previous:Partial<Record<ClientKind,ClientStatus>>)=>Partial<Record<ClientKind,ClientStatus>>)=>setStatusState(previous=>{const next=update(previous);sessionStatuses=next;return next;});
  const [busy,setBusy]=React.useState<ClientKind|null>(null),[error,setError]=React.useState('');
  const act=async(kind:ClientKind,connect=false)=>{const api=desktop();if(!api)return;setBusy(kind);setError('');try{const result=await (connect?api.conversationClientConnect(kind):api.conversationClientCheck(kind));setStatuses(s=>({...s,[kind]:result}));if(connect&&result.status==='ready')onSelect({kind,model:result.models[0]?.id || 'default',effort:result.models[0]?.defaultEffort});}catch(e){setError(String(e));}finally{setBusy(null);}};
  const pick=async(kind:ClientKind)=>{const file=await desktop()?.pickClientBinary();if(!file)return;onSettings(kind==='claude'?{tools:{...settings.tools,claudeBin:file}}:{clients:{codexBin:settings.clients?.codexBin || '',...settings.clients,[kind+'Bin']:file}});setStatuses(s=>({...s,[kind]:undefined}));};
  return <section className="client-connections" aria-label="连接来源">
    <div className="client-heading"><strong>连接来源</strong><button className={`btn sm ${selection?'ghost':''}`} onClick={()=>onSelect(undefined)}>API 凭据</button></div>
    {!desktop()?<p className="hint">本机客户端连接需要桌面版。网页版可使用下方 API 凭据。</p>:<>
      <p className="hint">选择在本机执行任务的客户端。执行能力来自客户端，模型与授权来自它各自的连接配置。</p>
      {(['codex','claude','kimi'] as ClientKind[]).map(kind=>{
        const status=statuses[kind],selected=selection?.kind===kind;
        return <div key={kind} className={`client-row${selected?' selected':''}`}>
          <div className="client-heading"><strong>{CLIENT_LABELS[kind]}</strong><span className="hint">{kind==='claude'&&status?.status==='ready'?'客户端就绪':status?{missing:'未安装',installed:'已安装',login_required:'待登录',ready:'可用',error:'待检查',waiting_login:'等待登录'}[status.status]:'尚未检测'}</span></div>
          {kind==='claude'&&<p className="hint">CLI 任务执行器，可使用 Claude 账号或兼容 API／网关。这里调用 Claude Code，不连接 Claude Desktop 的聊天会话。</p>}
          <p>{status?.message || (kind==='codex'?'官方登录后读取订阅提供的模型。':kind==='claude'?'检测后显示当前账号或 API 来源；模型映射沿用你自己的 Claude Code 配置。':'通过官方 ACP 接口连接。')}</p>
          {kind==='kimi'&&<p className="hint">Work 当前仅支持审批工作目录内的文件编辑；命令、终端和网络操作暂不开放。</p>}
          {kind==='claude'&&<ClaudeRepair disabled={busy!==null} onResult={r=>setStatuses(s=>({...s,claude:r}))}/>}
          <div className="client-actions"><button className="btn sm" disabled={busy!==null} onClick={()=>void act(kind,true)}>{busy===kind?'连接中…':'一键连接'}</button><button className="btn sm ghost" disabled={busy!==null} onClick={()=>void act(kind)}>重新检测</button>
            {kind==='codex' && status?.status!=='missing' && status?.status!=='ready' && <button className="btn sm" disabled={busy!==null} onClick={()=>void act(kind,true)}>官方登录</button>}
            <button className="btn sm ghost" disabled={busy!==null} onClick={()=>void pick(kind)}>选择程序</button>
            {status?.status==='ready'&&<button className="btn sm" onClick={()=>onSelect({kind,model:status.models[0]?.id || 'default',effort:status.models[0]?.defaultEffort})}>{selected?'已选用':'使用此连接'}</button>}
          </div>
          {selected&&<div className="client-model-fields"><label>模型<select aria-label="本机模型" value={selection.model} onChange={e=>{const m=status?.models.find(m=>m.id===e.target.value);onSelect({...selection,model:e.target.value,effort:m?.defaultEffort});}}>
            {!status?.models.some(m=>m.id===selection.model)&&<option value={selection.model}>{selection.model==='default'?'官方客户端默认模型':selection.model}</option>}
            {status?.models.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
          </select></label><label>思考强度<select aria-label="思考强度" value={selection.effort || ''} onChange={e=>onSelect({...selection,effort:e.target.value || undefined})}>
            <option value="">官方默认</option>{(status?.models.find(m=>m.id===selection.model)?.efforts || (selection.effort?[selection.effort]:[])).map(e=><option key={e} value={e}>{e}</option>)}
          </select></label></div>}
        </div>;
      })}
      <div className="client-row" aria-label="Claude Desktop 桌面应用"><div className="client-heading"><strong>Claude Desktop</strong><span className="hint">独立桌面应用 · 未接入</span></div><p>桌面中的聊天会话与 Claude Code CLI 分开。当前灯芯AI 没有接管这些聊天会话，不能将桌面程序选作本任务的执行器。</p></div>
      <p className="hint">账号登录与 API 凭据按所选客户端配置。Chat 不允许改文件；Work 沿用各客户端支持的权限机制，未支持的操作会暂停。</p>
    </>}
    <div className="client-row"><strong>Grok · 其他 AI</strong><p>在 API 凭据中添加官方密钥或兼容服务地址。Grok 地址：https://api.x.ai/v1。消费版订阅不等于 API 授权。</p><button className="btn sm ghost" onClick={()=>onSelect(undefined)}>使用 API 接入</button></div>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
