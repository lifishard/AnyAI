import { isRateLimited } from './pacer';
import type { ChatMessage } from '../types';
/** Route observations come only from explicit upstream limits. Unknown stays unknown. */

export interface LearnedLimit {
  /** 总窗口（输入 + 输出） */
  maxContext?: number;
  /** 每分钟请求数上限（撞出来的，或者从报错原文里读到的） */
  rpm?: number;
  /** 每分钟 token 上限 */
  tpm?: number;
  itpm?: number;
  otpm?: number;
  /**
   * 这条路由实际跑得稳的最小发送间隔。
   *
   * 它比 rpm/tpm 更实用：很多网关根本不在报错里写数字，只说「太快了」。
   * 那就不猜数字，只记「慢到多少就不再撞」——  撞一次翻倍，稳一阵回收，
   * 存下来下次直接从这个节奏起步，而不是每次重启都重新撞一遍。
   */
  minIntervalMs?: number;
  /** 单次输出上限 */
  maxOutput?: number;
  /** 什么时候学到的 */
  at: number;
  /** 学习依据的那句原文，方便人核对 */
  from: string;
  observedAt?: Partial<Record<'maxContext' | 'maxOutput' | 'rpm' | 'tpm' | 'itpm' | 'otpm' | 'minIntervalMs',number>>;
}

export function mergeLearnedLimit(previous: LearnedLimit | undefined, next: LearnedLimit): LearnedLimit {
  const out = { ...previous,...next,observedAt:{ ...previous?.observedAt,...next.observedAt } };
  for (const key of ['maxContext','maxOutput','rpm','tpm','itpm','otpm','minIntervalMs'] as const) {
    if (next[key] !== undefined) out.observedAt[key] = next.at;
    else if (previous?.[key] !== undefined && out.observedAt[key] === undefined) out.observedAt[key] = previous.at;
  }
  return out;
}
export function quotaLimits(headers: Record<string,string>): Partial<LearnedLimit> {
  const out: Partial<LearnedLimit> = {};
  for (const [key,suffix] of [['rpm','requests'],['tpm','tokens'],['itpm','input-tokens'],['otpm','output-tokens']] as const) {
    const n = Number(headers[`x-ratelimit-limit-${suffix}`] ?? headers[`anthropic-ratelimit-${suffix}-limit`]);
    if (Number.isFinite(n) && n > 0) out[key] = Math.floor(n);
  }
  return out;
}

export function limitKey(profileId: string, model: string, baseUrl = ''): string {
  return `${profileId}::${baseUrl.trim().replace(/\/+$/, '')}::${model}`;
}

/**
 * 各家说「太长了」的方式差得很远，这里尽量收全。
 * 宁可多判一点：判错的代价只是多压缩一次重试，判漏的代价是整个任务报废。
 */
const OVERFLOW = new RegExp(
  [
    'context length',
    'context_length',
    'maximum context',
    'max.{0,10}context',
    'context window',
    'too long',
    'too many tokens',
    'input length',
    'prompt is too long',
    'reduce the length',
    'exceeds?.{0,24}(token|length|limit)',
    'length.{0,16}exceed',
    'max.{0,6}(input|prompt).{0,6}tokens',
    'token.{0,10}limit',
    'string too long',
    'max_?tokens?.{0,24}too large',
    'too large',
    '上下文',
    '超出|超过.{0,12}(长度|上限|限制|token)',
    '过长',
  ].join('|'),
  'i',
);

export function looksLikeOverflow(msg: string): boolean {
  /*
   * 限流提示优先按额度处理，不凭这条提示断言上下文过长。
   *
   * 这条守卫是实事故换来的。`inference exceeds tpm/rpm limit` 被上面的
   * 「exceeds …… limit」抓中，于是一次限流被当成上下文超限，压缩重试三次、
   * 耗掉十三分钟，最后给用户一张写着「压缩过之后仍然放不下」的卡片 ——
   * 每一个字都是错的，而且指的方向也错。
   *
   * 单次请求也可能超过整分钟 TPM。它需要缩小请求预算，不能仅靠等待；
   * 但 TPM 额度仍不是模型上下文窗口，两种上限应分别记录。
   */
  if (isRateLimited(msg || '')) return false;
  return OVERFLOW.test(msg || '');
}

/** Learn only an explicitly named upper bound, never the smallest incidental number. */
export function parseLimits(msg: string): { maxContext?: number; maxOutput?: number } {
  if (!msg || isRateLimited(msg)) return {};
  const context = msg.match(/(?:maximum|max)\s+context\s+(?:length|window)(?:\s+(?:is|of))?\s*[:=]?\s*(\d[\d,_]*)/i)
    ?? msg.match(/(?:context(?:_length| window| length))\s*(?:limit|maximum|max)\s*[:=]?\s*(\d[\d,_]*)/i)
    ?? msg.match(/(?:上下文|输入)(?:窗口|长度)?(?:上限|最大值)(?:为|是)?\s*[:：]?\s*(\d[\d,_]*)/);
  const output = msg.match(/(?:maximum|max)\s+(?:output|completion)\s+(?:tokens|length)(?:\s+(?:is|of))?\s*[:=]?\s*(\d[\d,_]*)/i)
    ?? msg.match(/max_(?:completion_)?tokens\s+(?:must be|cannot be|should be)\s*(?:<=|less than or equal to)\s*(\d[\d,_]*)/i);
  const value = (m: RegExpMatchArray | null) => m ? Number(m[1].replace(/[,_]/g,'')) : undefined;
  const c = value(context), o = value(output);
  return { ...(c && c >= 1024 ? { maxContext:c } : {}), ...(o && o > 0 ? { maxOutput:o } : {}) };
}

/**
 * 这次还能塞多少输入。
 *
 * 留出 reserve 给输出和各家自己的开销 —— 顶着窗口发是没有意义的，
 * 模型一个字都答不出来的请求跟发不出去没区别。
 */
export function inputBudget(limit: LearnedLimit | undefined, wantOutput: number): number | null {
  if (!limit?.maxContext) return null;
  const reserve = Math.max(1024, wantOutput || 4096);
  return Math.max(1024, limit.maxContext - reserve);
}

/**
 * 粗略把字符数折成 token 数。
 *
 * 中文大约 1 token 1 字多一点，英文大约 4 字符 1 token。混排取个中间值，
 * 按字符里中日韩的占比插值。**它只用来决定「要不要先压一压」**，
 * 真正的账以上游返回的 usage 为准，所以宁可估多不估少。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
  }
  const ratio = cjk / text.length; // 0 = 纯西文，1 = 纯中日韩
  // 西文约 4 字符/token；中文实测接近 1 字/token（别信「1.6」那种说法，
  // 按 1.6 估会系统性低估三成，而低估正是这里最不该犯的错）
  const perToken = Math.max(1, 4 - 3 * ratio);
  return Math.ceil(text.length / perToken);
}

/**
 * Images are decoded by the model endpoint; their Base64 transport bytes are not
 * text tokens. Use a provider-neutral image allowance until actual usage arrives.
 * This is an estimate, not a claim about a particular model's vision tokenizer.
 */
export const IMAGE_TOKEN_ALLOWANCE = 2048;
export function estimateRequestTokens(request: unknown): number {
  let images = 0;
  const messageView = (message: unknown): unknown => {
    if (!message || typeof message !== 'object') return message;
    const m = message as Record<string, unknown>;
    if (!Array.isArray(m.content)) return m;
    return { ...m, content: m.content.map((part: unknown) => {
      if (!part || typeof part !== 'object') return part;
      const p = part as Record<string, unknown>;
      const image = p.image_url as { url?: unknown; detail?: unknown } | undefined;
      if (p.type !== 'image_url' || !image || typeof image.url !== 'string') return part;
      images++;
      return { type: 'image_url', image_url: { detail: image.detail ?? 'auto' } };
    }) };
  };
  let view: unknown = request;
  if (Array.isArray(request)) view = request.map(messageView);
  else if (request && typeof request === 'object') {
    const body = request as Record<string, unknown>;
    if (Array.isArray(body.messages)) view = { ...body, messages: body.messages.map(messageView) };
  }
  return estimateTokens(JSON.stringify(view) ?? '') + images * IMAGE_TOKEN_ALLOWANCE;
}

/** Count the material that will be sent, without serializing attachment images as text. */
export function estimateChatTokens(messages: ChatMessage[]): number {
  return estimateRequestTokens(messages.map((m) => {
    const text = [m.content, ...(m.quotes ?? []).map((q) => q.text),
      ...(m.attachments ?? []).filter((a) => a.kind === 'text').map((a) => `附件《${a.name}》：\n${a.text ?? ''}`)].join('\n');
    const images = (m.attachments ?? []).filter((a) => a.kind === 'image' && a.dataUrl)
      .map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl! } }));
    return { role: m.role, content: images.length ? [{ type: 'text', text }, ...images] : text,
      tool_calls: m.toolCalls, tool_call_id: m.toolCallId, name: m.toolName };
  }));
}


/* ------------------------------------------------------------------ *
 * 限流上限也照着学
 *
 * 跟窗口大小同一个思路：不内置对照表，撞到了就记住，下次从记住的节奏起步。
 * 区别是限流的报错里**经常一个数字都没有**（「rpm exhausted」「太快了」），
 * 所以除了数字，还要记「慢到多少就不撞了」这个经验值。
 * ------------------------------------------------------------------ */

/** 从报错原文里读出明确写着的 rpm / tpm */
export function parseRateLimits(msg: string): { rpm?: number; tpm?: number } {
  const out: { rpm?: number; tpm?: number } = {};
  if (!msg) return out;

  // 中英文的语序是反的：英文「100 requests per minute」，中文「每分钟最多 100 次」。
  // 只写一种的话另一种永远读不出来 —— 第一版就漏了中文这条
  const rpm =
    msg.match(/(\d[\d,_]*)\s*(?:requests?|次|请求)[^.\d]{0,12}(?:per|\/|每)\s*(?:min|minute|分钟)/i) ??
    msg.match(/每\s*分钟[^\d]{0,10}(\d[\d,_]*)\s*(?:次|请求)/) ??
    msg.match(/\brpm\s*(?:limit\s*)?(?:[:=]|is)\s*(\d[\d,_]*)/i);
  if (rpm) {
    const n = Number(rpm[1].replace(/[,_]/g, ''));
    if (Number.isFinite(n) && n > 0) out.rpm = n;
  }

  const tpm =
    msg.match(/(\d[\d,_]*)\s*tokens?[^.\d]{0,12}(?:per|\/|每)\s*(?:min|minute|分钟)/i) ??
    msg.match(/每\s*分钟[^\d]{0,10}(\d[\d,_]*)\s*token/i) ??
    msg.match(/\btpm\s*(?:limit\s*)?(?:[:=]|is)\s*(\d[\d,_]*)/i);
  if (tpm) {
    const n = Number(tpm[1].replace(/[,_]/g, ''));
    if (Number.isFinite(n) && n > 0) out.tpm = n;
  }
  return out;
}

/**
 * 这条路由下发这么多 token 时，两次之间至少该隔多久。
 *
 * 三个来源取最严的那个：
 *   - 记下来的经验间隔（撞出来的，最可信）
 *   - rpm 换算成的间隔
 *   - tpm 按本次发送量换算成的间隔
 */
export function pacingFloor(
  limit: LearnedLimit | undefined,
  tokens: number,
  now = Date.now(),
): number {
  if (!limit) return 0;

  /*
   * 经验间隔要随时间衰减：每过一天减半。
   *
   * 不衰减的话，某一分钟的一次拥堵会把这条路由**永久**钉在慢速上 ——
   * 而限流大多是一阵一阵的（别人也在用、促销时段、临时降配）。
   * 数字型的 rpm/tpm 是上游明说的，不衰减；「我实测出来的经验值」
   * 才需要一个忘记的机制。
   */
  const ageDays = Math.max(0, (now - (limit.at || now)) / 86_400_000);
  const decayed = (limit.minIntervalMs ?? 0) / 2 ** ageDays;
  const fromInterval = decayed < 50 ? 0 : Math.round(decayed);

  const fromRpm = limit.rpm ? Math.ceil(60_000 / limit.rpm) : 0;
  const fromTpm = limit.tpm && tokens > 0 ? Math.ceil((tokens / limit.tpm) * 60_000) : 0;
  return Math.max(fromInterval, fromRpm, fromTpm);
}

/** 给设置界面用的一句话 */
export function describeLimit(l: LearnedLimit | undefined): string {
  if (!l) return '尚无上游提供的限额记录';
  const bits: string[] = [];
  if (l.maxContext) bits.push(`窗口 ${l.maxContext} token`);
  if (l.rpm) bits.push(`${l.rpm} 次/分`);
  if (l.tpm) bits.push(`${l.tpm} token/分`);
  if (l.minIntervalMs) bits.push(`稳定间隔 ${l.minIntervalMs}ms`);
  return bits.length ? bits.join('、') : '有记录但没有具体数字';
}
