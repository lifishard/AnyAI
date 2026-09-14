import React from 'react';
import type { Artifact, ChatMessage, ErrorInfo, MessageAnnotation, SourceRef, ToolStep } from '../types';
import type { UserQuestionAnswers } from '../lib/user-questions';
import { typeOfPath } from '../lib/artifacts';
import { ArtifactStrip } from './ArtifactPanel';
import { TOOL_BY_NAME } from '../lib/tools/registry';
import { classifyError, isCleanStop } from '../lib/errors';
import Markdown from './Markdown';
import MessageNotes from './MessageNotes';
import DeliveryPanel from './DeliveryPanel';
import RecoveryCard from './RecoveryCard';
import TaskFeedback from './TaskFeedback';
import UserQuestionCard from './UserQuestionCard';

/** finish_reason 的人话注解，鼠标悬停时显示 */
const STOP_HINT: Record<string, string> = {
  length: '输出长度到顶了，这段话是被截断的，不是它说完了。把 max_tokens 调大或者让它接着写',
  max_tokens: '输出长度到顶了，这段话是被截断的。把 max_tokens 调大或者让它接着写',
  tool_calls: '它本来要调用工具。如果下面没有工具步骤，说明工具调用在路上丢了，重发一次',
  function_call: '它本来要调用工具。如果下面没有工具步骤，说明工具调用在路上丢了，重发一次',
  content_filter: '被上游的内容过滤拦下了',
};

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

function ErrorCard(props: {
  raw: string;
  info?: ErrorInfo;
  onRetry?: () => void;
  /** 400 时的「自动排查」；不传就不显示那个按钮 */
  onProbe?: () => void;
}) {
  const info = props.info?.status === 404 && props.info.kind === 'model_missing'
    ? (() => { const updated = classifyError(props.info.detail, 404); return updated.kind === 'model_missing' ? props.info : updated; })()
    : props.info;
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
        {/* 只有「请求体被拒」这一类才值得排查：401/429/5xx 排查不出东西来 */}
        {props.onProbe && (info.status === 400 || info.kind === 'bad_param') ? (
          <button
            className="btn sm"
            onClick={props.onProbe}
            title="从最小请求体开始，一组一组把字段加回去，第一个失败的那组就是原因。工具会用二分法定位到具体是哪几个"
          >
            自动排查
          </button>
        ) : null}
        <details className="err-raw">
          <summary>上游原文</summary>
          <pre>{info.detail || props.raw}</pre>
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
  onArtifactSaved?: (a: Artifact) => void;
  onCopy: (text: string) => void;
  onRetry?: () => void;
  /** 400 时的「自动排查」—— 只有确实是请求体被拒时才传 */
  onProbe?: () => void;
  /** 有中断现场时的「接着跑」 */
  onResume?: () => void;
  onCompact?: () => void;
  onHandoff?: () => void;
  onPauseForContext?: () => void;
  onResumeWithInput?: (text:string) => void;
  onResolveUncertain?: (choice: 'skip' | 'retry') => void;
  onQuestionSubmit?: (answers: UserQuestionAnswers) => void;
  onQuestionDraft?: (answers: UserQuestionAnswers) => void;
  onSaveAnnotation: (note: MessageAnnotation) => Promise<void>;
  onDeleteAnnotation: (messageId: string, noteId: string) => Promise<void>;
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
  const inputFiles: Artifact[] = (question?.attachments ?? []).filter((a) => a.path).map((a) => ({
    id: `input-${a.id}`, kind: 'file', name: a.name, path: a.path, type: typeOfPath(a.path!),
    size: a.size, direction: 'input', verifiedAt: question!.createdAt, createdAt: question!.createdAt,
  }));
  const files = [...inputFiles, ...(answer?.artifacts ?? [])].filter((a, i, all) =>
    all.findIndex((b) => b.path && a.path ? b.path === a.path && b.direction === a.direction : b.id === a.id) === i);

  return (
    <article className="turn">
      {question?.quotes?.length ? (
        <div className="quoted-context">
          {question.quotes.map((q) => (
            <blockquote key={q.id}>
              <button className="quote-source" onClick={() => {
                document.getElementById(`msg-${q.messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }}>引用{q.role === 'assistant' ? '助手' : '用户'}的原文 ↗</button>
              <div>{q.text}</div>
            </blockquote>
          ))}
        </div>
      ) : null}
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
          <h2 className="question" id={`msg-${question.id}`} data-message-id={question.id}>
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

      {question ? <MessageNotes notes={question.annotations} onSave={props.onSaveAnnotation}
        onDelete={(id) => props.onDeleteAnnotation(question.id, id)} /> : null}

      {sources.length ? <SourcesRow sources={sources} /> : null}

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
      {answer?.supplementalInputs?.length ? <details className="delivery-panel"><summary>已补充的信息 · {answer.supplementalInputs.length} 条</summary>{answer.supplementalInputs.map(m=><blockquote key={m.id}>{m.content}</blockquote>)}</details>:null}

      {answer?.userQuestionHistory?.map((item) => (
        <UserQuestionCard
          key={`${item.request.id}-${item.at}`}
          request={item.request}
          answers={item.answers}
          disabled
          onSubmit={() => {}}
        />
      ))}
      {answer?.runState?.userQuestion && !answer.pending ? (
        <UserQuestionCard
          request={answer.runState.userQuestion.request}
          answers={answer.runState.userQuestion.answers}
          draft={answer.runState.userQuestion.draft}
          disabled={!props.onQuestionSubmit}
          onSubmit={(answers) => props.onQuestionSubmit?.(answers)}
          onDraft={(draft) => props.onQuestionDraft?.(draft)}
        />
      ) : null}

      {/*
        断线保护的入口。放在错误卡**上面**：先告诉人「东西还在」，
        再让他看出了什么事 —— 顺序反过来的话，人已经准备重问了
      */}
      {answer?.pending && answer.contextSnapshot?.advisory ? <section className="recovery-card" aria-label="上下文建议">
        <strong>上下文整理建议 · 任务仍在继续</strong>
        <p>{answer.contextSnapshot.advisory}</p>
        <div className="recovery-actions">
          {props.onPauseForContext ? <button className="btn sm" onClick={props.onPauseForContext}>暂停，选择压缩后继续</button> : null}
          {props.onHandoff ? <button className="btn sm" onClick={props.onHandoff}>新窗口交接</button> : null}
        </div>
        <p className="hint">也可以保持当前任务运行。新窗口只预填交接草稿，由你决定何时发送。</p>
      </section> : null}
      {!answer?.pending && !answer?.runState && props.onHandoff ? <button className="btn sm" onClick={props.onHandoff}>新窗口交接</button> : null}
      {answer?.runState && (!answer.runState.userQuestion || answer.runState.userQuestion.answers) && !answer.pending && props.onResume ? (
        <RecoveryCard state={answer.runState} onResume={props.onResume} onCompact={props.onCompact} onHandoff={props.onHandoff} onAddInput={props.onResumeWithInput} onResolve={props.onResolveUncertain}/>
      ) : null}

      {answer?.handoff ? <details className="reasoning">
        <summary>接力上下文 · {answer.handoff.status === 'sent' ? '已发送' : '已准备'}</summary>
        <div className="reasoning-body">
          <p>{answer.handoff.fromModel ?? '此前模型'} → {answer.handoff.toModel} · {answer.handoff.mode === 'resume' ? '从原任务继续' : '承接同窗口历史'}</p>
          <p>保留 {answer.handoff.sourceMessages} 条来源记录、{answer.handoff.savedSteps} 步执行证据，{answer.handoff.summaryAvailable ? '包含已有总结或交接记录' : '尚无语义总结，保留原始上下文'}。完整原文按需检索，未全部重复发送。</p>
          <p>此处记录上下文交付状态；模型是否理解准确仍需看后续行动和验收结果。</p>
        </div>
      </details> : null}
      <DeliveryPanel report={answer?.delivery ?? answer?.runState?.delivery} visible={Boolean(answer && !answer.pending && (answer.milestones?.length || answer.delivery?.requirements.length || answer.steps?.length))}/>

      {answer?.error ? (
        <ErrorCard
          raw={answer.error}
          info={answer.errorInfo}
          onRetry={props.onRetry}
          onProbe={props.onProbe}
        />
      ) : null}

      {answer ? (
        <div className="answer" id={`msg-${answer.id}`} data-message-id={answer.id}>
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

      {files.length && props.onOpenArtifact ? (
        <ArtifactStrip artifacts={files} onOpen={props.onOpenArtifact} onSaved={props.onArtifactSaved} />
      ) : null}
      {answer && !answer.pending ? <TaskFeedback taskId={answer.taskId ?? answer.runState?.runId}/>:null}

      {answer ? <MessageNotes notes={answer.annotations} onSave={props.onSaveAnnotation}
        onDelete={(id) => props.onDeleteAnnotation(answer.id, id)} /> : null}

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
          {answer.stopReason && !isCleanStop(answer.stopReason) ? (
            <span className="stop-reason" title={STOP_HINT[answer.stopReason] ?? '上游给出的结束原因'}>
              结束原因：{answer.stopReason}
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
