import React from 'react';
import type { RunState } from '../types';
import { recoveryInfo } from '../lib/delivery';

export default function RecoveryCard({state,onResume,onAddInput,onResolve}:{state:RunState;onResume:()=>void;onAddInput?:(text:string)=>void;onResolve?:(choice:'skip'|'retry')=>void}) {
  const [text,setText] = React.useState('');
  const info = recoveryInfo(state);
  return <section className="recovery-card" aria-label="任务恢复">
    <strong>进度已保存 · {info.kind === 'uncertain' ? '需要核实操作结果':'可以从这里继续'}</strong>
    <p>{info.reason}</p>
    {info.completed.length ? <p>已完成步骤：{info.completed.join('；')}（交付检查见下方）</p>:null}
    {info.outputPaths.length ? <details><summary>已保存 {info.outputPaths.length} 个成果文件</summary>{info.outputPaths.map(p=><p className="delivery-path" key={p}>{p}</p>)}<small>可从本条回答的文件卡片打开。</small></details>:null}
    {info.target ? <p className="delivery-path">当前操作：{info.target}</p>:null}
    {info.remaining.length ? <p>待处理：{info.remaining.join('；')}</p>:null}
    <p><strong>下一步：</strong>{info.next}</p>
    {info.kind === 'uncertain' ? <div className="recovery-actions">
      <button className="btn sm" disabled={!onResolve} onClick={()=>onResolve?.('skip')}>我已核实，跳过此步</button>
      <button className="btn sm" disabled={!onResolve} onClick={()=>onResolve?.('retry')}>允许重试此步</button>
    </div> : <>
      <button className="btn sm primary" onClick={onResume}>接着跑</button>
      {onAddInput ? <details className="recovery-input"><summary>补充信息后继续</summary>
        <textarea aria-label="补充恢复信息" value={text} maxLength={12000} onChange={e=>setText(e.target.value)} placeholder="补充缺少的资料、修正要求或说明接下来怎么做" rows={3}/>
        <button className="btn sm" disabled={!text.trim()} onClick={()=>{onAddInput(text.trim());setText('');}}>补充并接着跑</button>
      </details>:null}
    </>}
  </section>;
}
