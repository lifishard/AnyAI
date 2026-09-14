import type { GenerationConfig, ParamState } from '../types';
import { DEFAULT_ENABLED_TOOLS, toolsPayload } from './tools/registry';
import { effortFields, type EffortMapping } from './effort';
import { DEFAULT_RUNTIME, migrateRuntime, RUNTIME_MIGRATION_VERSION } from './task-context';

export type ParamKind = 'number' | 'int' | 'boolean' | 'string' | 'select';

export interface ParamDef {
  /** 直接作为请求体的字段名下发 */
  key: string;
  label: string;
  kind: ParamKind;
  group: '采样' | '长度' | '惩罚' | '其他';
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  default: number | string | boolean;
  help: string;
}

/**
 * 可调参数清单。想加一个新参数，只要在这里补一行，
 * UI 表单和请求体下发会自动跟上 —— 不需要改任何组件代码。
 */
export const PARAM_DEFS: ParamDef[] = [
  {
    key: 'temperature',
    label: '温度 temperature',
    kind: 'number',
    group: '采样',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.8,
    help: '越高越发散。日日新官方建议 0.6–1.0；代码/数学类任务取低值。',
  },
  {
    key: 'top_p',
    label: '核采样 top_p',
    kind: 'number',
    group: '采样',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.9,
    help: '只从累计概率前 p 的词里采样。官方建议 0.8–1.0。与 temperature 通常只调一个。',
  },
  {
    key: 'top_k',
    label: 'top_k',
    kind: 'int',
    group: '采样',
    min: 0,
    max: 200,
    step: 1,
    default: 30,
    help: '只从概率最高的 k 个词里采样。官方建议 20–40。部分模型不支持，报 400 就关掉。',
  },
  {
    key: 'min_p',
    label: 'min_p',
    kind: 'number',
    group: '采样',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    help: '低于「最高概率 × min_p」的词直接丢弃。官方示例给 0。',
  },
  {
    key: 'max_tokens',
    label: '最大输出 max_tokens',
    kind: 'int',
    group: '长度',
    min: 1,
    max: 131072,
    step: 64,
    default: 4096,
    help: '单次回复最多生成多少 token。思考模型要留足，否则思考没结束就被截断。',
  },
  {
    key: 'max_completion_tokens',
    label: 'max_completion_tokens',
    kind: 'int',
    group: '长度',
    min: 1,
    max: 131072,
    step: 64,
    default: 4096,
    help: 'OpenAI 兼容模式 v2 用这个名字。和 max_tokens 二选一，别同时开。',
  },
  {
    key: 'n',
    label: '生成条数 n',
    kind: 'int',
    group: '长度',
    min: 1,
    max: 8,
    step: 1,
    default: 1,
    help: '一次返回几条候选。本客户端只展示第一条，一般保持关闭。',
  },
  {
    key: 'presence_penalty',
    label: 'presence_penalty',
    kind: 'number',
    group: '惩罚',
    min: -2,
    max: 2,
    step: 0.1,
    default: 0,
    help: '出现过的 token 再出现时降权，鼓励换话题。官方建议 0–2。',
  },
  {
    key: 'frequency_penalty',
    label: 'frequency_penalty',
    kind: 'number',
    group: '惩罚',
    min: -2,
    max: 2,
    step: 0.1,
    default: 0,
    help: '按出现频次降权，抑制车轱辘话。',
  },
  {
    key: 'repetition_penalty',
    label: 'repetition_penalty',
    kind: 'number',
    group: '惩罚',
    min: 0.5,
    max: 2,
    step: 0.01,
    default: 1,
    help: '1 = 不惩罚，>1 抑制重复。官方示例给 1.0。',
  },
  {
    key: 'seed',
    label: '随机种子 seed',
    kind: 'int',
    group: '其他',
    min: 0,
    max: 2147483647,
    step: 1,
    default: 42,
    help: '固定种子可复现结果（服务端不保证）。做实验时有用。',
  },
  {
    key: 'stop',
    label: '停止词 stop',
    kind: 'string',
    group: '其他',
    default: '',
    help: '命中即停止生成。多个用英文逗号分隔，会转成数组下发。',
  },
  {
    key: 'user',
    label: '用户标识 user',
    kind: 'string',
    group: '其他',
    default: '',
    help: '透传给服务端的调用方标识，用于风控/审计。不需要就关掉。',
  },
];

export const PARAM_GROUPS: ParamDef['group'][] = ['采样', '长度', '惩罚', '其他'];

/**
 * 默认全部关闭 —— 关闭 = 该字段根本不出现在请求体里，走服务端默认值。
 *
 * max_tokens 以前默认开着（4096）。那意味着**每一次请求都自带一个输出天花板**，
 * 而这个天花板既不是模型的、也不是用户挑的，是这行代码替人定的。长文、长代码、
 * 长思考全都会在那个数字上被切断，现象是「答到一半没了」，原因却藏在一个
 * 没人动过的默认值里。
 *
 * 现在默认不发：上游自己知道它最多能输出多少，那个数字永远比我们猜的准。
 */
export function defaultParams(): Record<string, ParamState> {
  const out: Record<string, ParamState> = {};
  for (const d of PARAM_DEFS) {
    out[d.key] = {
      enabled: false,
      value: d.default,
    };
  }
  return out;
}

export function defaultGenerationConfig(): GenerationConfig {
  return {
    model: '',
    stream: true,
    systemPrompt: '',
    historyLimit: 0,
    effortLevel: 'medium',
    thinkingStyle: 'auto',
    reasoningEffort: 'medium',
    thinkingBudget: 2048,
    params: defaultParams(),
    customBody: '',
    toolsEnabled: true,
    enabledTools: [...DEFAULT_ENABLED_TOOLS],
    maxToolRounds: 30,
    approvalMode: 'ask',
    runtime: { ...DEFAULT_RUNTIME, contextMode: 'auto', semanticCompression: true, milestones: true,
      runtimeMigrationVersion: RUNTIME_MIGRATION_VERSION } as GenerationConfig['runtime'],
  };
}

/** 老配置补上新增参数的默认值，避免升级后缺字段 */
export function mergeParamDefaults(cfg: GenerationConfig): GenerationConfig {
  const merged: Record<string, ParamState> = { ...defaultParams() };
  for (const [k, v] of Object.entries(cfg.params ?? {})) {
    merged[k] = v;
  }
  const base = defaultGenerationConfig();
  const out = { ...base, ...cfg, params: merged };
  // 老版本存下来的配置不会有 Agent 相关字段，补齐，别让 undefined 漏下去
  if (!Array.isArray(out.enabledTools)) out.enabledTools = base.enabledTools;
  if (!cfg.runtime && out.toolsEnabled) {
    out.enabledTools = [...new Set([...out.enabledTools, 'read_tool_result', 'register_outputs'])];
    if (out.enabledTools.some((n) => n.startsWith('chrome_'))) out.enabledTools.push('chrome_fetch_json');
  }
  out.runtime = { ...migrateRuntime(cfg.runtime), contextMode: cfg.runtime?.contextMode ?? base.runtime!.contextMode };
  // The old UI inferred manual mode from a non-default context value.  The
  // value is now always a soft organization target, so retain the field only
  // for compatibility and never let it change dispatch behavior.
  if (!cfg.runtime?.contextMode) out.runtime.contextMode = base.runtime!.contextMode;
  // The old default was sent on every request and accidentally disabled long
  // runs.  Exact legacy defaults are migrated; other user budgets survive.
  const legacyTemperature = cfg.params?.temperature;
  const migrateLegacy = cfg.runtime?.runtimeMigrationVersion !== RUNTIME_MIGRATION_VERSION;
  if (migrateLegacy && legacyTemperature?.enabled === true && Number(legacyTemperature.value) === 0.8) {
    out.params.temperature = { ...legacyTemperature, enabled: false };
  }
  if (typeof out.maxToolRounds !== 'number') out.maxToolRounds = base.maxToolRounds;
  if (typeof out.toolsEnabled !== 'boolean') out.toolsEnabled = base.toolsEnabled;
  if (out.approvalMode !== 'ask' && out.approvalMode !== 'auto' && out.approvalMode !== 'all') {
    out.approvalMode = base.approvalMode;
  }
  if (!out.effortLevel) out.effortLevel = base.effortLevel;
  if (!out.thinkingStyle) out.thinkingStyle = base.thinkingStyle;
  return out;
}

/** 多模态消息里的一段内容 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** 直接放进请求体 messages 数组的那种消息 */
export interface WireMessage {
  role: string;
  /** 纯文本用字符串；带图片时用分段数组 */
  content: string | ContentPart[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

/**
 * 把配置翻译成请求体。
 * 原则：关掉的参数一个字段都不下发，让服务端用自己的默认值，
 * 避免把不支持的字段塞给某些模型导致 400。
 *
 * @param toolNames 本次允许模型调用的工具名单；空数组表示不下发 tools 字段
 */
export function buildRequestBody(
  cfg: GenerationConfig,
  messages: WireMessage[],
  toolNames: string[] = [],
  effortMappings: EffortMapping[] = [],
  /** 这次请求还剩多少窗口 —— 思考预算按它夹一下，见 effort.ts 的说明 */
  roomLeft: number | null = null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: cfg.stream,
  };

  // The question card is a renderer-owned interaction.  It is allowed in
  // Chat even when host tools are disabled; every other tool still follows
  // the normal toolsEnabled switch.
  const questionTool = toolNames.includes('request_user_input') ? ['request_user_input'] : [];
  const hostToolNames = toolNames.filter((name) => name !== 'request_user_input');
  if (questionTool.length || (cfg.toolsEnabled && hostToolNames.length)) {
    // 排序是为了上下文缓存：缓存按前缀逐字节匹配，工具勾选顺序一变
    // 序列化出来的 tools 就变了，整段前缀跟着失配，缓存永远命中不了
    body.tools = toolsPayload([...(cfg.toolsEnabled ? hostToolNames : []), ...questionTool].sort());
    body.tool_choice = 'auto';
  }
  if (cfg.stream) {
    // 要求服务端在最后一个 chunk 里带 usage（OpenAI 兼容行为，不支持也无害）
    body.stream_options = { include_usage: true };
  }

  for (const def of PARAM_DEFS) {
    const st = cfg.params[def.key];
    if (!st || !st.enabled) continue;
    if (def.key === 'stop') {
      const parts = String(st.value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length) body.stop = parts;
      continue;
    }
    if (def.kind === 'string' && String(st.value).trim() === '') continue;
    body[def.key] = st.value;
  }

  switch (cfg.thinkingStyle) {
    case 'auto':
      // 五级刻度 → 按当前模型匹配到的厂商写法翻译
      Object.assign(body, effortFields(cfg.model, cfg.effortLevel, effortMappings, roomLeft));
      break;
    case 'reasoning_effort':
      body.reasoning_effort = cfg.reasoningEffort;
      break;
    case 'enable_thinking':
      body.enable_thinking = true;
      body.thinking_budget = cfg.thinkingBudget;
      break;
    case 'thinking_object':
      body.thinking = { type: 'enabled', budget_tokens: cfg.thinkingBudget };
      break;
    case 'custom':
    case 'off':
    default:
      break;
  }

  if (cfg.customBody && cfg.customBody.trim()) {
    try {
      const extra = JSON.parse(cfg.customBody);
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        Object.assign(body, extra);
      }
    } catch {
      /* 由 UI 负责校验并提示，这里静默忽略 */
    }
  }

  return body;
}
