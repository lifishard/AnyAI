import type { Milestone, ToolStep } from '../types';
export default function MilestonePanel({ items, steps = [] }: { items?: Milestone[]; steps?: ToolStep[] }) {
  if (!items?.length) return null;
  const complete = items.filter(m => m.status === 'completed').length;
  return <details className="milestone-panel" open={complete < items.length}>
    <summary>任务进度 <span>{complete} / {items.length}</span></summary>
    <ol>{items.map(m => <li key={m.id} className={`milestone-${m.status}`}>
      <span className="milestone-check" aria-label={{ completed:'已完成',in_progress:'进行中',pending:'待完成',blocked:'受阻' }[m.status]}>
        {{ completed:'✓',in_progress:'◉',pending:'○',blocked:'!' }[m.status]}
      </span>
      <div><span className="milestone-title">{m.title}</span>
        {m.acceptance ? <small>验收：{m.acceptance}</small> : null}
        {m.note ? <small>{m.note}</small> : null}
        {m.evidence.length ? <details className="milestone-evidence"><summary>完成证据</summary>{m.evidence.map((e,i) => {
          const step = steps.find(s => s.id === e || s.callId === e);
          return <div key={i}><strong>{step?.summary ?? (e.startsWith('text:') ? '已交付的回答原文' : `已记录步骤：${e}`)}</strong>
            <p>{step?.output?.slice(0,600) ?? (e.startsWith('text:') ? e.slice(5) : '')}</p></div>;
        })}</details> : null}
      </div>
    </li>)}</ol>
  </details>;
}
