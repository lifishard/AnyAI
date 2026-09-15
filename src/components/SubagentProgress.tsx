import React from 'react';
import type { SubagentJob } from '../lib/subagents';
import './SubagentProgress.css';

const STATUS_LABEL: Record<SubagentJob['status'], string> = {
  queued: '等待开始',
  running: '处理中',
  completed: '已返回',
  paused: '已暂停',
  failed: '失败',
  cancelled: '已取消',
  uncertain: '结果待确认',
};

function summaryOf(job: SubagentJob) {
  const value = (job.content || job.error || '').trim().replace(/\s+/g, ' ');
  if (!value) return job.status === 'completed' ? '已完成，但没有返回文字摘要。' : '尚未返回摘要。';
  return value.length > 240 ? `${value.slice(0, 240)}…` : value;
}

export default function SubagentProgress({ jobs }: { jobs: SubagentJob[] }) {
  if (jobs.length === 0) return null;
  const active = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const completed = jobs.filter((job) => job.status === 'completed').length;

  return (
    <details className="subagent-progress" open={active > 0}>
      <summary>
        <span>临时协作</span>
        <span>{active > 0 ? `${active} 个处理中` : `${completed}/${jobs.length} 已返回`}</span>
      </summary>
      <div className="subagent-progress-list">
        {jobs.map((job) => (
          <article key={job.id}>
            <header>
              <span className={`subagent-status ${job.status}`}><span aria-hidden="true" />{STATUS_LABEL[job.status]}</span>
              <strong title={job.model}>{job.model}</strong>
              <span>{job.steps} 步</span>
            </header>
            <p>{summaryOf(job)}</p>
          </article>
        ))}
      </div>
    </details>
  );
}
