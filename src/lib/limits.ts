/* ------------------------------------------------------------------ *
 * 上游到底给多大窗口 —— 从报错里学，而不是内置一张表
 *
 * BYOK 客户端没法预知每条路由的上下文窗口：同一个模型名在不同网关上
 * 可能是 32K，也可能是 200K，用户还能自己加自定义模型。内置一张对照表
 * 只会过时，而且永远缺那条你正在用的路由。
 *
 * 但有一件事是确定的：**窗口被撑破时，上游会在报错里把数字告诉你**。
 *   "This model's maximum context length is 32768 tokens, however you requested 36343"
 *   "Input length 28151 exceeds the maximum length 16384"
 *   "请求的 token 数超过模型上限 65536"
 *
 * 所以这里做两件事：从报错里把数字抠出来，记在这条路由名下；下次发请求
 * 之前拿它先自己压一压。撞一次墙，以后就不再撞同一堵。
 * ------------------------------------------------------------------ */

export interface LearnedLimit {
  /** 总窗口（输入 + 输出） */
  maxContext?: number;
  /** 单次输出上限 */
  maxOutput?: number;
  /** 什么时候学到的 */
  at: number;
  /** 学习依据的那句原文，方便人核对 */
  from: string;
}

export function limitKey(profileId: string, model: string): string {
  return `${profileId}::${model}`;
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
  return OVERFLOW.test(msg || '');
}

/** 一句话里出现的、看起来像 token 数的数字（四位数以上，排除年份那种巧合） */
function numbersIn(msg: string): number[] {
  const out: number[] = [];
  for (const m of msg.matchAll(/(\d[\d,_]{2,})\s*(k\b)?/gi)) {
    const n = Number(m[1].replace(/[,_]/g, ''));
    if (!Number.isFinite(n)) continue;
    const scaled = m[2] ? n * 1024 : n;
    if (scaled >= 1000 && scaled <= 10_000_000) out.push(scaled);
  }
  return out;
}

/**
 * 从报错里学窗口大小。
 *
 * 典型句式是「上限是 A，你要了 B」，A < B。所以拿到多个数时取**最小**的那个
 * 当上限 —— 大的那个是「你要了多少」，不是「能要多少」。取错方向的话，
 * 下次会照着一个比真实窗口还大的数去压，等于没压。
 */
export function parseLimits(msg: string): { maxContext?: number; maxOutput?: number } {
  if (!msg || !looksLikeOverflow(msg)) return {};

  // 这句话在说输出上限，还是总窗口？两者要分开记 —— 把输出上限当成窗口，
  // 下次会把整段历史压到 16K，白白扔掉一半上下文
  const aboutOutput =
    /max_?tokens|completion|output|生成长度|输出/i.test(msg) &&
    !/context|prompt|input|messages|上下文|输入/i.test(msg);

  // 先试精确句式：maximum context length is N
  const exact = msg.match(
    /(?:maximum|max)[^.\d]{0,32}(?:context|input|prompt)[^.\d]{0,24}?(\d[\d,_]*)/i,
  );
  if (exact && !aboutOutput) {
    const n = Number(exact[1].replace(/[,_]/g, ''));
    if (Number.isFinite(n) && n >= 1000) return { maxContext: n };
  }

  const ns = numbersIn(msg);
  if (!ns.length) return {};
  // 「上限 A，你要了 B」里 A < B，所以取最小的那个当上限
  const smallest = Math.min(...ns);
  return aboutOutput ? { maxOutput: smallest } : { maxContext: smallest };
}

/**
 * 这次还能塞多少输入。
 *
 * 留出 reserve 给输出和各家自己的开销 —— 顶着窗口发是没有意义的，
 * 模型一个字都答不出来的请求跟发不出去没区别。
 */
export function inputBudget(limit: LearnedLimit | undefined, wantOutput: number): number | null {
  if (!limit?.maxContext) return null;
  const reserve = Math.max(1024, Math.min(wantOutput || 4096, Math.floor(limit.maxContext * 0.25)));
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
