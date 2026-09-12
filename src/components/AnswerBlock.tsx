import React from 'react';
import type { Artifact, ChatMessage, ErrorInfo, SourceRef, ToolStep } from '../types';
import { ArtifactStrip } from './ArtifactPanel';
import { TOOL_BY_NAME } from '../lib/tools/registry';
import Markdown from './Markdown';

/* ------------------------------------------------------------------ *
 * 来源卡片行（Perplexity 那条横向滚动的来源带）
 * ------------------------------------------------------------------ */

function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function SourcesRow({ sources }: { sources: SourceRef[] }) {
  if (!sources.length) return null;
  return (
    <div className="sources">
      <div className="sources-label">来源 · {sources.length}</div>
      <div className="sources-scroll">
        {sources.map((s) => (
          <a
            key={s.n}
            className="source-card"
            id={`src-${s.n}`}
            href={s.url ?? undefined}
            target="_blank"
            rel="noreferrer noopener"
            title={s.url ?? s.path ?? s.title}
            onClick={(e) => {
              if (!s.url) e.preventDefault();
            }}
          >
            <div className="source-head">
              <span className="source-n">{s.n}</span>
              <span className="source-host">{hostOf(s.url) || s.path || '本地'}</span>
            </div>
            <div className="source-title">{s.title}</div>
          </a>
        ))}
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ *
 * 错误卡片
 *
 * 上游报错原文是给写后端的人看的。这里先说清楚「发生了什么」，再给
 * 「现在该做什么」，原文折叠在最后 —— 需要它的人是在开 issue，不是在排查。
 * ------------------------------------------------------------------ */

const KIND_ICON: Record<string, string> = {
  auth: '🔑',
  quota: '💳',
  rate_limit: '⏳',
  model_missing: '🔍',
  model_broken: '🧱',
  bad_param: '🎛',
  context_too_long: '📏',
  multimodal: '🖼',
  tools_unsupported: '🔧',
  network: '🌐',
  timeout: '⏱',
  unknown: '⚠',
};

function ErrorCard(props: { raw: string; info?: ErrorInfo; onRetry?: () => void }) {
  const info = props.info;
  if (!info) {
    return (
      <div className="answer-error">
        <strong>请求失败：</strong>
        {props.raw}
      </div>
    );
  }
  return (
    <div className="answer-error card">
      <div className="err-head">
        <span className="err-icon">{KIND_ICON[info.kind] ?? '⚠'}</span>
        <span className="err-title">{info.title}</span>
        {info.status ? <span className="err-code">HTTP {info.status}</span> : null}
      </div>

      {info.fixes.length ? (
        <ul className="err-fixes">
          {info.fixes.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      ) : null}

      <div className="err-foot">
        {props.onRetry ? (
          <button className="btn sm primary" onClick={props.onRetry}>
            重新发送
          </button>
        ) : null}
        <details className="err-raw">
          <summary>上游原文</summary>
          <pre>{props.raw}</pre>
        </details>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 步骤轨迹
 * ------------------------------------------------------------------ */

const STATUS_ICON: Record<ToolStep['status'], string> = {
  running: '◌',
  ok: '✓',
  error: '✕',
  denied: '⊘',
};

export function StepTrace({ steps, live }: { steps: ToolStep[]; live: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  if (!steps.length) return null;

  const running = steps.filter((s) => s.status === 'running').length;
  const label = live && running ? steps[steps.length - 1].summary : `研究过程 · ${steps.length} 步`;

  return (
    <div className="trace">
      <button className="trace-head" onClick={() => setOpen((v) => !v)}>
        <span className={`trace-spin${live && running ? ' on' : ''}`}>
          {live && running ? '◌' : '≡'}
        </span>
        <span className="trace-label">{label}</span>
        <span className="trace-toggle">{open ? '收起' : '展开'}</span>
      </button>

      {open ? (
        <div className="trace-body">
          {steps.map((s) => {
            const def = TOOL_BY_NAME[s.name];
            const isOpen = expanded === s.id;
            return (
              <div key={s.id} className={`trace-step ${s.status}`}>
                <button className="trace-step-head" onClick={() => setExpanded(isOpen ? null : s.id)}>
                  <span className="trace-status">{STATUS_ICON[s.status]}</span>
                  <span className="trace-tool">{def?.label ?? s.name}</span>
                  <span className="trace-summary">{s.summary}</span>
                  {s.elapsedMs ? <span className="trace-time">{(s.elapsedMs / 1000).toFixed(1)}s</span> : null}
                </button>
                {isOpen ? (
                  <div className="trace-detail">
                    <div className="trace-detail-label">参数</div>
                    <pre>{JSON.stringify(s.args, null, 2)}</pre>
                    <div className="trace-detail-label">{s.error ? '错误' : '返回'}</div>
                    <pre>{s.error ?? (s.output || '（无输出）').slice(0, 4000)}</pre>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 一问一答
 * ------------------------------------------------------------------ */

export default function AnswerBlock(props: {
  question: ChatMessage | null;
  answer: ChatMessage | null;
  showReasoning: boolean;
  onOpenArtifact?: (a: Artifact) => void;
  onCopy: (text: string) => void;
  onRetry?: () => void;
  onEditQuestion?: (text: string) => void;
  onFork?: () => void;
  onDelete?: () => void;
}) {
  const { question, answer } = props;
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(question?.content ?? '');

  React.useEffect(() => {
    if (!editing) setDraft(question?.content ?? '');
  }, [question?.content, editing]);

  const sources = answer?.sources ?? [];
  const steps = answer?.steps ?? [];
  const live = Boolean(answer?.pending);

  return (
    <article className="turn">
      {question ? (
        editing ? (
          <div className="q-edit">
            <textarea
              rows={Math.min(10, Math.max(2, draft.split('\n').length + 1))}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="btn sm" onClick={() => setEditing(false)}>
                取消
              </button>
              <button
                className="btn sm primary"
                onClick={() => {
                  setEditing(false);
                  props.onEditQuestion?.(draft);
                }}
              >
                重新提问
              </button>
            </div>
          </div>
        ) : (
          <h2 className="question">
            {question.skillNames?.length ? (
              <span className="q-attach">
                {question.skillNames.map((n) => (
                  <span key={n} className="skill-chip" title={`这一轮注入了技能 /${n}`}>
                    <span className="skill-slash">/</span>
                    {n}
                  </span>
                ))}
              </span>
            ) : null}
            {question.attachments?.length ? (
              <span className="q-attach">
                {question.attachments.map((a) =>
                  a.kind === 'image' && a.dataUrl ? (
                    <img key={a.id} src={a.dataUrl} alt={a.name} title={a.name} />
                  ) : (
                    <span key={a.id} className="chip" title={a.name}>
                      📄 {a.name}
                    </span>
                  ),
                )}
              </span>
            ) : null}
            {question.content}
            {props.onEditQuestion ? (
              <button className="icon-btn q-edit-btn" title="改问题重问" onClick={() => setEditing(true)}>
                ✎
              </button>
            ) : null}
          </h2>
        )
      ) : null}

      {sources.length ? <SourcesRow sources={sources} /> : null}
      {steps.length ? <StepTrace steps={steps} live={live} /> : null}

      {answer?.reasoning && answer.reasoning.trim() ? (
        <details className="reasoning" open={props.showReasoning && live && !answer.content}>
          <summary>
            思考过程
            <span style={{ fontWeight: 400, opacity: 0.7 }}>{answer.reasoning.length} 字</span>
          </summary>
          <div className="reasoning-body">{answer.reasoning}</div>
        </details>
      ) : null}

      {answer?.notice ? <div className="answer-notice">{answer.notice}</div> : null}

      {answer?.error ? (
        <ErrorCard raw={answer.error} info={answer.errorInfo} onRetry={props.onRetry} />
      ) : null}

      {answer && !answer.error ? (
        <div className="answer">
          {answer.content ? (
            <Markdown text={answer.content} sources={sources} />
          ) : live && !steps.length ? (
            <div className="thinking-dots">
              <span />
              <span />
              <span />
            </div>
          ) : null}
          {live && answer.content ? <span className="caret" /> : null}
        </div>
      ) : null}

      {answer?.artifacts?.length && props.onOpenArtifact ? (
        <ArtifactStrip artifacts={answer.artifacts} onOpen={props.onOpenArtifact} />
      ) : null}

      {answer && !answer.pending ? (
        <div className="answer-foot">
          {answer.model ? <span>{answer.model}</span> : null}
          {answer.elapsedMs ? <span>{(answer.elapsedMs / 1000).toFixed(1)}s</span> : null}
          {answer.usage?.total_tokens ? (
            <span>
              {answer.usage.prompt_tokens ?? '—'} + {answer.usage.completion_tokens ?? '—'} ={' '}
              {answer.usage.total_tokens} tok
            </span>
          ) : null}
          {answer.usage?.cached_tokens ? (
            <span title="提示词里命中上下文缓存的部分，这部分通常按更低的价格计费">
              缓存命中 {answer.usage.cached_tokens} tok
            </span>
          ) : null}
          <span className="spacer" />
          <button className="icon-btn" title="复制回答" onClick={() => props.onCopy(answer.content)}>
            ⧉
          </button>
          {props.onRetry ? (
            <button className="icon-btn" title="重新生成" onClick={props.onRetry}>
              ↻
            </button>
          ) : null}
          {props.onFork ? (
            <button
              className="icon-btn"
              title="从这里分叉出一条新对话，只带到这一步为止的上下文"
              onClick={props.onFork}
            >
              ⑂
            </button>
          ) : null}
          {props.onDelete ? (
            <button className="icon-btn" title="删除这一轮" onClick={props.onDelete}>
              ✕
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
