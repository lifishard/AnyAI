import type { WireMessage } from './paramSchema';

/* ------------------------------------------------------------------ *
 * 发出去之前先把 messages 数组自检一遍
 *
 * 起因：自动排查把请求体的每一组字段都验过了，全绿 —— 连 23 个工具一起
 * 下发都没问题。但真实对话跑到第 8 步还是 400。那就只剩一种可能：
 * **坏的不是请求体的形状，是 messages 数组本身的结构**。
 *
 * 带工具调用的对话有一组硬约束，各家 OpenAI 兼容端点都认，违反就是 400：
 *
 *   1. 每条 role=tool 的消息，前面必须有一条 assistant 里声明过同名
 *      tool_call_id 的记录。孤儿 tool 消息一定报错。
 *   2. 反过来也一样：assistant 声明了 N 个 tool_calls，后面就必须有 N 条
 *      对应的 tool 消息。少一条也报错。
 *   3. 第一条消息不能是 tool。
 *
 * 而这三条恰恰是**最容易被历史裁剪弄坏的** —— 按条数截断、按错误过滤、
 * 上下文压缩、中段折叠，每一个都可能把一对 assistant/tool 拆散。
 *
 * 所以这里不只是「检查」，还负责**修**：修不了的才报出来。理由很简单，
 * 一个用户看不懂也没法手动修的结构问题，报给他没有任何意义 ——
 * 他要的是这轮能跑下去。
 * ------------------------------------------------------------------ */

export interface WireProblem {
  /** 出问题的消息下标（修完之后的数组里可能已经不存在了） */
  index: number;
  kind: 'orphan_tool' | 'missing_tool_result' | 'null_content' | 'empty_tool' | 'leading_tool';
  detail: string;
}

export interface WireCheck {
  messages: WireMessage[];
  problems: WireProblem[];
}

type ToolCallLike = { id?: string; function?: { name?: string } };

function callsOf(m: WireMessage): ToolCallLike[] {
  const raw = (m as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(raw) ? (raw as ToolCallLike[]) : [];
}

/**
 * 检查并修复。**不改传进来的数组**，返回一份新的。
 *
 * 修复的原则是「只动结构，不动内容」：
 *   - 孤儿 tool 消息直接丢掉（它对应的调用已经不在上下文里了，留着只会报错）
 *   - 缺失的 tool 结果补一条占位，说明结果已经不在上下文里
 *   - content 为 null 的 assistant 改成空串
 *
 * 用户写的字一个都不会动。
 */
export function checkWire(input: WireMessage[]): WireCheck {
  const problems: WireProblem[] = [];
  const out: WireMessage[] = [];

  // 先扫一遍，记下每个 tool_call_id 是在第几条 assistant 上声明的
  const declared = new Set<string>();
  for (const m of input) {
    if (m.role !== 'assistant') continue;
    for (const c of callsOf(m)) if (c.id) declared.add(c.id);
  }

  for (let i = 0; i < input.length; i++) {
    const m = input[i];

    if (m.role === 'tool') {
      const id = (m as { tool_call_id?: string }).tool_call_id;
      if (!id || !declared.has(id)) {
        problems.push({
          index: i,
          kind: 'orphan_tool',
          detail: `tool 消息的 tool_call_id=${id ?? '(空)'} 在前面任何 assistant 里都没声明过`,
        });
        continue; // 丢掉
      }
      if (!out.length) {
        problems.push({ index: i, kind: 'leading_tool', detail: '第一条消息是 tool' });
        continue;
      }
      if (typeof m.content === 'string' && !m.content.trim()) {
        problems.push({ index: i, kind: 'empty_tool', detail: 'tool 消息正文是空的' });
        out.push({ ...m, content: '（这一步没有返回任何内容）' });
        continue;
      }
      out.push(m);
      continue;
    }

    if (m.role === 'assistant' && callsOf(m).length) {
      let fixed = m;
      if (m.content === null || m.content === undefined) {
        problems.push({
          index: i,
          kind: 'null_content',
          detail: 'assistant 带 tool_calls 时 content 是 null；部分网关不接受 null，已改成空串',
        });
        fixed = { ...m, content: '' };
      }
      out.push(fixed);

      // 这条声明的每个调用，后面必须有对应的 tool 结果
      const ids = callsOf(m)
        .map((c) => c.id)
        .filter((x): x is string => Boolean(x));
      const answered = new Set<string>();
      for (let j = i + 1; j < input.length; j++) {
        const n = input[j];
        if (n.role === 'assistant' && callsOf(n).length) break; // 下一轮开始了
        if (n.role !== 'tool') continue;
        const tid = (n as { tool_call_id?: string }).tool_call_id;
        if (tid) answered.add(tid);
      }
      for (const id of ids) {
        if (answered.has(id)) continue;
        problems.push({
          index: i,
          kind: 'missing_tool_result',
          detail: `声明了 tool_call ${id} 但后面没有对应的结果，已补一条占位`,
        });
        out.push({
          role: 'tool',
          content: '（这一步的结果已经不在上下文里了。需要的话重新调用一次。）',
          tool_call_id: id,
        });
      }
      continue;
    }

    out.push(m);
  }

  return { messages: out, problems };
}

/** 给人看的一句话；没问题就返回空串 */
export function describeWire(problems: WireProblem[]): string {
  if (!problems.length) return '';
  const byKind = new Map<string, number>();
  for (const p of problems) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
  const label: Record<WireProblem['kind'], string> = {
    orphan_tool: '孤儿工具结果',
    missing_tool_result: '缺失的工具结果',
    null_content: 'null 正文',
    empty_tool: '空的工具结果',
    leading_tool: '开头的工具结果',
  };
  return [...byKind.entries()]
    .map(([k, n]) => `${label[k as WireProblem['kind']] ?? k} ×${n}`)
    .join('、');
}
