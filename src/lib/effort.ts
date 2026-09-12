/* ------------------------------------------------------------------ *
 * 思考强度：一档五级，各家的字段由映射表翻译
 *
 * 问题：同一件事（「多想一会儿」）各家的 API 长得完全不一样 ——
 *   OpenAI 系     reasoning_effort: "low" | "medium" | "high"
 *   Anthropic 系  thinking: { type: "enabled", budget_tokens: 12288 }
 *   通义/智谱系   enable_thinking: true, thinking_budget: 12288
 *   DeepSeek-R 系 没有开关，reasoner 模型always思考
 *
 * 所以对外只暴露一个五级刻度，切模型不用重学一遍。翻译规则放在一张
 * 可编辑的表里 —— 下面的默认值有几条是按厂商惯例推的，没有逐个实测，
 * 报 400 就去设置里改那一行，不用改代码。
 * ------------------------------------------------------------------ */

export type EffortLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: { value: EffortLevel; label: string; short: string }[] = [
  { value: 'off', label: '不下发', short: '—' },
  { value: 'low', label: '低', short: 'L' },
  { value: 'medium', label: '中', short: 'M' },
  { value: 'high', label: '高', short: 'H' },
  { value: 'xhigh', label: '超高', short: 'X' },
  { value: 'max', label: '拉满', short: '∞' },
];

/** 一家厂商把五级刻度翻译成请求字段的方式 */
export type EffortStyle = 'none' | 'openai' | 'anthropic' | 'qwen' | 'custom';

export const STYLE_LABEL: Record<EffortStyle, string> = {
  none: '不支持（不下发任何字段）',
  openai: 'reasoning_effort 字符串',
  anthropic: 'thinking 对象 + budget_tokens',
  qwen: 'enable_thinking + thinking_budget',
  custom: '自定义 JSON 模板',
};

export interface EffortMapping {
  id: string;
  /** 匹配模型 id 的正则（不区分大小写），第一条命中的生效 */
  pattern: string;
  label: string;
  style: EffortStyle;
  /**
   * 每一级翻译成什么。
   *   openai    → 字符串，例如 "low"
   *   anthropic → 数字，budget_tokens
   *   qwen      → 数字，thinking_budget
   *   custom    → JSON 片段字符串，直接浅合并进请求体
   * 值留空 = 这一级什么都不下发。
   */
  levels: Record<Exclude<EffortLevel, 'off'>, string>;
  /** 这条是不是我推的、没实测过 */
  unverified?: boolean;
}

const BUDGET = { low: '1024', medium: '4096', high: '12288', xhigh: '24576', max: '49152' };
const OPENAI_EFFORT = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

/**
 * 模型名里已经写死了强度的，一律不再下发字段。
 *
 * 聚合网关很常见这种命名：dva/claude-5-fable-high、xxx/gpt-5-minimal、
 * yyy/qwen3-thinking。后缀本身就是那条路由的思考预算，客户端再叠一个
 * reasoning_effort 或 thinking 对象上去，轻则被忽略，重则 400。
 *
 * 这条必须排在所有厂商规则前面 —— 否则 dva/claude-5-fable-high 会先被
 * 「claude」那条抓走，然后被塞进一个 thinking 对象。
 */
export const BAKED_IN_PATTERN =
  '[-_/](minimal|none|low|medium|mid|high|xhigh|x-high|extra-?high|max|ultra|thinking|think|reasoner|reasoning)(-?\\d+k?)?$';

export function defaultEffortMappings(): EffortMapping[] {
  return [
    {
      id: 'baked-in',
      pattern: BAKED_IN_PATTERN,
      label: '模型名自带强度',
      style: 'none',
      levels: { low: '', medium: '', high: '', xhigh: '', max: '' },
    },
    {
      id: 'anthropic',
      pattern: 'claude|anthropic|sonnet|opus|haiku',
      label: 'Claude',
      style: 'anthropic',
      levels: { ...BUDGET },
    },
    {
      id: 'openai',
      pattern: '^gpt|^o[1-9]|openai',
      label: 'OpenAI GPT / o 系',
      style: 'openai',
      // gpt-5 之后多了 minimal 这一档，低档用它更省
      levels: { ...OPENAI_EFFORT, low: 'minimal' },
    },
    {
      id: 'kimi',
      pattern: 'kimi|moonshot',
      label: 'Kimi / Moonshot',
      style: 'openai',
      levels: { ...OPENAI_EFFORT },
      unverified: true,
    },
    {
      id: 'qwen',
      pattern: 'qwen|tongyi|qwq',
      label: '通义千问',
      style: 'qwen',
      levels: { ...BUDGET },
    },
    {
      id: 'zhipu',
      pattern: 'glm|zhipu|chatglm',
      label: '智谱 GLM',
      style: 'qwen',
      levels: { ...BUDGET },
    },
    {
      id: 'deepseek',
      pattern: 'deepseek',
      label: 'DeepSeek',
      // reasoner 系是「一直思考」，没有强度开关；塞字段反而可能 400
      style: 'none',
      levels: { low: '', medium: '', high: '', xhigh: '', max: '' },
    },
    {
      id: 'sensenova',
      pattern: 'sensenova|sensechat|日日新',
      label: '商汤日日新',
      style: 'openai',
      levels: { ...OPENAI_EFFORT },
      unverified: true,
    },
    {
      id: 'fallback',
      pattern: '.*',
      label: '兜底（未知模型）',
      style: 'none',
      levels: { low: '', medium: '', high: '', xhigh: '', max: '' },
    },
  ];
}

export function matchMapping(model: string, mappings: EffortMapping[]): EffortMapping | null {
  for (const m of mappings) {
    if (!m.pattern.trim()) continue;
    try {
      if (new RegExp(m.pattern, 'i').test(model)) return m;
    } catch {
      // 正则写错就跳过这一条，不要整个功能挂掉
    }
  }
  return null;
}

/** 把「五级刻度 + 当前模型」翻译成要合并进请求体的字段 */
export function effortFields(
  model: string,
  level: EffortLevel,
  mappings: EffortMapping[],
): Record<string, unknown> {
  if (level === 'off') return {};

  const m = matchMapping(model, mappings);
  if (!m || m.style === 'none') return {};

  const raw = (m.levels?.[level] ?? '').trim();
  if (!raw) return {};

  switch (m.style) {
    case 'openai':
      return { reasoning_effort: raw };
    case 'anthropic': {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return {};
      return { thinking: { type: 'enabled', budget_tokens: n } };
    }
    case 'qwen': {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return {};
      return { enable_thinking: true, thinking_budget: n };
    }
    case 'custom':
      try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    default:
      return {};
  }
}

/** 给 UI 用的一句话说明：当前模型这一级会发出去什么 */
export function describeEffort(
  model: string,
  level: EffortLevel,
  mappings: EffortMapping[],
): string {
  if (!model) return '先选一个模型';
  const m = matchMapping(model, mappings);
  if (!m) return '没有匹配的映射规则';
  if (level === 'off') return `不下发任何思考字段（匹配到「${m.label}」）`;
  if (m.style === 'none') {
    return m.id === 'baked-in'
      ? '这个模型名里已经带了强度（网关把它烤进路由了），不下发任何字段'
      : `「${m.label}」这一档不支持强度调节，不下发`;
  }

  const fields = effortFields(model, level, mappings);
  if (!Object.keys(fields).length) return `「${m.label}」的这一级留空了，不下发`;
  return `匹配「${m.label}」→ ${JSON.stringify(fields)}`;
}
