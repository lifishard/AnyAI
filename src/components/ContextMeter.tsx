import React from 'react';
import AnchoredPopover from './AnchoredPopover';
import type { ChatMessage, ContextSnapshot, GenerationConfig, KeyProfile, ModelInfo } from '../types';
import type { EffortMapping } from '../lib/effort';
import type { LearnedLimit } from '../lib/limits';
import { capabilities, prepareBody, snapshot } from '../lib/adaptive';
import { buildRequestBody } from '../lib/paramSchema';
import { buildWire } from '../lib/agent';
import { conversationMemory } from '../lib/handoff';
import { memoryInstructions } from '../lib/context-memory';
import { runRecord } from '../lib/runs';

export interface ContextPreview {
  profile: KeyProfile;
  config: GenerationConfig;
  history: ChatMessage[];
  extraSystem: string;
  toolNames: string[];
  mappings: EffortMapping[];
  learned?: LearnedLimit;
  modelInfo?: ModelInfo;
  current?: ContextSnapshot;
}
const n = (value: number) => value >= 10000 ? `${(value/1000).toFixed(1)}k` : value.toLocaleString();
export default function ContextMeter({ preview, draft }: { preview: ContextPreview; draft: ChatMessage }) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const deferredDraft = React.useDeferredValue(draft);
  const result = React.useMemo(() => {
    if (preview.current) return { value: preview.current };
    try {
      const cap = capabilities(preview.profile,preview.config,preview.learned,preview.modelInfo);
      const tools = preview.config.toolsEnabled ? [...new Set([...preview.toolNames,'read_context', 'read_tool_result', ...(preview.config.runtime?.milestones === false ? [] : ['update_plan','update_requirements','verify_requirements'])])] : [];
      const history=[...preview.history,deferredDraft],memory=conversationMemory(history,runRecord);
      const extra=preview.extraSystem+memoryInstructions({working:memory.history,contextArchiveSteps:memory.evidence,round:1,at:0,stoppedBy:'unknown',
        requirementSourceIds:history.filter(m=>m.role==='user').map(m=>m.id)},tools.includes('update_plan'),tools.includes('read_context'));
      const body = prepareBody(buildRequestBody(preview.config,buildWire(memory.history,preview.config,extra),tools,preview.mappings),preview.config,cap);
      return { value:snapshot(body,preview.config,preview.profile,cap) };
    } catch (e) { return { error:e instanceof Error ? e.message : String(e) }; }
  },[preview,deferredDraft]);
  const s = result.value;
  const ratio = s?.contextWindow ? Math.min(100,s.inputTokens/s.contextWindow*100) : 0;
  const reserved = s?.contextWindow ? Math.min(100,ratio+s.outputReserve/s.contextWindow*100) : 0;
  const phase = s?.phase === 'waiting' ? '等待额度' : s?.phase === 'compacting' ? '整理中' : preview.current ? '本次请求' : '发送前估算';
  return <div className="context-meter" ref={anchorRef}>
    <button type="button" aria-label="上下文用量" title="查看上下文用量与预算" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(v => !v)}>
      <span className="context-ring" style={{ background: `conic-gradient(var(--accent) ${ratio}%, var(--border-strong) ${ratio}% ${reserved}%, var(--bg-sunken) ${reserved}% 100%)` }}>
        <span>{s?.contextWindow ? `${Math.round(ratio)}%` : '?'}</span>
      </span>
      <span className="context-meter-label">{s ? n(s.inputTokens) : '配置待核对'}</span>
    </button>
    {open ? <AnchoredPopover anchorRef={anchorRef} onClose={() => setOpen(false)} className="context-popover" label="上下文用量与预算" align="end">
      <strong>上下文 · {phase}</strong>
      {s ? <>
        <div className="context-total">约 {n(s.inputTokens)} <small>/ {s.contextWindow ? `${n(s.contextWindow)} token` : '窗口未知'}</small></div>
        <dl>
          <div><dt>输出预留（含思考）</dt><dd>{n(s.outputReserve)}</dd></div>
          <div><dt>本轮工作预算</dt><dd>{n(s.workingBudget)}</dd></div>
          <div><dt>系统与项目指令</dt><dd>{n(s.components.system)}</dd></div>
          <div><dt>工具定义</dt><dd>{n(s.components.tools)}</dd></div>
          <div><dt>对话与文本材料</dt><dd>{n(s.components.conversation)}</dd></div>
          <div><dt>图片预估</dt><dd>{n(s.components.attachments)}</dd></div>
          <div><dt>工具结果</dt><dd>{n(s.components.toolResults)}</dd></div>
          <div><dt>已整理摘要</dt><dd>{s.compressionCount} 次</dd></div>
          {s.lastReduction ? <div><dt>较原始记录减少</dt><dd>约 {n(s.lastReduction)}</dd></div> : null}
          <div className="context-quota-row"><dt>分钟额度（请求 / token）</dt><dd>{s.quota?.rpm ?? '?'} / {s.quota?.tpm ? n(s.quota.tpm) : '?'}</dd></div>
          {s.quota?.itpm || s.quota?.otpm ? <div><dt>输入 / 输出额度</dt><dd>{s.quota.itpm ? n(s.quota.itpm) : '?'} / {s.quota.otpm ? n(s.quota.otpm) : '?'}</dd></div> : null}
        </dl>
        <p className="hint">{s.source}。用量为发送前估算，实际计费以上游 usage 为准。分钟额度影响发送时间。</p>
      </> : <p className="hint">{result.error}</p>}
    </AnchoredPopover> : null}
  </div>;
}
