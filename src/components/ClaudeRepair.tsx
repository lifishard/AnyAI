import React from 'react';
import { desktop } from '../lib/transport';
import type { ClientStatus } from '../lib/connections';
export default function ClaudeRepair({onResult,disabled=false}:{onResult?:(status:ClientStatus)=>void;disabled?:boolean}) {
  const [busy,setBusy]=React.useState(false),[message,setMessage]=React.useState('');
  if(!desktop()?.claudeRepair)return null;
  return <div style={{fontSize:12,lineHeight:1.6,margin:'8px 0'}}>
    <button className="btn sm" disabled={busy||disabled} onClick={async()=>{setBusy(true);setMessage('正在检查 Claude Code CLI 和当前连接配置…');try{const r=await desktop()!.claudeRepair();setMessage(onResult?'':r.message);onResult?.(r);}catch{setMessage('恢复检查失败，请稍后重试。');}finally{setBusy(false);}}}>{busy?'正在检查 Claude Code…':'修复 Claude Code 连接'}</button>
    <div className="hint">检查程序和现有账号或 API 配置；仅恢复已明确配置的本机服务。</div>
    <div role="status" aria-live="polite">{message}</div>
  </div>;
}
