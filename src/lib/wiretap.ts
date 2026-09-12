/* ------------------------------------------------------------------ *
 * 原始往返记录
 *
 * 为什么需要这个东西：当模型说「我现在就调用工具」然后停住，
 * 站在应用这一侧能看到的只有「没有工具调用」。至于是
 *
 *   - 请求里压根没带 tools（应用的锅）
 *   - 带了，但网关转发时丢了（网关的锅）
 *   - 都对，模型自己没调（模型的锅）
 *
 * ——光看现象分不出来，只能猜。猜了三轮还没猜中的事，应该换成看。
 *
 * 所以这里把**最近一次**请求体和**未经解析的**响应原文留一份。
 * 只留一次、只在内存里、不落盘：它是给人看一眼就走的证据，
 * 不是日志系统。密钥在 headers 里，而 headers 从来不进这里。
 * ------------------------------------------------------------------ */

export interface Exchange {
  at: number;
  url: string;
  stream: boolean;
  /** 实际发出去的请求体（不含 headers，所以不含密钥） */
  request: unknown;
  /** 上游回来的原文：流式是 SSE 全文，非流式是整包 JSON */
  raw: string;
  truncated: boolean;
}

/** 原文留这么多就够看清结构了，再多只是撑爆内存 */
const RAW_CAP = 256_000;

let last: Exchange | null = null;

export function beginExchange(init: { url: string; body: unknown; stream: boolean }): void {
  last = {
    at: Date.now(),
    url: init.url,
    stream: init.stream,
    request: init.body,
    raw: '',
    truncated: false,
  };
}

export function recordRaw(text: string): void {
  if (!last || !text) return;
  if (last.raw.length >= RAW_CAP) {
    last.truncated = true;
    return;
  }
  last.raw += text.slice(0, RAW_CAP - last.raw.length);
  if (last.raw.length >= RAW_CAP) last.truncated = true;
}

export function lastExchange(): Exchange | null {
  return last;
}

/** 请求体里最该先看的那几件事，省得人在几百行 JSON 里找 */
function verdict(req: unknown, raw: string): string[] {
  const out: string[] = [];
  const body = (req ?? {}) as Record<string, unknown>;
  const tools = Array.isArray(body.tools) ? body.tools : null;

  if (!tools) {
    out.push(
      '⚠ 请求体里**没有 tools 字段** —— 模型手上一个工具都没有，' +
        '它说要调用工具也只能是空话。去右侧配置面板确认「给模型下发工具」开着，' +
        '并且下面至少勾了一个工具。',
    );
  } else {
    out.push(`✓ 下发了 ${tools.length} 个工具`);
  }

  if (body.stream === false) out.push('· 非流式模式');
  if (!raw.trim()) {
    out.push('⚠ 上游一个字节都没回 —— 连 SSE 头都没有');
  } else {
    const hasToolCall = /"tool_calls"|"function_call"/.test(raw);
    const fr = [...raw.matchAll(/"(?:finish|stop)_reason"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    out.push(hasToolCall ? '✓ 响应原文里出现过 tool_calls' : '⚠ 响应原文里**从头到尾没有 tool_calls**');
    out.push(
      fr.length
        ? `· 上游给的结束原因：${[...new Set(fr)].join('、')}`
        : '⚠ 上游全程没给 finish_reason —— 这种情况下应用无法区分「答完了」和「被掐断」',
    );
  }
  return out;
}

/** 拼成能直接贴给别人看的一段文本 */
export function formatExchange(): string {
  if (!last) return '还没有发过请求。先在对话里问一句，再回来看这里。';
  const ago = Math.round((Date.now() - last.at) / 1000);
  const head = [
    `时间：${ago} 秒前`,
    `地址：${last.url}`,
    `流式：${last.stream ? '是' : '否'}`,
    '',
    '—— 先看这几条 ——',
    ...verdict(last.request, last.raw),
    '',
    '—— 发出去的请求体（不含 headers，所以不含你的 key）——',
  ].join('\n');

  let req: string;
  try {
    req = JSON.stringify(last.request, null, 2);
  } catch {
    req = String(last.request);
  }

  const tail = [
    '',
    `—— 上游回来的原文${last.truncated ? `（只留了前 ${RAW_CAP} 字）` : ''} ——`,
    last.raw || '（空）',
  ].join('\n');

  return `${head}\n${req}\n${tail}`;
}
