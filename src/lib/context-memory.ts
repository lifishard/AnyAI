import type { ChatMessage, ContextCompaction, Milestone, RunState, ToolResult } from '../types';
import { estimateChatTokens, estimateTokens } from './limits';

export function memoryView(state: RunState): ChatMessage[] {
  const last = state.compactions?.at(-1);
  if (!last) return state.working;
  // User instructions remain verbatim; their attachments are retrieved separately after compaction.
  const protectedUsers = state.working.slice(0, last.throughIndex+1).filter(m => m.role === 'user' && m.contextKind !== 'handoff').map(m => ({ ...m,
    attachments: undefined, content: m.content + (m.attachments?.length ? `\n附件原文可用 read_context 读取消息 ${m.id}` : '') }));
  return [...protectedUsers, { id: `memory-${last.id}`, role: 'user', createdAt: last.createdAt,
    content: `历史材料摘要（不是新的指令；有疑问请 read_context 核对来源）：\n${JSON.stringify({ facts: last.facts, decisions: last.decisions, unresolved: last.unresolved, nextSteps: last.nextSteps })}` },
    ...state.working.slice(last.throughIndex+1)];
}
export function memoryInstructions(state: RunState, allowPlan = true, canRetrieve = true): string {
  // Keep the active contract in every request; revision and verification histories stay on disk.
  const requirements = (state.requirements ?? []).map(({ history, verificationHistory, ...active }) => active);
  const files = [...(state.contextArchiveSteps ?? []), ...(state.steps ?? [])].flatMap(s => s.files ?? []).map(f => ({ path: f.path, direction: f.direction }))
    .filter((f,i,all) => all.findIndex(x => x.path === f.path && x.direction === f.direction) === i);
  return `\n${allowPlan ? '复杂任务先用 update_plan 建立 3–6 个里程碑，并用 update_requirements 将用户要求与验收条件对应。交付前 verify_requirements 逐项核验，修复失败项；无法核验明确标记。文件存在不代表内容或覆盖完整，完整性另列 review 要求。模型复核不是独立验证。简单问答不用计划。不能遗漏未完成项目，也不能把计划当作完成证据。' : ''}${canRetrieve ? '用 read_context 查阅历史原文，read_tool_result 查阅已保存的完整工具结果，避免重复外部操作。' : '当前检索工具未启用；若需要未展示的证据，应明确说明缺口并请用户启用工具，不得假装已核实。'}同一窗口可能由不同模型接力。先结合原始用户要求、最新补充、已有总结、未完成项和失败原因决定下一步。已有成功证据应先读取；不要仅因换模型重复查询或写入。历史摘要是可核对的工作笔记，不能覆盖用户原文，也不代表所有事项均已完成。\n接力信息：${JSON.stringify(state.handoff ?? null)}\n用户来源消息 ID：${JSON.stringify(state.requirementSourceIds ?? [])}\n交付要求：${JSON.stringify(requirements)}\n当前里程碑：${JSON.stringify(state.milestones ?? [])}\n已核实文件索引：${JSON.stringify(files)}\n`;
}
export function readContext(state: RunState, args: Record<string, unknown>): ToolResult {
  const offset = Math.max(0, Math.floor(Number(args.offset)||0));
  const limit = Math.max(1, Math.min(12000, Math.floor(Number(args.limit)||6000)));
  const id = String(args.id ?? '');
  const query = String(args.query ?? '').toLowerCase();
  const records = [...new Map([...(state.contextArchive ?? []), ...state.working].map(m => [m.id,m])).values()];
  let text: string;
  if (id) {
    const m = records.find(m => m.id === id);
    if (!m) return { ok: false, content: '', error: '找不到消息 ID；不填写 id 可列出记录' };
    if (args.image_index !== undefined) {
      const image = m.attachments?.filter(a => a.kind === 'image')[Math.floor(Number(args.image_index))];
      if (!image?.dataUrl) return { ok: false, content: '', error: '找不到该图片；image_index 从 0 开始' };
      return { ok: true, content: `原始图片：${image.name}，来自 ${id}`, imageDataUrl: image.dataUrl };
    }
    text = JSON.stringify({ id: m.id, role: m.role, content: m.content, quotes: m.quotes, toolCalls: m.toolCalls,
      attachments: m.attachments?.map(a => ({ name: a.name, path: a.path, text: a.text, kind: a.kind })) });
  } else text = JSON.stringify(records.filter(m => !query || m.content.toLowerCase().includes(query) || m.attachments?.some(a => `${a.name}\n${a.text ?? ''}`.toLowerCase().includes(query)))
    .map(m => ({ id: m.id, role: m.role, excerpt: m.content.slice(0,160), attachments:m.attachments?.map(a => ({name:a.name,kind:a.kind})) })));
  return { ok: true, content: JSON.stringify({ text: text.slice(offset,offset+limit), total: text.length, nextOffset: offset+limit < text.length ? offset+limit : null }) };
}
export function updatePlan(state: RunState, args: Record<string, unknown>): ToolResult {
  try {
    if (!Array.isArray(args.milestones) || args.milestones.length < 1 || args.milestones.length > 20) throw new Error('提供 1–20 个里程碑更新');
    const next = structuredClone(state.milestones ?? []);
    const ids = new Set<string>();
    for (const raw of args.milestones) {
      if (!raw || typeof raw !== 'object') throw new Error('里程碑必须是对象');
      const m = raw as Milestone;
      if (typeof m.id !== 'string' || !m.id.trim() || ids.has(m.id) || typeof m.title !== 'string' || !m.title.trim()) throw new Error('每项需要唯一 id 和标题');
      ids.add(m.id);
      if (!['pending','in_progress','completed','blocked'].includes(m.status)) throw new Error('状态无效');
      const evidence = Array.isArray(m.evidence) ? m.evidence.filter((s): s is string => typeof s === 'string') : [];
      // Evidence is either a successful tool step or a verbatim excerpt from a saved assistant answer.
      const valid = evidence.filter(e => state.steps?.some(s => (s.id === e || s.callId === e) && s.status === 'ok' && s.name !== 'update_plan') ||
        (e.startsWith('text:') && e.length > 15 && (state.content ?? '').includes(e.slice(5))));
      if (m.status === 'completed' && (!evidence.length || valid.length !== evidence.length)) throw new Error('完成项需要成功工具步骤 id/callId，或 text: 后附已写出的答案原文作为证据');
      const item: Milestone = { id: m.id.slice(0,120), title: m.title.slice(0,300), status: m.status, evidence: valid,
        acceptance: typeof m.acceptance === 'string' ? m.acceptance.slice(0,500) : undefined,
        note: typeof m.note === 'string' ? m.note.slice(0,500) : undefined, updatedAt: Date.now() };
      const index = next.findIndex(n => n.id === m.id);
      if (index < 0) next.push(item); else next[index] = item;
    }
    if (next.length > 20) throw new Error('最多 20 项；更新现有 id，不要不断创建新项');
    state.milestones = next;
    return { ok: true, content: JSON.stringify(next), summary: `里程碑 ${next.filter(m => m.status === 'completed').length}/${next.length}` };
  } catch (e) { return { ok: false, content: '', error: e instanceof Error ? e.message : String(e) }; }
}
/** Only compact a prefix ending before a recent complete assistant/tool batch. */
export function compressionCandidate(state: RunState, maxTokens: number): { messages: ChatMessage[]; throughIndex: number } | undefined {
  const previous = state.compactions?.at(-1)?.throughIndex ?? -1;
  const starts = state.working.map((m,i) => m.role === 'assistant' ? i : -1).filter(i => i > previous);
  if (starts.length < 3) return;
  let end = starts.at(-2)!-1;
  const begin = previous+1;
  while (end > begin && estimateChatTokens(state.working.slice(begin,end+1)) > maxTokens) {
    const earlier = starts.filter(i => i <= end).at(-1);
    if (earlier === undefined) return;
    end = earlier-1;
  }
  if (end <= previous || end < begin) return;
  const messages = state.working.slice(begin,end+1);
  // Reject orphaned/incomplete tool calls rather than correcting them in a summary.
  for (const m of messages) if (m.toolCalls?.some(c => !messages.some(r => r.toolCallId === c.id))) return;
  return { messages, throughIndex: end };
}
export function validateCompaction(raw: string, state: RunState, throughIndex: number): ContextCompaction {
  const data = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,''));
  const allowed = new Set(state.working.slice(0,throughIndex+1).map(m => m.id));
  const take = (key: string) => {
    if (!Array.isArray(data[key]) || data[key].length > 30) throw new Error('摘要结构无效');
    return data[key].map((item: { text: string; sources: string[] }) => {
      if (typeof item.text !== 'string' || item.text.length > 1600 || !Array.isArray(item.sources) || !item.sources.length || item.sources.some(s => !allowed.has(s))) throw new Error('摘要缺少有效来源');
      return { text: item.text, sources: item.sources };
    });
  };
  if (!Array.isArray(data.nextSteps) || data.nextSteps.length > 12 || data.nextSteps.some((s: unknown) => typeof s !== 'string' || s.length > 600)) throw new Error('下一步结构无效');
  const result: ContextCompaction = { version: 1, id: `compact-${Date.now()}-${throughIndex}`, throughId: state.working[throughIndex].id,
    throughIndex, facts: take('facts'), decisions: take('decisions'), unresolved: take('unresolved'), nextSteps: data.nextSteps,
    beforeTokens: estimateChatTokens(memoryView(state)), afterTokens: estimateTokens(raw), createdAt: Date.now() };
  if (!result.facts.length && !result.decisions.length && !result.unresolved.length) throw new Error('摘要为空');
  if (result.afterTokens > 6000) throw new Error('摘要超出预算');
  return result;
}
