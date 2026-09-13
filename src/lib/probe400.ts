import type { GenerationConfig } from '../types';
import { buildRequestBody } from './paramSchema';
import type { EffortMapping } from './effort';
import { isRateLimited, isTokenLimit, spacingForTokens } from './pacer';
import { checkWire } from './wirecheck';
import { estimateRequestTokens } from './limits';
import type { WireMessage } from './paramSchema';

/* ------------------------------------------------------------------ *
 * 400 自动排查
 *
 * `inference request is invalid (code 400001)` 这种报错说了等于没说：请求体里
 * 有几十个字段，它一个都没点名。人能做的只有一个个去掉再试 —— 而这件事
 * 机器做得比人快得多，也比人有耐心。
 *
 * 所以这里做的就是那个「一个个试」：从**最小请求体**开始，每次只加回一组
 * 字段，第一个失败的那组就是凶手。
 *
 * 为什么是「从小加回去」而不是「从大删下去」：
 *   - 最小请求体先跑通，顺带证明了 key、模型名、地址这三样是好的，
 *     后面所有失败都能干净地归因到字段上；
 *   - 反过来删的话，第一刀就删对了也说明不了问题 —— 你不知道剩下的部分
 *     是不是也有毛病。
 *
 * 工具那一组单独再做一次二分：23 个工具里坏掉一个，逐个试要 23 次请求，
 * 二分只要 5 次左右。
 *
 * 每次探测都用一条极短的消息、关掉流式、只要 1 个 token —— 这是在花用户的钱
 * 查问题，能省一点是一点。
 * ------------------------------------------------------------------ */

export interface ProbeStep {
  label: string;
  ok: boolean;
  error?: string;
}

export interface ProbeReport {
  steps: ProbeStep[];
  /** 一句话结论 */
  verdict: string;
  /** 被点名的工具（只有工具那一组出问题时才有） */
  badTools?: string[];
}

export type Sender = (
  body: Record<string, unknown>,
) => Promise<{ ok: boolean; error?: string; status?: number }>;

/** 排查过程中确认「配额真的用尽了」时抛它 —— 这是结论，不是意外 */
class QuotaExhausted extends Error {
  /** 上游报限流时用的 HTTP 状态码。不是 429 的话，那本身也是它的毛病 */
  status?: number;
  // 刻意不用「构造函数参数属性」那种写法：它需要额外的转译支持，
  // 而这个文件要能被 node --experimental-strip-types 直接跑起来做测试
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * 限流也是一种错误 —— 关键在于**它是谁造成的**。
 *
 * 上一版把限流当噪音：撞到就重试，试满就说「这次不下结论」。那是在回避问题。
 * 真正该做的是让排查本身**在设计上不可能触发限流**，这样一旦收到限流，
 * 责任方就只可能是配额本身，于是它从噪音变成了信号 —— 一个确定的结论。
 *
 * 两件事一起做才成立：
 *   1. 每次探测之间强制拉开 PROBE_SPACING，比任何正常对话都慢得多；
 *   2. 在这个节奏下**仍然**收到限流，就隔更久再确认一次（排除「别处正好
 *      在用同一把 key」这种巧合），两次都限流 = 配额确实见底了。
 *
 * 顺带一提：这条线路把限流报成 HTTP 400 而不是 429，本身就是它的协议问题。
 * 结论里会点出来 —— 客户端能自动退避的前提，是错误码得说实话。
 */
export const PROBE_SPACING_MS = 3000;
/** 确认那一次等更久：短时突发到这会儿早该过去了 */
const CONFIRM_WAIT_MS = 20_000;

/** 撞到 TPM 时得等满一个窗口 —— 20 秒起不到作用，只是白撞一次 */
const TOKEN_WINDOW_MS = 65_000;

function guarded(send: Sender, onNote?: (s: string) => void): Sender {
  return async (body) => {
    const r = await send(body);
    if (r.ok || !isRateLimited(r.error ?? '', r.status)) return r;

    // TPM 和 RPM 是两条线。撞 TPM 要等满一分钟窗口，按 20 秒等回去只会再撞一次
    const wait = isTokenLimit(r.error ?? '') ? TOKEN_WINDOW_MS : CONFIRM_WAIT_MS;
    onNote?.(
      `收到限流（${isTokenLimit(r.error ?? '') ? '每分钟 token 上限' : '每分钟请求数上限'}），` +
        `${Math.round(wait / 1000)} 秒后再确认一次…`,
    );
    await new Promise((res) => setTimeout(res, wait));

    const again = await send(body);
    if (again.ok || !isRateLimited(again.error ?? '', again.status)) return again;
    throw new QuotaExhausted(again.error ?? r.error ?? '限流', again.status ?? r.status);
  };
}

const PING = [{ role: 'user', content: 'hi' }];

/** 最小到不能再小：只有模型和一条消息 */
function minimal(model: string): Record<string, unknown> {
  return { model, messages: PING, max_tokens: 1 };
}

/**
 * 在工具列表里二分找出「加上它就 400」的那些。
 *
 * 注意坏的可能不止一个，所以两边都要查，不是找到一个就收工。
 */
async function bisectTools(
  model: string,
  names: string[],
  base: Record<string, unknown>,
  send: Sender,
  steps: ProbeStep[],
  depth = 0,
): Promise<string[]> {
  if (!names.length || depth > 8) return [];

  // stream 必须显式关掉：base 是一层层攒出来的，里面带着上一层加回去的
  // stream:true。带流去探测既慢又可能把错误藏进流里
  const body = { ...base, ...buildToolsOnly(names), stream: false };
  const r = await send(body);
  steps.push({ label: `工具 ×${names.length}：${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`, ok: r.ok, error: r.error });
  if (r.ok) return [];
  if (names.length === 1) return names;

  const mid = Math.floor(names.length / 2);
  const left = await bisectTools(model, names.slice(0, mid), base, send, steps, depth + 1);
  const right = await bisectTools(model, names.slice(mid), base, send, steps, depth + 1);
  // 两边单独都能过，却合在一起过不了 —— 那是数量或总长度的问题，不是某一个坏
  if (!left.length && !right.length) return names;
  return [...left, ...right];
}

/** 这个名字真的会变成请求体里的一个 tool 吗 */
function serializes(name: string): boolean {
  const b = buildToolsOnly([name]);
  return Array.isArray(b.tools) && b.tools.length === 1;
}

function buildToolsOnly(names: string[]): Record<string, unknown> {
  // 走跟真实请求同一条拼装路径，否则探出来的结论对不上真实请求体
  const fake: GenerationConfig = {
    model: '', stream: false, systemPrompt: '', historyLimit: 0,
    effortLevel: 'off', thinkingStyle: 'off', reasoningEffort: 'medium',
    thinkingBudget: 0, params: {}, customBody: '',
    toolsEnabled: true, enabledTools: names, maxToolRounds: 1, approvalMode: 'ask',
  };
  const b = buildRequestBody(fake, [], names, []);
  return { tools: b.tools, tool_choice: b.tool_choice };
}

export async function probe400(
  cfg: GenerationConfig,
  toolNames: string[],
  effortMappings: EffortMapping[],
  rawSend: Sender,
  /** 每走完一步回调一次。排查要跑几十秒，没有实时反馈的话界面就是一片空白 */
  onProgress?: (steps: ProbeStep[], note?: string) => void,
): Promise<ProbeReport> {
  const steps: ProbeStep[] = [];
  const model = cfg.model;
  const send = guarded(rawSend, (note) => onProgress?.(steps, note));
  const tracked: Sender = async (body) => {
    const r = await send(body);
    onProgress?.(steps);
    return r;
  };
  try {
    return await runProbe(cfg, toolNames, effortMappings, tracked, steps, model);
  } catch (e) {
    if (e instanceof QuotaExhausted) {
      const misreported =
        e.status !== undefined && e.status !== 429
          ? `另外：这条线路把限流报成了 HTTP ${e.status} 而不是 429 —— 那是它的协议问题。` +
            '客户端能自动退避的前提是错误码说实话，报成 400 会让所有客户端把它当成参数错误去查。'
          : '';
      return {
        steps,
        verdict:
          [
            '**结论就是限流本身**：配额用尽了，不是任何一个参数的问题。',
            `排查全程每 ${PROBE_SPACING_MS / 1000} 秒才发一次、只发一条 hi —— 这个节奏不可能把配额打爆，` +
              `所以收到限流只能说明额度本来就已经见底。等 ${CONFIRM_WAIT_MS / 1000} 秒后又确认了一次，还是限流。`,
            misreported,
            `上游原话：${e.message}`,
            '能做的：等额度回来；换一份凭据；或者看看同一把 key 是不是在别处也在跑（配额是共享的）。',
          ]
            .filter(Boolean)
            .join('\n\n'),
      };
    }
    throw e;
  }
}

async function runProbe(
  cfg: GenerationConfig,
  toolNames: string[],
  effortMappings: EffortMapping[],
  send: Sender,
  steps: ProbeStep[],
  model: string,
): Promise<ProbeReport> {

  // ① 最小请求体。它要是也过不了，问题根本不在字段上
  const base = minimal(model);
  const r0 = await send(base);
  steps.push({ label: '最小请求体（只有 model + messages）', ok: r0.ok, error: r0.error });
  if (!r0.ok) {
    return {
      steps,
      verdict:
        '连最小请求体都被拒了 —— 问题不在任何一个参数上，而在模型名、密钥或地址。' +
        `先确认「${model}」这个 ID 在这条线路上真的存在。`,
    };
  }

  // ② 一组一组加回去。顺序按「最可能出事」排，先撞见的就是答案
  const layers: { label: string; patch: () => Record<string, unknown> }[] = [
    {
      label: '流式 + stream_options',
      patch: () => ({ stream: true, stream_options: { include_usage: true } }),
    },
    {
      label: '勾选的生成参数',
      patch: () => {
        const b = buildRequestBody({ ...cfg, toolsEnabled: false, customBody: '', thinkingStyle: 'off' }, [], [], []);
        delete b.messages;
        delete b.model;
        delete b.stream;
        return b;
      },
    },
    {
      label: '思考强度字段',
      patch: () => {
        const b = buildRequestBody({ ...cfg, toolsEnabled: false, customBody: '', params: {} }, [], [], effortMappings);
        delete b.messages;
        delete b.model;
        delete b.stream;
        return b;
      },
    },
    {
      label: '附加请求字段（customBody）',
      patch: () => {
        try {
          const v = JSON.parse(cfg.customBody || '{}');
          return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
        } catch {
          return {};
        }
      },
    },
  ];

  const acc: Record<string, unknown> = { ...base };
  for (const layer of layers) {
    const patch = layer.patch();
    if (!Object.keys(patch).length) continue;
    Object.assign(acc, patch);
    // 探测一律不开流，省钱也省事；stream 那一层只验证 stream_options 认不认
    const r = await send({ ...acc, stream: false });
    steps.push({ label: `＋ ${layer.label}`, ok: r.ok, error: r.error });
    if (!r.ok) {
      return {
        steps,
        verdict: `加上「${layer.label}」就 400 了 —— 凶手是这一组。${describeFix(layer.label)}`,
      };
    }
  }

  // ③ 工具。到这一步前面全过了，所以锅只可能在这儿
  //
  // 只在**真的会被序列化进 tools 的名字**上二分。注册表里没有的名字根本
  // 不会出现在请求体里，拿它去二分只会得到「两半都是好的、合起来是坏的」
  // 这种自相矛盾的结论。
  const probeNames = toolNames.filter((n) => serializes(n));
  if (cfg.toolsEnabled && probeNames.length) {
    const bad = await bisectTools(model, probeNames, acc, send, steps);
    if (bad.length === probeNames.length && probeNames.length > 1) {
      return {
        steps,
        badTools: bad,
        verdict:
          `单独拆开每个工具都能过，全部一起下发就 400 —— 这条线路扛不住 ${probeNames.length} 个工具` +
          '（多半是 tools 字段总长度或数量上限）。少勾一些工具就能用。',
      };
    }
    if (bad.length) {
      return {
        steps,
        badTools: bad,
        verdict: `这几个工具的 schema 这条线路不认：${bad.join('、')}。在右侧配置面板把它们取消勾选即可。`,
      };
    }
  }

  return {
    steps,
    verdict:
      '把所有字段都加回去之后反而都通过了 —— 说明刚才那次 400 不是稳定复现的，' +
      '更可能是当时的历史消息里有上游不接受的内容（比如图片、超长的工具输出、或者空的 assistant 消息）。',
  };
}

function describeFix(label: string): string {
  if (label.includes('流式')) return '把配置面板里的「流式」关掉就能用。';
  if (label.includes('生成参数')) return '把「长度 / 采样 / 惩罚」里刚勾上的那几个逐个取消，就能定位到具体哪一个。';
  if (label.includes('思考强度')) return '把输入框右下角的思考强度调成「不下发」。';
  if (label.includes('customBody')) return '清空配置面板最下面的「附加请求字段」。';
  return '';
}


/* ------------------------------------------------------------------ *
 * 历史消息二分
 *
 * 字段全绿、真实对话还是 400 —— 这种时候锅在 messages 数组里，而上游只会
 * 说一句 "inference request is invalid"，不告诉你是第几条。
 *
 * 做法是找**最短的会失败的前缀**：二分 k，发 messages[0..k]，失败就往左收。
 * 找到的那个 k 就是「加上它就坏」的那一条。
 *
 * 一个关键细节：每个前缀都要先过 checkWire。直接切一刀几乎必然切出孤儿
 * tool 消息，那样每个前缀都失败，二分会收敛到 k=1 并冤枉第一条消息。
 * 换句话说，**没有结构修复就没法做历史二分**。
 * ------------------------------------------------------------------ */

export interface HistoryProbe {
  steps: ProbeStep[];
  /** 会失败的最短前缀的最后一条消息下标；null = 整段历史都没问题 */
  badIndex: number | null;
  verdict: string;
}

export async function probeHistory(
  model: string,
  messages: WireMessage[],
  send: Sender,
  onProgress?: (steps: ProbeStep[], note?: string) => void,
): Promise<HistoryProbe> {
  const steps: ProbeStep[] = [];
  const guard = guarded(send, (note) => onProgress?.(steps, note));

  /*
   * 这一阶段每次要把大半段历史原样发出去，一次上万 token —— 跟字段阶段
   * 那种「一条 hi」完全不是一个量级。用同样的 3 秒间隔，六次就能把 TPM
   * 撞穿，而撞穿之后这个工具给出的结论又是错的（把自己造成的限流
   * 当成配额用尽）。
   *
   * 所以间隔要按**实际发送量**算：发多少 token，就等够这些 token 在
   * TPM 窗口里应占的时间。慢，但这正是「设计成不可能触发限流」的代价 ——
   * 也是这个结论能作数的前提。
   */
  const totalTokens = estimateRequestTokens(messages);
  const perCall = spacingForTokens(totalTokens);
  let last = 0;

  const tryPrefix = async (k: number) => {
    const slice = checkWire(messages.slice(0, k)).messages;
    const gap = perCall - (Date.now() - last);
    if (last && gap > 0) {
      onProgress?.(steps, `为避开每分钟 token 上限，${Math.ceil(gap / 1000)} 秒后发下一次…`);
      await new Promise((res) => setTimeout(res, gap));
    }
    last = Date.now();
    const r = await guard({ model, messages: slice, max_tokens: 1 });
    steps.push({ label: `前 ${k} 条消息`, ok: r.ok, error: r.error });
    onProgress?.(steps);
    return r.ok;
  };

  try {
    if (await tryPrefix(messages.length)) {
      return {
        steps,
        badIndex: null,
        verdict:
          '把整段历史原样发过去反而通过了 —— 说明那次 400 不在消息内容上，' +
          '更可能是当时的结构问题（孤儿工具结果之类），而这个现在已经会自动修掉了。',
      };
    }

    let lo = 1;
    let hi = messages.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await tryPrefix(mid)) lo = mid + 1;
      else hi = mid;
    }
    const bad = messages[lo - 1];
    const role = bad?.role ?? '?';
    const size = typeof bad?.content === 'string' ? bad.content.length : JSON.stringify(bad?.content ?? '').length;
    return {
      steps,
      badIndex: lo - 1,
      verdict:
        `第 ${lo} 条消息（role=${role}，正文 ${size} 字符）加进去就 400。` +
        '常见原因：这条带了图片而模型是纯文本的、正文超长、或者它是一条上游不接受的空 assistant。',
    };
  } catch (e) {
    if (e instanceof QuotaExhausted) {
      const tokenSide = isTokenLimit(e.message);
      return {
        steps,
        badIndex: null,
        verdict: tokenSide
          ? '查到一半撞上了**每分钟 token 上限**，这次不下结论。\n' +
            '这一阶段每次都要把大半段历史原样发出去（一次上万 token），' +
            '所以它比字段阶段吃 token 得多。等一两分钟额度回来再点一次；' +
            '或者先从这条对话分叉出一条短的再查 —— 历史短了，这一步也就轻了。\n' +
            `上游原话：${e.message}`
          : `查到一半配额用尽了，这次不下结论。上游原话：${e.message}`,
      };
    }
    throw e;
  }
}
