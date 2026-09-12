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

/* ------------------------------------------------------------------ *
 * 强度 ≠ 预算
 *
 * 用户的原话：「reasoning effort 不应该绑定预算」。这条批评是对的。
 *
 * 「多想一会儿」是个意图，"12288 tokens" 是一个会过期的实现细节：换条路由、
 * 上下文长一点，同一个数字就从「想得深」变成「400」。OpenAI 系那边本来就
 * 只发 low/medium/high 三个词，没有这个问题；出问题的是 anthropic / qwen
 * 这类**必须填一个数字**的接口。
 *
 * 所以数字不再是写死的常量，而是**在发请求那一刻按剩余窗口算出来的**：
 * 五级刻度只决定「占剩余空间的几成」，具体数字交给 clampBudget。
 * 表里那些默认值退化成「不知道窗口时的兜底」。
 * ------------------------------------------------------------------ */

/** 每一级想占用「剩余可用空间」的比例 */
const BUDGET_SHARE: Record<Exclude<EffortLevel, 'off'>, number> = {
  low: 0.05,
  medium: 0.15,
  high: 0.35,
  xhigh: 0.55,
  max: 0.8,
};

/**
 * 把一个思考预算夹到这次请求真的放得下的范围里。
 *
 * roomLeft = 这条路由的窗口 − 已经占掉的输入。不知道窗口就返回原值 ——
 * 猜一个窗口去压，比不压更容易压错。
 */
export function clampBudget(
  want: number,
  level: Exclude<EffortLevel, 'off'>,
  roomLeft: number | null,
): number {
  if (!roomLeft || roomLeft <= 0) return want;
  const byShare = Math.floor(roomLeft * BUDGET_SHARE[level]);
  // 至少留 256，不然「开了思考但一个 token 都不给」比不开还糟
  return Math.max(256, Math.min(want, byShare));
}

/** 把「五级刻度 + 当前模型」翻译成要合并进请求体的字段 */
export function effortFields(
  model: string,
  level: EffortLevel,
  mappings: EffortMapping[],
  /** 这次请求还剩多少窗口可用；不知道就不传 */
  roomLeft: number | null = null,
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
      return { thinking: { type: 'enabled', budget_tokens: clampBudget(n, level, roomLeft) } };
    }
    case 'qwen': {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return {};
      return { enable_thinking: true, thinking_budget: clampBudget(n, level, roomLeft) };
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
