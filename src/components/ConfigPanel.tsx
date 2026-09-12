import React from 'react';
import type { GenerationConfig, ModelInfo, ReasoningEffort, ThinkingStyle } from '../types';
import { PARAM_DEFS, PARAM_GROUPS } from '../lib/paramSchema';
import { GROUP_LABEL, TOOLS, availableTools, type ToolGroup } from '../lib/tools/registry';
import { Field, Segmented, Switch } from './ui';

const THINKING_OPTIONS: { value: ThinkingStyle; label: string }[] = [
  { value: 'auto', label: '自动（按模型映射）— 推荐' },
  { value: 'off', label: '完全不下发' },
  { value: 'reasoning_effort', label: '手动：reasoning_effort 字符串' },
  { value: 'enable_thinking', label: '手动：enable_thinking + 预算' },
  { value: 'thinking_object', label: '手动：thinking 对象 + 预算' },
  { value: 'custom', label: '手动：自己写在附加请求字段里' },
];

const EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

export default function ConfigPanel(props: {
  config: GenerationConfig;
  onChange: (patch: Partial<GenerationConfig>) => void;
  models: ModelInfo[];
  modelsLoading: boolean;
  modelsError: string | null;
  onRefreshModels: () => void;
  onAddModel: (id: string) => void;
  /* 上面几个现在只有历史遗留的调用还在传，面板本身不用了 */
  onPreview: () => void;
  onSaveAsDefault: () => void;
  hasKey: boolean;
  canRunHostTools: boolean;
}) {
  const { config: cfg, onChange } = props;

  const customBodyError = React.useMemo(() => {
    const s = cfg.customBody.trim();
    if (!s) return null;
    try {
      const v = JSON.parse(s);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return '必须是一个 JSON 对象';
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'JSON 解析失败';
    }
  }, [cfg.customBody]);

  function setParam(key: string, patch: Partial<{ enabled: boolean; value: number | string | boolean }>) {
    onChange({
      params: {
        ...cfg.params,
        [key]: { ...cfg.params[key], ...patch },
      },
    });
  }

  return (
    <div>
      {/* ---------------- 模型 ---------------- */}
      <div className="section">
        <div className="section-title">模型</div>
        <div className="hint" style={{ marginBottom: 12 }}>
          模型和凭据的选择挪到<strong>输入框左下角</strong>了 —— 那里带搜索，几百个模型也翻得动，
          而且改的是<strong>当前这个会话</strong>的绑定，不影响别的对话。
          <br />
          当前：<code>{cfg.model || '未选择'}</code>
        </div>

        <div className="field">
          <Switch checked={cfg.stream} onChange={(v) => onChange({ stream: v })} label="流式响应" />
          <div className="hint">
            开启后逐字返回（SSE）；关掉则等整段生成完一次性返回。调试接口时关掉更容易看清完整响应。
          </div>
        </div>
      </div>

      {/* ---------------- 工具 ---------------- */}
      <div className="section">
        <div className="section-title">工具</div>

        <div className="field">
          <Switch
            checked={cfg.toolsEnabled}
            onChange={(v) => onChange({ toolsEnabled: v })}
            label="允许模型调用工具"
          />
          <div className="hint">
            关掉就是纯聊天，请求体里不会出现 tools 字段。模型不支持 function calling 时必须关掉，否则会报 400。
          </div>
        </div>

        {cfg.toolsEnabled ? (
          <>
            <Field
              label={`工具调用轮次上限：${cfg.maxToolRounds}`}
              hint="一次提问里模型最多能来回调几轮工具。到顶了会强制它用已有信息作答。旧的工具输出会被自动压缩，所以调高不会直接把上下文撑爆。"
            >
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                value={cfg.maxToolRounds}
                onChange={(e) => onChange({ maxToolRounds: Number(e.target.value) })}
              />
            </Field>

            {!props.canRunHostTools ? (
              <div className="hint" style={{ color: 'var(--warn)', marginBottom: 10 }}>
                这台设备不能直接执行本地工具（文件、命令行、Chrome、Claude Code）。
                去 设置 → 遥控 配好电脑地址后，这些工具会转发到电脑上执行。
              </div>
            ) : null}

            {(Object.keys(GROUP_LABEL) as ToolGroup[]).map((group) => {
              const defs = TOOLS.filter((t) => t.group === group);
              if (!defs.length) return null;
              const usable = new Set(availableTools(props.canRunHostTools).map((t) => t.name));
              const allOn = defs.every((d) => cfg.enabledTools.includes(d.name));

              return (
                <div key={group} style={{ marginBottom: 12 }}>
                  <div className="row" style={{ marginBottom: 2 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fg-dim)' }}>
                      {GROUP_LABEL[group]}
                    </span>
                    <span style={{ flex: 1 }} />
                    <button
                      className="btn sm ghost"
                      onClick={() => {
                        const names = defs.map((d) => d.name);
                        onChange({
                          enabledTools: allOn
                            ? cfg.enabledTools.filter((n) => !names.includes(n))
                            : [...new Set([...cfg.enabledTools, ...names])],
                        });
                      }}
                    >
                      {allOn ? '全关' : '全开'}
                    </button>
                  </div>

                  <div className="tool-grid">
                    {defs.map((d) => {
                      const on = cfg.enabledTools.includes(d.name);
                      const can = usable.has(d.name);
                      return (
                        <label key={d.name} className="tool-row" title={d.description}>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={!can}
                            onChange={(e) =>
                              onChange({
                                enabledTools: e.target.checked
                                  ? [...new Set([...cfg.enabledTools, d.name])]
                                  : cfg.enabledTools.filter((n) => n !== d.name),
                              })
                            }
                          />
                          <span className="tool-name">
                            {d.label} <span className="tool-code">{d.name}</span>
                          </span>
                          {d.dangerous ? <span className="badge-danger">需确认</span> : null}
                          {!can ? <span className="badge-off">本机不可用</span> : null}
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </>
        ) : null}
      </div>

      {/* ---------------- 思考强度 ---------------- */}
      <div className="section">
        <div className="section-title">思考强度</div>

        <Field
          label="下发方式"
          hint={
            cfg.thinkingStyle === 'auto'
              ? '按当前模型匹配映射表，自动翻译成那家该用的字段。档位在输入框右下角选。'
              : '手动指定字段，绕过映射表。只有在映射表搞不定某个模型时才需要。'
          }
        >
          <select
            value={cfg.thinkingStyle}
            onChange={(e) => onChange({ thinkingStyle: e.target.value as ThinkingStyle })}
          >
            {THINKING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>

        {cfg.thinkingStyle === 'auto' ? (
          <div className="hint">
            当前档位：<strong>{cfg.effortLevel}</strong>。映射规则在 设置 → 思考强度 里改。
          </div>
        ) : null}

        {cfg.thinkingStyle === 'reasoning_effort' ? (
          <Field label="强度" hint="不是所有模型都认这四档，报 400 就换一种下发方式。">
            <Segmented
              value={cfg.reasoningEffort}
              options={EFFORTS.map((e) => ({ value: e, label: e }))}
              onChange={(v) => onChange({ reasoningEffort: v })}
            />
          </Field>
        ) : null}

        {cfg.thinkingStyle === 'enable_thinking' || cfg.thinkingStyle === 'thinking_object' ? (
          <Field
            label={`思考预算：${cfg.thinkingBudget} tok`}
            hint="给思考链留的 token 上限。留太少会出现「想到一半就被截断」。"
          >
            <input
              type="range"
              min={256}
              max={32768}
              step={256}
              value={cfg.thinkingBudget}
              onChange={(e) => onChange({ thinkingBudget: Number(e.target.value) })}
            />
          </Field>
        ) : null}
      </div>

      {/* ---------------- 上下文 ---------------- */}
      <div className="section">
        <div className="section-title">上下文</div>

        <Field label="System Prompt" hint="留空则不下发 system 消息。">
          <textarea
            rows={4}
            value={cfg.systemPrompt}
            placeholder="例如：你是一个严谨的量化研究助手，回答用中文，代码用 Python。"
            onChange={(e) => onChange({ systemPrompt: e.target.value })}
          />
        </Field>

        <Field
          label="携带历史条数"
          hint="0 = 带上全部历史。长对话把这个调小能显著省 token。"
        >
          <input
            type="number"
            min={0}
            max={200}
            value={cfg.historyLimit}
            onChange={(e) => onChange({ historyLimit: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
      </div>

      {/* ---------------- 采样参数 ---------------- */}
      <div className="section">
        <div className="section-title">生成参数</div>
        <div className="hint" style={{ marginBottom: 10 }}>
          勾选才会下发。没勾的字段压根不出现在请求体里，走服务端默认值——这样某个模型不认识某个参数时不会直接 400。
        </div>

        {PARAM_GROUPS.map((group) => {
          const defs = PARAM_DEFS.filter((d) => d.group === group);
          if (!defs.length) return null;
          return (
            <div key={group} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fg-dim)', marginBottom: 2 }}>
                {group}
              </div>
              {defs.map((d) => {
                const st = cfg.params[d.key] ?? { enabled: false, value: d.default };
                return (
                  <div key={d.key} className="param-row" title={d.help}>
                    <input
                      type="checkbox"
                      checked={st.enabled}
                      onChange={(e) => setParam(d.key, { enabled: e.target.checked })}
                      aria-label={`启用 ${d.key}`}
                    />
                    <span className={`name${st.enabled ? '' : ' off'}`}>{d.label}</span>
                    {d.kind === 'string' ? (
                      <input
                        type="text"
                        value={String(st.value)}
                        disabled={!st.enabled}
                        onChange={(e) => setParam(d.key, { value: e.target.value })}
                      />
                    ) : (
                      <input
                        type="number"
                        min={d.min}
                        max={d.max}
                        step={d.step}
                        value={Number(st.value)}
                        disabled={!st.enabled}
                        onChange={(e) => setParam(d.key, { value: Number(e.target.value) })}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* ---------------- 自由字段 ---------------- */}
      <div className="section">
        <div className="section-title">附加请求字段</div>
        <Field
          label="JSON 对象，最后浅合并进请求体"
          hint={
            customBodyError ? (
              <span style={{ color: 'var(--danger)' }}>{customBodyError}</span>
            ) : (
              '上面没有覆盖到的参数写这里，例如 {"knowledge_config": {...}} 或 {"plugins": [...]}。同名字段会覆盖上面的设置。'
            )
          }
        >
          <textarea
            className="mono"
            rows={4}
            spellCheck={false}
            value={cfg.customBody}
            placeholder={'{\n  "response_format": { "type": "json_object" }\n}'}
            onChange={(e) => onChange({ customBody: e.target.value })}
          />
        </Field>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm" onClick={props.onPreview} style={{ flex: 1 }}>
          查看请求体
        </button>
        <button className="btn sm" onClick={props.onSaveAsDefault} style={{ flex: 1 }}>
          存为新会话默认
        </button>
      </div>
    </div>
  );
}
