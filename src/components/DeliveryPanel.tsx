import type { DeliveryReport } from '../types';

const labels = {unchecked:'尚未完成验收',passed:'已列条件检查通过',failed:'有条件未通过',unverifiable:'有条件无法核验'};
export default function DeliveryPanel({report,visible}:{report?:DeliveryReport;visible:boolean}) {
  if (!visible || !report) return null;
  return <details className={`delivery-panel delivery-${report.status}`} open={report.status !== 'passed'}>
    <summary>交付验收 · {labels[report.status]}</summary>
    <p className="delivery-scope">{report.requirements.length ? '清单由模型根据用户要求整理。下列结果只覆盖已列条件，用户是否可用另行记录。' : '本任务尚未建立验收清单；程序结束不代表结果已经核实。'}</p>
    <ol>{report.requirements.map(r => {
      const v = r.verification?.revision === r.revision ? r.verification : undefined;
      return <li key={r.id}>
        <strong>{r.title}</strong><span className="delivery-badge">{!v ? '未检查' : v.status === 'passed' ? '通过' : v.status === 'failed' ? '未通过' : '无法核验'}{v ? ` · ${v.method === 'program' ? '程序检查':'模型复核'}`:''}</span>
        {v ? <p>{v.detail}</p> : <p>当前版本的要求尚无核验结果。</p>}
        <details><summary>要求来源与检查范围</summary>
          <blockquote>{r.sourceQuote}</blockquote>
          <p>要求版本 {r.revision} · {r.check.kind === 'review' ? '语义复核，依据已有记录':'仅核对下列程序条件'}</p>
          {r.check.path ? <p className="delivery-path">{r.check.path}</p> : null}
          {r.check.count !== undefined ? <p>指定条数：{r.check.count}</p> : null}
          {r.check.requiredKeys?.length ? <p>必填字段：{r.check.requiredKeys.join('、')}</p> : null}
          {r.check.contains?.length ? <p>指定原文：{r.check.contains.join('、')}</p> : null}
          {v ? <small>检查时间：{new Date(v.at).toLocaleString()} · 证据 {v.evidence.length} 项</small>:null}
          {r.history.length ? <p>保留 {r.history.length} 次要求修订，旧检查不会自动用于新要求。</p>:null}
        </details>
      </li>;
    })}</ol>
  </details>;
}
