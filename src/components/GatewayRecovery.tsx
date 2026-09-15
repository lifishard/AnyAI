import React from 'react';
import { desktop } from '../lib/transport';
import { canRecoverGateway, type GatewayRecoveryResult } from '../lib/gateway-recovery';
import type { KeyProfile } from '../types';
import './GatewayRecovery.css';

export default function GatewayRecovery({profile,onReady,compact=false}:{profile?:KeyProfile|null;onReady?:(result:GatewayRecoveryResult)=>void;compact?:boolean}) {
  const [busy,setBusy]=React.useState(false),[result,setResult]=React.useState<GatewayRecoveryResult|null>(null);
  const operation=React.useRef(0);
  React.useEffect(()=>{operation.current++;setBusy(false);setResult(prior=>prior?.state==='ready' && prior.baseUrl===profile?.baseUrl ? prior : null);return()=>{operation.current++;};},[profile?.id,profile?.baseUrl]);
  if(!canRecoverGateway(profile) || !desktop()?.gatewayRepair) return null;
  const repair=async()=>{
    if(busy || !profile)return;
    const current=++operation.current;setBusy(true);setResult(null);
    try {const next=await desktop()!.gatewayRepair(profile.id);if(current!==operation.current)return;setResult(next);if(next.state==='ready')onReady?.(next);}
    catch {if(current===operation.current)setResult({state:'failed',message:'恢复检查失败，请稍后重试。'});}
    finally {if(current===operation.current)setBusy(false);}
  };
  return <div className={`gateway-recovery${compact?' compact':''}`}>
    <button className="btn sm" disabled={busy} onClick={()=>void repair()}>{busy?'正在恢复…':'一键连接 OmniRoute'}</button>
    <div className="hint">检测已配置的本机地址；服务未启动时在后台启动 OmniRoute。</div>
    <div role="status" aria-live="polite">{busy?'正在检查端口、服务和凭据，请稍候。':result?.message}</div>
  </div>;
}
