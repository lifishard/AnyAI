import React from 'react';
import type { KeyProfile, ModelInfo } from '../types';

/**
 * 模型 + 凭据选择器，挂在输入框左下角，作用域是**当前会话**。
 *
 * 为什么不用 <select>：接了聚合网关之后模型能有几百个，原生下拉滚不动也搜不了。
 * 这里是搜索框 + 过滤列表，渲染上限 300 条，够用且不卡。
 */
export default function ModelPicker(props: {
  profiles: KeyProfile[];
  profileId: string | null;
  onProfile: (id: string) => void;

  models: ModelInfo[];
  model: string;
  onModel: (id: string) => void;

  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onAddModel: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  React.useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
    else setQ('');
  }, [open]);

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return props.models.slice(0, 300);
    return props.models
      .filter((m) => {
        const hay = `${m.id} ${m.label ?? ''} ${m.ownedBy ?? ''}`.toLowerCase();
        // 空格分词，全部命中才算 —— 「kimi think」这种能筛出来
        return needle.split(/\s+/).every((w) => hay.includes(w));
      })
      .slice(0, 300);
  }, [props.models, q]);

  const activeProfile = props.profiles.find((p) => p.id === props.profileId) ?? null;
  const exact = props.models.some((m) => m.id === q.trim());

  return (
    <div className="menu-anchor" ref={anchorRef}>
      <button
        className="btn sm ghost model-btn"
        title={`当前模型：${props.model || '未选择'}\n凭据：${activeProfile?.name ?? '未选择'}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="model-btn-name">{props.model || '选模型'}</span>
        <span className="model-btn-caret">▾</span>
      </button>

      {open ? (
        <div className="popup picker">
          {/* 凭据 */}
          <div className="picker-section">
            <div className="picker-label">
              凭据
              <span style={{ flex: 1 }} />
              <button
                className="icon-btn"
                title="重新拉取这份凭据下的模型列表"
                onClick={props.onRefresh}
                disabled={props.loading}
              >
                {props.loading ? '…' : '↻'}
              </button>
            </div>
            <div className="picker-profiles">
              {props.profiles.length === 0 ? (
                <div className="picker-empty">还没登记凭据，去设置里加一份</div>
              ) : (
                props.profiles.map((p) => (
                  <button
                    key={p.id}
                    className={`picker-profile${p.id === props.profileId ? ' on' : ''}`}
                    onClick={() => props.onProfile(p.id)}
                    title={p.baseUrl}
                  >
                    {p.name}
                  </button>
                ))
              )}
            </div>
          </div>

          {/* 模型 */}
          <div className="picker-section">
            <div className="picker-label">
              模型
              <span style={{ flex: 1 }} />
              <span style={{ fontWeight: 400, color: 'var(--fg-faint)' }}>
                {props.models.length} 个
              </span>
            </div>

            <input
              ref={inputRef}
              type="text"
              className="picker-search"
              placeholder="搜索模型，或直接粘贴一个 ID"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter') {
                  const pick = filtered[0]?.id ?? (q.trim() || '');
                  if (pick) {
                    if (!props.models.some((m) => m.id === pick)) props.onAddModel(pick);
                    props.onModel(pick);
                    setOpen(false);
                  }
                }
              }}
            />

            {props.error ? (
              <div className="picker-error">
                拉取失败：{props.error}
                <br />
                可以直接在上面输入 ID 然后回车，手动加一个。
              </div>
            ) : null}

            <div className="picker-list">
              {filtered.length === 0 ? (
                <div className="picker-empty">
                  没有匹配的模型
                  {q.trim() ? (
                    <>
                      <br />
                      <button
                        className="btn sm"
                        style={{ marginTop: 8 }}
                        onClick={() => {
                          props.onAddModel(q.trim());
                          props.onModel(q.trim());
                          setOpen(false);
                        }}
                      >
                        把「{q.trim()}」当成模型 ID 加进来
                      </button>
                    </>
                  ) : null}
                </div>
              ) : (
                filtered.map((m) => (
                  <button
                    key={m.id}
                    className={`picker-item${m.id === props.model ? ' on' : ''}`}
                    onClick={() => {
                      props.onModel(m.id);
                      setOpen(false);
                    }}
                    title={m.id}
                  >
                    <span className="picker-item-id">{m.label ?? m.id}</span>
                    {m.custom ? <span className="badge-off">手动</span> : null}
                    {m.ownedBy ? <span className="picker-item-owner">{m.ownedBy}</span> : null}
                  </button>
                ))
              )}
            </div>

            {props.models.length > filtered.length && !q.trim() ? (
              <div className="picker-foot">只显示前 300 个，用上面的搜索框筛</div>
            ) : null}
            {q.trim() && !exact && filtered.length > 0 ? (
              <div className="picker-foot">回车选中第一条</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
