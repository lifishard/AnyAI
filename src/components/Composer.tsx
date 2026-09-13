import React from 'react';
import type {
  ApprovalMode,
  Attachment,
  KeyProfile,
  ModelHealthMap,
  ModelInfo,
} from '../types';
import type { EffortLevel, EffortMapping } from '../lib/effort';
import type { Skill } from '../lib/skills';
import type { ProjectPrompt } from '../lib/projects';
import { matchSkills, slashQuery } from '../lib/skills';
import EffortPicker from './EffortPicker';
import ModelPicker from './ModelPicker';
import ContextMeter, { type ContextPreview } from './ContextMeter';
import { routeKey } from '../lib/adaptive';

const APPROVAL_OPTIONS: { value: ApprovalMode; label: string; desc: string }[] = [
  {
    value: 'ask',
    label: '逐步确认',
    desc: '每个会改变状态的操作都先问你 —— 写文件、跑命令、点 Chrome、调 Claude Code。',
  },
  {
    value: 'auto',
    label: '自动批准编辑',
    desc: '写文件和 Chrome 操作直接放行；跑命令和调 Claude Code 仍然问你。',
  },
  {
    value: 'all',
    label: '全部放行',
    desc: '一句不问，包括在你电脑上执行任意命令。只在你盯着屏幕、且工作目录里没有要紧东西时用。',
  },
];

export default function Composer(props: {
  contextPreview?: ContextPreview;
  quotes: import('../types').MessageQuote[];
  quoteOnly: boolean;
  onQuoteOnly: (only: boolean) => void;
  onRemoveQuote: (id: string) => void;
  queuePaused: boolean;
  onResumeQueue: () => void;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  sendKey: 'enter' | 'mod-enter';
  onSend: (text: string) => void;
  onStop: () => void;
  stream: boolean;
  toolCount: number;

  attachments: Attachment[];
  onAddAttachments: (mode: 'file' | 'image') => void;
  onPasteImage: (dataUrl: string, name: string, mime: string, size: number) => void;
  onRemoveAttachment: (id: string) => void;
  onPickWorkspace: () => void;
  workspaceCount: number;
  canPickLocal: boolean;

  approvalMode: ApprovalMode;
  onApprovalMode: (m: ApprovalMode) => void;

  /* 模型 / 凭据，作用域是当前会话 */
  profiles: KeyProfile[];
  profileId: string | null;
  onProfile: (id: string) => void;
  models: ModelInfo[];
  model: string;
  onModel: (id: string) => void;
  modelsLoading: boolean;
  modelsError: string | null;
  onRefreshModels: () => void;
  onAddModel: (id: string) => void;
  /** 模型健康度：坏掉的路由默认不进列表 */
  modelHealth: ModelHealthMap;
  probe: { done: number; total: number; current: string } | null;
  onProbe: () => void;
  onStopProbe: () => void;
  onMuteModel: (id: string, muted: boolean) => void;
  onClearHealth: () => void;

  /* 思考强度 */
  effortLevel: EffortLevel;
  onEffortLevel: (l: EffortLevel) => void;
  effortMappings: EffortMapping[];
  effortManual: boolean;
  onOpenMappings: () => void;

  /* 技能：/ 唤起 */
  skills: Skill[];
  activeSkills: Skill[];
  onPickSkill: (s: Skill) => void;
  onDropSkill: (id: string) => void;

  /* 项目里的常用提示词 */
  projectPrompts: ProjectPrompt[];

  queued: string[];
  onDropQueued: (index: number) => void;
}) {
  const [text, setText] = React.useState('');
  const contextDraft = React.useMemo(() => ({ id:'draft', role:'user' as const, content:text, createdAt:0,
    attachments:props.attachments, quotes:props.quotes, quoteOnly:props.quoteOnly && props.quotes.length > 0 }),[text,props.attachments,props.quotes,props.quoteOnly]);
  const [plusOpen, setPlusOpen] = React.useState(false);
  const [approvalOpen, setApprovalOpen] = React.useState(false);
  const [caret, setCaret] = React.useState(0);
  const [slashIndex, setSlashIndex] = React.useState(0);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const barRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { if (props.quotes.length) ref.current?.focus(); }, [props.quotes.length]);

  /* ---- 斜杠唤起技能 ---- */
  const slashQ = slashQuery(text, caret);
  const slashHits = React.useMemo(
    () => (slashQ === null ? [] : matchSkills(props.skills, slashQ)),
    [slashQ, props.skills],
  );
  const slashOpen = slashQ !== null && slashHits.length > 0;

  React.useEffect(() => {
    setSlashIndex(0);
  }, [slashQ]);

  /** 选中一个技能：把输入框里那段 /xxx 抹掉，技能挂成一个 chip */
  function pickSkill(sk: Skill) {
    const before = text.slice(0, caret);
    const lineStart = before.lastIndexOf('\n') + 1;
    const next = text.slice(0, lineStart) + text.slice(caret);
    setText(next);
    props.onPickSkill(sk);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(lineStart, lineStart);
      setCaret(lineStart);
    });
  }

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  React.useEffect(() => {
    if (!plusOpen && !approvalOpen) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setPlusOpen(false);
        setApprovalOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [plusOpen, approvalOpen]);

  function submit() {
    const t = text.trim();
    // 生成中不拦：App 会把它排进队列，等这一轮结束自动发
    if ((!t && props.attachments.length === 0) || props.disabled) return;
    props.onSend(t);
    setText('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashHits.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashHits.length) % slashHits.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickSkill(slashHits[slashIndex] ?? slashHits[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCaret(-1); // 关掉菜单但不动文字
        return;
      }
    }

    const mod = e.metaKey || e.ctrlKey;
    if (e.key !== 'Enter') return;
    if (props.sendKey === 'enter' ? !e.shiftKey && !mod : mod) {
      e.preventDefault();
      submit();
    }
  }

  /** 剪贴板里有图就直接变成附件；截图工具、网页右键复制图片都走这条 */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const images: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) images.push(f);
      }
    }
    if (!images.length) return;

    e.preventDefault(); // 别让它同时把文件名之类的文本也粘进来
    for (const f of images) {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result ?? '');
        if (!url.startsWith('data:')) return;
        const name = f.name && f.name !== 'image.png' ? f.name : `粘贴的图片-${Date.now()}.png`;
        props.onPasteImage(url, name, f.type, f.size);
      };
      reader.readAsDataURL(f);
    }
  }

  const current = APPROVAL_OPTIONS.find((o) => o.value === props.approvalMode) ?? APPROVAL_OPTIONS[0];
  const canSend = Boolean(text.trim()) || props.attachments.length > 0;

  return (
    <div className="composer-wrap">
      <div className="composer">
        <div className="composer-box">
          {props.quotes.length ? (
            <div className="quote-draft">
              {props.quotes.map((q) => (
                <div className="quote-draft-item" key={q.id}>
                  <span className="quote-mark">“</span><div>{q.text}</div>
                  <button className="icon-btn" aria-label="移除引用" onClick={() => props.onRemoveQuote(q.id)}>✕</button>
                </div>
              ))}
              <label className="quote-scope"><input type="checkbox" checked={props.quoteOnly} onChange={(e) => props.onQuoteOnly(e.target.checked)} />
                只发送引用段落和本次问题，保留项目规范
              </label>
            </div>
          ) : null}
          {props.queued.length ? (
            <div className="queue-row">
              {props.queued.map((q, i) => (
                <span className="queue-chip" key={`${i}-${q.slice(0, 12)}`}>
                  <span className="queue-n">{i + 1}</span>
                  <span className="queue-text" title={q}>
                    {q}
                  </span>
                  <button className="icon-btn" title="取消这条" onClick={() => props.onDropQueued(i)}>
                    ✕
                  </button>
                </span>
              ))}
              <span className="queue-note">{props.queuePaused ? '队列已暂停' : '排队中，这一轮结束后依次发出'}</span>
              {props.queuePaused ? <button className="btn sm" onClick={props.onResumeQueue}>继续队列</button> : null}
            </div>
          ) : null}

          {props.attachments.length ? (
            <div className="attach-row">
              {props.attachments.map((a) => (
                <span key={a.id} className={`attach-chip ${a.kind}`}>
                  {a.kind === 'image' && a.dataUrl ? (
                    <img src={a.dataUrl} alt="" />
                  ) : (
                    <span className="attach-icon">📄</span>
                  )}
                  <span className="attach-name" title={a.name}>
                    {a.name}
                  </span>
                  <button className="icon-btn" onClick={() => props.onRemoveAttachment(a.id)}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          {slashOpen ? (
            <div className="slash-menu">
              <div className="picker-label">技能 · 输入 / 唤起</div>
              {slashHits.map((sk, i) => (
                <button
                  key={sk.id}
                  className={`popup-item${i === slashIndex ? ' on' : ''}`}
                  onMouseEnter={() => setSlashIndex(i)}
                  onClick={() => pickSkill(sk)}
                >
                  <span className="popup-icon">/</span>
                  <span>
                    <strong>{sk.name}</strong>
                    <small>{sk.description || '没写描述'}</small>
                  </span>
                </button>
              ))}
              <div className="picker-foot">↑↓ 选择 · Enter 确认 · Esc 关掉</div>
            </div>
          ) : null}

          {props.activeSkills.length ? (
            <div className="attach-row">
              {props.activeSkills.map((sk) => (
                <span key={sk.id} className="skill-chip" title={sk.description}>
                  <span className="skill-slash">/</span>
                  <span className="attach-name">{sk.name}</span>
                  <button className="icon-btn" onClick={() => props.onDropSkill(sk.id)}>
                    ✕
                  </button>
                </span>
              ))}
              <span className="queue-note">
                这些技能的指令会注入每一轮，直到你点 ✕ 摘掉
              </span>
            </div>
          ) : null}

          {props.projectPrompts.length && !text.trim() ? (
            <div className="attach-row">
              {props.projectPrompts.map((pp) => (
                <button
                  key={pp.id}
                  className="example-chip"
                  title={pp.text}
                  onClick={() => {
                    setText(pp.text);
                    requestAnimationFrame(() => ref.current?.focus());
                  }}
                >
                  {pp.label}
                </button>
              ))}
            </div>
          ) : null}

          <textarea
            ref={ref}
            rows={1}
            value={text}
            placeholder={
              props.disabled
                ? (props.disabledReason ?? '请先完成配置')
                : props.busy
                  ? '还在生成，现在输入会排到队尾…'
                  : '问点什么…（图片可以直接粘贴）'
            }
            disabled={props.disabled}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />

          <div className="composer-bar" ref={barRef}>
            {/* ---- 左下角 ---- */}
            <div className="menu-anchor">
              <button
                className="btn sm ghost"
                title="添加文件、图片或工作目录"
                onClick={() => {
                  setPlusOpen((v) => !v);
                  setApprovalOpen(false);
                }}
              >
                ＋
              </button>
              {plusOpen ? (
                <div className="popup">
                  <button
                    className="popup-item"
                    disabled={!props.canPickLocal}
                    onClick={() => {
                      setPlusOpen(false);
                      props.onPickWorkspace();
                    }}
                  >
                    <span className="popup-icon">📁</span>
                    <span>
                      <strong>选择工作目录</strong>
                      <small>
                        {props.workspaceCount
                          ? `已配 ${props.workspaceCount} 个，再加一个`
                          : '还没配，文件和命令行工具会拒绝执行'}
                      </small>
                    </span>
                  </button>
                  <button
                    className="popup-item"
                    disabled={!props.canPickLocal}
                    onClick={() => {
                      setPlusOpen(false);
                      props.onAddAttachments('file');
                    }}
                  >
                    <span className="popup-icon">📄</span>
                    <span>
                      <strong>添加文件</strong>
                      <small>文本和代码，内容直接进这轮对话</small>
                    </span>
                  </button>
                  <button
                    className="popup-item"
                    disabled={!props.canPickLocal}
                    onClick={() => {
                      setPlusOpen(false);
                      props.onAddAttachments('image');
                    }}
                  >
                    <span className="popup-icon">🖼</span>
                    <span>
                      <strong>添加图片</strong>
                      <small>也可以直接 Ctrl+V 粘贴。需要模型支持多模态</small>
                    </span>
                  </button>
                  {!props.canPickLocal ? (
                    <div className="popup-note">这台设备读不了本地文件，去设置里配好遥控。</div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="menu-anchor">
              <button
                className={`btn sm ghost approval-${props.approvalMode}`}
                title={current.desc}
                onClick={() => {
                  setApprovalOpen((v) => !v);
                  setPlusOpen(false);
                }}
              >
                {props.approvalMode === 'all' ? '⚡' : props.approvalMode === 'auto' ? '◐' : '🔒'}{' '}
                {current.label}
              </button>
              {approvalOpen ? (
                <div className="popup wide">
                  {APPROVAL_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      className={`popup-item${o.value === props.approvalMode ? ' on' : ''}`}
                      onClick={() => {
                        props.onApprovalMode(o.value);
                        setApprovalOpen(false);
                      }}
                    >
                      <span className="popup-icon">
                        {o.value === 'all' ? '⚡' : o.value === 'auto' ? '◐' : '🔒'}
                      </span>
                      <span>
                        <strong>{o.label}</strong>
                        <small>{o.desc}</small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <ModelPicker
              profiles={props.profiles}
              profileId={props.profileId}
              onProfile={props.onProfile}
              models={props.models}
              model={props.model}
              onModel={props.onModel}
              loading={props.modelsLoading}
              error={props.modelsError}
              onRefresh={props.onRefreshModels}
              onAddModel={props.onAddModel}
              health={props.modelHealth}
              probe={props.probe}
              onProbe={props.onProbe}
              onStopProbe={props.onStopProbe}
              onMute={props.onMuteModel}
              onClearHealth={props.onClearHealth}
            />

            <span className="spacer" />

            {/* ---- 右下角 ---- */}
            {props.contextPreview ? <ContextMeter preview={props.contextPreview} draft={contextDraft} /> : null}
            {props.toolCount > 0 ? <span className="chip">{props.toolCount} 工具</span> : null}
            {!props.stream ? <span className="chip">非流式</span> : null}

            <EffortPicker
              level={props.effortLevel}
              onLevel={props.onEffortLevel}
              model={props.model}
              mappings={props.effortMappings}
              route={props.contextPreview?.profile.routeProfiles?.[routeKey(props.contextPreview.profile,props.model)]}
              manual={props.effortManual}
              onOpenMappings={props.onOpenMappings}
            />

            {props.busy ? (
              <>
                <button className="btn sm danger" onClick={props.onStop}>
                  停止
                </button>
                <button
                  className="btn sm"
                  onClick={submit}
                  disabled={props.disabled || !canSend}
                  title="排到队尾，这一轮结束后自动发出"
                >
                  排队发送
                </button>
              </>
            ) : (
              <button className="btn sm primary" onClick={submit} disabled={props.disabled || !canSend}>
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
