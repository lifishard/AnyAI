import type { ToolCall, Usage } from '../types';

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  /** 参数 JSON 的一个片段，流式下要按 index 拼起来 */
  arguments?: string;
}

export interface NormalizedDelta {
  content: string;
  reasoning: string;
  toolCalls: ToolCallDelta[];
  usage?: Usage;
  /**
   * 上游给的 finish_reason 原文，没给就是 null。
   * 这个值是「为什么停」的唯一线索：stop 是正常收尾，length 是被 max_tokens
   * 砍了，tool_calls 是它要调工具，content_filter 是被拦了。null 则通常意味着
   * 流被掐断 —— 这几种情况在界面上必须长得不一样，否则全都表现为「答完了」。
   */
  finishReason: string | null;
}

/**
 * 增量 SSE 解析器。喂入任意切分的文本块，按空行切出完整事件，
 * 抽出 `data:` 行的载荷回调出去。`[DONE]` 交给上层判断。
 */
export function createSseParser(onData: (payload: string) => void) {
  let buf = '';

  function emit(raw: string) {
    const lines = raw.split('\n');
    const datas: string[] = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue; // 注释 / 心跳
      if (line.startsWith('data:')) datas.push(line.slice(5).trimStart());
    }
    if (datas.length) onData(datas.join('\n'));
  }

  return {
    feed(chunk: string) {
      buf = (buf + chunk).replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        emit(raw);
      }
    },
    end() {
      if (buf.trim()) emit(buf);
      buf = '';
    },
  };
}

/** content 可能是字符串，也可能是 [{type:'text',text:'...'}] 这种多模态数组 */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
          if (typeof p.content === 'string') return p.content;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function pickUsage(o: unknown): Usage | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const u = o as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : undefined);
  // 缓存命中的字段名各家不一样：OpenAI 塞在 prompt_tokens_details.cached_tokens，
  // DeepSeek 叫 prompt_cache_hit_tokens，Moonshot 直接给 cached_tokens
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const cached =
    n('cached_tokens') ??
    n('prompt_cache_hit_tokens') ??
    (typeof details.cached_tokens === 'number' ? details.cached_tokens : undefined);

  const usage: Usage = {
    prompt_tokens: n('prompt_tokens') ?? n('input_tokens'),
    completion_tokens: n('completion_tokens') ?? n('output_tokens'),
    total_tokens: n('total_tokens'),
    cached_tokens: cached,
    reasoning_tokens: typeof completionDetails.reasoning_tokens === 'number' ? completionDetails.reasoning_tokens : n('reasoning_tokens'),
  };
  if (
    usage.prompt_tokens === undefined &&
    usage.completion_tokens === undefined &&
    usage.total_tokens === undefined &&
    usage.cached_tokens === undefined && usage.reasoning_tokens === undefined
  ) {
    return undefined;
  }
  if (usage.total_tokens === undefined) {
    usage.total_tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
  }
  return usage;
}

function pickToolCalls(holder: Record<string, unknown>): ToolCallDelta[] {
  const raw = holder.tool_calls ?? holder.toolCalls;
  if (!Array.isArray(raw)) return [];
  const out: ToolCallDelta[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const o = item as Record<string, unknown>;
    const fn = (o.function ?? {}) as Record<string, unknown>;
    out.push({
      index: typeof o.index === 'number' ? o.index : i,
      id: typeof o.id === 'string' ? o.id : undefined,
      name: typeof fn.name === 'string' ? fn.name : undefined,
      arguments: typeof fn.arguments === 'string' ? fn.arguments : undefined,
    });
  });
  return out;
}

/**
 * 把一个 chunk / 完整响应归一化。
 * 兼容三种形状：
 *  1. OpenAI 流式    { choices:[{ delta:{ content, reasoning_content, tool_calls } }], usage }
 *  2. OpenAI 非流式  { choices:[{ message:{ content, reasoning, tool_calls } }], usage }
 *  3. 日日新原生     { data: { choices:[{ delta:"..." }], usage } }
 */
export function normalizeDelta(input: unknown): NormalizedDelta {
  const out: NormalizedDelta = { content: '', reasoning: '', toolCalls: [], finishReason: null };
  if (!input || typeof input !== 'object') return out;

  let root = input as Record<string, unknown>;
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
    root = root.data as Record<string, unknown>;
  }

  const usage = pickUsage(root.usage);
  if (usage) out.usage = usage;

  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) return out;

  const c = choices[0] as Record<string, unknown>;
  // 字段名各家不一样：OpenAI 是 finish_reason，Anthropic 兼容层常写 stop_reason
  const fr = c.finish_reason ?? c.stop_reason ?? c.finishReason;
  if (typeof fr === 'string' && fr) out.finishReason = fr;

  const holder = (c.delta ?? c.message ?? {}) as unknown;

  // 日日新原生：delta 直接是字符串
  if (typeof holder === 'string') {
    out.content += holder;
    return out;
  }

  const h = holder as Record<string, unknown>;
  out.content += textOf(h.content);
  out.reasoning += textOf(h.reasoning_content ?? h.reasoning ?? h.thinking);
  out.toolCalls = pickToolCalls(h);

  if (!out.reasoning) out.reasoning += textOf(c.reasoning_content ?? c.reasoning);
  if (!out.content && typeof c.text === 'string') out.content += c.text;

  return out;
}

/**
 * 把一串 tool_call 增量累积成完整调用。
 * 流式下 name 只在第一个分片里出现，arguments 要逐段拼。
 */
export function createToolCallAccumulator() {
  const byIndex = new Map<number, { id: string; name: string; args: string }>();

  return {
    feed(deltas: ToolCallDelta[]) {
      for (const d of deltas) {
        const cur = byIndex.get(d.index) ?? { id: '', name: '', args: '' };
        if (d.id) cur.id = d.id;
        if (d.name) cur.name = d.name;
        if (d.arguments) cur.args += d.arguments;
        byIndex.set(d.index, cur);
      }
    },
    result(): ToolCall[] {
      return [...byIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, v]) => ({
          id: v.id || `call_${i}`,
          name: v.name,
          arguments: v.args,
        }))
        .filter((c) => Boolean(c.name));
    },
    /**
     * 收到了分片、但始终没等到函数名的那几个 —— 它们会被 result() 过滤掉。
     * 数出来是为了让上层能说「有 N 个工具调用没传完」，而不是表现成
     * 「这轮它没想调工具」。流被中途掐断时就是这个样子。
     */
    droppedCount(): number {
      let n = 0;
      for (const v of byIndex.values()) if (!v.name) n++;
      return n;
    },
    get size() {
      return byIndex.size;
    },
  };
}

/** 从各种错误响应体里挖出人能看懂的一句话 */
export function extractErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') return payload.slice(0, 800) || fallback;
  if (!payload || typeof payload !== 'object') return fallback;
  const o = payload as Record<string, unknown>;
  const err = (o.error ?? o) as Record<string, unknown>;
  const msg =
    (typeof err.message === 'string' && err.message) ||
    (typeof o.message === 'string' && o.message) ||
    (typeof err.msg === 'string' && err.msg) ||
    (typeof o.msg === 'string' && o.msg) ||
    '';
  const code =
    (typeof err.code === 'string' || typeof err.code === 'number' ? String(err.code) : '') ||
    (typeof o.code === 'string' || typeof o.code === 'number' ? String(o.code) : '');
  if (msg) return code ? `${msg} (code ${code})` : msg;
  try {
    return JSON.stringify(payload).slice(0, 800);
  } catch {
    return fallback;
  }
}

/**
 * 流式响应的统一消费器。
 * Electron 和 Android 的原生层都只负责把字节搬上来（chunk = SSE 原文，
 * body = 非流式整包），解析逻辑只在这里有一份。
 */
export function createStreamConsumer(h: {
  onContent(s: string): void;
  onReasoning(s: string): void;
  onToolCallDelta(d: ToolCallDelta[]): void;
  onUsage(u: Usage): void;
  onFinishReason?(reason: string): void;
  onError?(message: string, status?: number): void;
}) {
  const parser = createSseParser((payload) => {
    if (payload === '[DONE]') return;
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    apply(json);
  });

  function apply(json: unknown) {
    const packet = json as { error?: unknown; code?: number; message?: string } | null;
    if (packet?.error || (packet?.code && packet.code !== 200 && packet.message)) {
      h.onError?.(extractErrorMessage(json, '上游流中返回错误'));
      return;
    }
    const d = normalizeDelta(json);
    if (d.reasoning) h.onReasoning(d.reasoning);
    if (d.content) h.onContent(d.content);
    if (d.toolCalls.length) h.onToolCallDelta(d.toolCalls);
    if (d.usage) h.onUsage(d.usage);
    if (d.finishReason) h.onFinishReason?.(d.finishReason);
  }

  return {
    /** SSE 原文片段 */
    chunk(text: string) {
      parser.feed(text);
    },
    /** 非流式的整包响应体 */
    body(text: string) {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        h.onContent(text);
        return;
      }
      apply(json);
    },
    end() {
      parser.end();
    },
  };
}
