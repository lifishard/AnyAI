import React from 'react';
import type { Conversation } from '../types';
import type { Project } from '../lib/projects';

export default function Sidebar(props: {
  conversations: Conversation[];
  activeId: string | null;
  platform: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  onFork: (id: string) => void;
  onOpenSettings: () => void;
  onOpenObservations: () => void;
  onHide: () => void;

  projects: Project[];
  onNewInProject: (projectId: string | null) => void;
  onOpenWorkspace: (tab: string) => void;
}) {
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [q, setQ] = React.useState('');
  const [folded, setFolded] = React.useState<Set<string>>(new Set());

  const toggleFold = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const { pinned, byProject, loose } = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (c: Conversation) =>
      !needle ||
      c.title.toLowerCase().includes(needle) ||
      c.messages.some((m) => m.content.toLowerCase().includes(needle));

    const list = props.conversations.filter(match).sort((a, b) => b.updatedAt - a.updatedAt);
    const rest = list.filter((c) => !c.pinned);

    const grouped = new Map<string, Conversation[]>();
    for (const p of props.projects) grouped.set(p.id, []);
    const noProject: Conversation[] = [];
    for (const c of rest) {
      const g = c.projectId ? grouped.get(c.projectId) : undefined;
      if (g) g.push(c);
      else noProject.push(c);
    }

    return {
      pinned: list.filter((c) => c.pinned),
      byProject: grouped,
      loose: noProject,
    };
  }, [props.conversations, props.projects, q]);

  function renderItem(c: Conversation) {
    return (
      <div
        key={c.id}
        className={`conv-item${c.id === props.activeId ? ' active' : ''}`}
        onClick={() => props.onSelect(c.id)}
        onDoubleClick={() => {
          setRenaming(c.id);
          setDraft(c.title);
        }}
      >
        {renaming === c.id ? (
          <input
            type="text"
            value={draft}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              props.onRename(c.id, draft.trim() || c.title);
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                props.onRename(c.id, draft.trim() || c.title);
                setRenaming(null);
              }
              if (e.key === 'Escape') setRenaming(null);
            }}
            style={{ padding: '2px 6px', fontSize: 13 }}
          />
        ) : (
          <>
            {c.pinned ? <span className="pin-dot" title="已钉选">📌</span> : null}
            <span className="conv-title" title={c.title}>
              {c.forkedFrom ? <span className="fork-mark" title="从别的对话分叉来的">⑂</span> : null}
              {c.title}
            </span>
            <button
              className="icon-btn"
              title={c.pinned ? '取消钉选' : '钉到顶部'}
              onClick={(e) => {
                e.stopPropagation();
                props.onTogglePin(c.id);
              }}
            >
              {c.pinned ? '📌' : '📍'}
            </button>
            <button
              className="icon-btn"
              title="复制一份，带上全部上下文，接着聊"
              onClick={(e) => {
                e.stopPropagation();
                props.onFork(c.id);
              }}
            >
              ⑂
            </button>
            <button
              className="icon-btn"
              title="删除"
              onClick={(e) => {
                e.stopPropagation();
                props.onDelete(c.id);
              }}
            >
              ✕
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="sidebar-head">
        <div className="brand">
          <button className="icon-btn brand-toggle" title="收起侧栏（Ctrl+B）" onClick={props.onHide}>
            ⇤
          </button>
          <span title="wickrunAI">灯芯AI</span>
          <small>{props.platform}</small>
        </div>
        <button className="btn primary block" onClick={props.onNew}>
          ＋ 新对话
        </button>
        {props.conversations.length > 4 ? (
          <input
            type="text"
            placeholder="搜索对话…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ fontSize: 12, padding: '5px 8px' }}
          />
        ) : null}
      </div>

      <div className="conv-list">
        {pinned.length === 0 && loose.length === 0 && props.projects.length === 0 ? (
          <div className="empty" style={{ padding: '24px 10px' }}>
            {q.trim() ? '没有匹配的对话' : '还没有对话'}
          </div>
        ) : null}

        {pinned.length ? (
          <>
            <div className="conv-group">📌 已钉选</div>
            {pinned.map(renderItem)}
          </>
        ) : null}

        {props.projects.map((p) => {
          const list = byProject.get(p.id) ?? [];
          const collapsed = folded.has(p.id);
          return (
            <div key={p.id}>
              <div className="conv-group project-group">
                <button className="project-toggle" onClick={() => toggleFold(p.id)}>
                  {collapsed ? '▸' : '▾'} {p.emoji} {p.name}
                  <span className="project-count">{list.length}</span>
                </button>
                <button
                  className="icon-btn"
                  title={`在「${p.name}」里新开一个对话`}
                  onClick={() => props.onNewInProject(p.id)}
                >
                  ＋
                </button>
              </div>
              {!collapsed ? list.map(renderItem) : null}
              {!collapsed && list.length === 0 ? (
                <div className="project-empty">这个项目下还没有对话</div>
              ) : null}
            </div>
          );
        })}

        {loose.length ? (
          <>
            {props.projects.length ? <div className="conv-group">未分组</div> : null}
            {loose.map(renderItem)}
          </>
        ) : null}
      </div>

      <div className="sidebar-foot">
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm ghost" style={{ flex: 1 }} onClick={() => props.onOpenWorkspace('projects')}>
            📁 项目
          </button>
          <button className="btn sm ghost" style={{ flex: 1 }} onClick={() => props.onOpenWorkspace('skills')}>
            ⚡ 技能
          </button>
          <button className="btn sm ghost" style={{ flex: 1 }} onClick={() => props.onOpenWorkspace('tasks')}>
            ⏰ 定时
          </button>
        </div>
        <button className="btn block ghost" onClick={props.onOpenSettings}>
          ⚙ 设置
        </button>
        <button className="btn block ghost" onClick={props.onOpenObservations}>任务记录与分析</button>
      </div>
    </>
  );
}
