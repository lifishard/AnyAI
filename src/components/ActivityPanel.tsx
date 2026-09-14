import React from 'react';
import type { ChatMessage } from '../types';
import { StepTrace } from './AnswerBlock';
import MilestonePanel from './MilestonePanel';
import './ActivityPanel.css';

export function hasActivity(message: ChatMessage) {
  return Boolean(message.steps?.length || message.runState?.steps?.length || message.milestones?.length || message.runState?.milestones?.length || message.progress);
}

export default function ActivityPanel({ messages, onHide }: { messages: ChatMessage[]; onHide: () => void }) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [selected, setSelected] = React.useState('latest');
  const available = messages.filter(m => m.role === 'assistant' && hasActivity(m));
  const answer = available.find(m => m.id === selected) ?? available[available.length - 1];
  if (!answer) return null;
  const steps = answer.steps ?? answer.runState?.steps ?? [];
  const milestones = answer.milestones ?? answer.runState?.milestones ?? [];
  const latest = steps[steps.length - 1];
  const current = milestones.find(m => m.status === 'in_progress' || m.status === 'blocked');
  return <aside className={`activity-panel${collapsed ? ' collapsed' : ''}`} aria-label="任务动态">
    <header className="activity-head">
      <strong>任务动态</strong>
      <button className="btn sm ghost" aria-expanded={!collapsed} onClick={() => setCollapsed(v => !v)}>{collapsed ? '展开' : '收起'}</button>
      <button className="btn sm ghost" onClick={onHide} aria-label="隐藏任务动态">隐藏</button>
    </header>
    <div className="activity-latest" aria-live="polite">
      <span>{answer.pending ? '正在进行' : '最近进度'} · {steps.length} 步{milestones.length ? ` · ${milestones.filter(m => m.status === 'completed').length}/${milestones.length} 项完成` : ''}</span>
      <p>{latest?.summary ?? current?.title ?? answer.progress ?? '已记录任务进度'}</p>
    </div>
    {!collapsed ? <div className="activity-body">
      {available.length > 1 ? <label className="activity-selector">查看记录
        <select aria-label="查看哪轮任务动态" value={available.some(m => m.id === selected) ? selected : 'latest'} onChange={e => setSelected(e.target.value)}>
          <option value="latest">跟随最新</option>
          {[...available].reverse().map((m, i) => <option key={m.id} value={m.id}>第 {available.length - i} 轮 · {m.model ?? '助手'}</option>)}
        </select>
      </label> : null}
      <StepTrace key={answer.id} steps={steps} live={Boolean(answer.pending)} />
      <MilestonePanel key={`milestones-${answer.id}`} items={milestones} steps={steps} />
      {answer.progress ? <details className="activity-progress"><summary>已保存的进度</summary><p>{answer.progress}</p></details> : null}
    </div> : null}
  </aside>;
}
