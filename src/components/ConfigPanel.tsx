import React from 'react';
import type { GenerationConfig, KeyProfile, ModelInfo, ReasoningEffort, ThinkingStyle } from '../types';
import { PARAM_DEFS, PARAM_GROUPS } from '../lib/paramSchema';
import { GROUP_LABEL, TOOLS, availableTools, type ToolGroup } from '../lib/tools/registry';
import { Field, Segmented, Switch } from './ui';
import { runtimePolicy } from '../lib/task-context';
import RouteSettings from './RouteSettings';

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
  profile?: KeyProfile | null;
  onProfileChange?: (profile: KeyProfile) => void;
  config: GenerationConfig;
  onChange: (patch: Partial<GenerationConfig>) => void;
  models: ModelInfo[];
  modelsLoading: boolean;
  modelsError: string | null;
  onRefreshModels: () => void;
  onAddModel: (id: string) => void;
  /* 上面几个现在只有历史遗留的调用还在传，面板本身不用了 */
  onPreview: () => void;
  /** 看最近一次请求的原文 —— 猜不动的时候用它 */
  onRawDump: () => void;
  onSaveAsDefault: () => void;
  hasKey: boolean;
  canRunHostTools: boolean;
}) {
  const { config: cfg, onChange } = props;
  const runtime = runtimePolicy(cfg);

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
      <div className="section">
        <div className="section-title">连续工作</div>
        <div className="hint">任务会保存进度，在临时限流或断网后等待恢复。阶段预算用完会暂停，接着跑可开启下一阶段。</div>
        <p className="hint">1M 是上下文建议值，超过仍可继续。实际可发送大小取决于所选模型与上游额度。以下设置在下次启动或续跑时生效。</p>
        <Switch label="接近建议值时提醒（90%）" checked={runtime.contextAdvisory === true} onChange={v => onChange({ runtime:{ ...runtime,contextAdvisory:v } })} />
        <Switch label="接近建议值时自动打开交接草稿" checked={runtime.autoHandoff === true} onChange={v => onChange({ runtime:{ ...runtime,autoHandoff:v } })} />
        <p className="hint">交接会打开新对话并预填上下文，由你决定是否修改、发送。原任务继续运行，不会启动后台 agent。</p>
        <Switch label="自动压缩历史（使用当前模型，计入用量）" checked={runtime.semanticCompression !== false} onChange={v => onChange({ runtime:{ ...runtime,semanticCompression:v } })} />
        <Switch label="允许模型按需维护里程碑" checked={runtime.milestones !== false} onChange={v => onChange({ runtime:{ ...runtime,milestones:v } })} />
        {([
          ['contextTokens', '上下文建议值（token）', '默认 1,000,000；用于整理历史和可选提醒，不是停止任务的硬上限。'],
          ['tpm', '每分钟 token 额度（TPM）', '填上游真实额度；0 表示从响应头或报错学习，未知时使用退避。'],
          ['rpm', '每分钟请求额度（RPM）', '同一份凭据的请求统一排队；0 表示从上游学习。'],
          ['maxTokens', '每阶段 token 预算', '按实际用量累计，无 usage 时保守估算。0 表示不限制。'],
          ['maxMinutes', '每阶段最长时间（分钟）', '包括执行和等待。0 表示不限制。'],
          ['recoveryMinutes', '单次中断最多自动等待（分钟）', '达到后保留现场，等待你接着跑。'],
        ] as const).map(([key, label, hint]) => <Field key={key} label={label} hint={hint}>
          <input type="number" min={key === 'contextTokens' ? 2048 : 0} value={runtime[key]}
            onChange={(e) => onChange({ runtime: { ...runtime, [key]: Math.max(0, Number(e.target.value) || 0) } })} />
        </Field>)}
      </div>
      {props.profile && props.onProfileChange ? <RouteSettings profile={props.profile} config={cfg} onChange={props.onProfileChange} /> : null}
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
              hint={
                cfg.maxToolRounds > 200
                  ? '一次提问里模型最多能来回调几轮工具。旧的工具输出会被自动压缩，所以调高不会直接把上下文撑爆 —— ' +
                    '但每一轮都是一次真实的 API 调用：调到几百意味着一个问题可能烧掉几百次请求，跑偏了也不会自己停。' +
                    '建议配合「逐步确认」用，别跟「全部放行」叠在一起。'
                  : '每阶段最多调用几轮工具。到顶后保存阶段汇总并暂停，可接着跑。较早工具输出会缩短，桌面端保留完整证据。'
              }
            >
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  type="range"
                  style={{ flex: 1 }}
                  min={1}
                  max={1000}
                  // 低位精细、高位粗调：1~100 那一段每 1 格有意义，
                  // 几百之后差 5 轮跟差 1 轮没区别，但滑块得能一路拖到头
                  step={cfg.maxToolRounds >= 100 ? 10 : 1}
                  value={cfg.maxToolRounds}
                  onChange={(e) => onChange({ maxToolRounds: Number(e.target.value) })}
                />
                {/* 滑块拖到精确值很难，所以再给一个能直接敲数字的框 */}
                <input
                  type="number"
                  style={{ width: 78 }}
                  min={1}
                  max={1000}
                  value={cfg.maxToolRounds}
                  onChange={(e) =>
                    onChange({
                      maxToolRounds: Math.max(1, Math.min(1000, Number(e.target.value) || 1)),
                    })
                  }
                />
              </div>
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

        <p className="hint">任务上下文按当前模型窗口自动整理，保留用户要求、总结和可检索的原始证据。切换模型后继续使用同一份任务记录；旧版“历史条数”限制已停用。</p>
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
              {/* 输出上限是最容易被误伤的一个：开着它，长回答会在这个数字上
                  被切断，而现象（答到一半没了）离原因（这个勾）太远 */}
              {group === '长度' && cfg.params.max_tokens?.enabled ? (
                <div className="hint" style={{ marginTop: 4 }}>
                  ⚠ 开着 max_tokens = 单轮输出被 {String(cfg.params.max_tokens.value)} token
                  封顶，长回答会在这里被切断。取消勾选就交给上游用它自己的最大值。
                </div>
              ) : null}
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

      <div className="row" style={{ gap: 8 }}>
        <button
          className="btn sm"
          onClick={props.onRawDump}
          style={{ flex: 1 }}
          title="最近一次请求实际发出去的内容，和上游一个字节都没改的回复原文。模型「说要调工具然后没动静」时，答案就在这里面"
        >
          最近一次原始往返
        </button>
      </div>
    </div>
  );
}
