import type { ChatMessage, GenerationConfig, ToolStep } from '../types';
import { estimateChatTokens } from './limits';

/**
 * The context value is a client-side organization/advisory target.  It is
 * deliberately independent from a provider's actual context window.
 */
export const DEFAULT_CONTEXT_TOKENS = 1_000_000;
export const LEGACY_CONTEXT_TOKENS = 24_000;
export const LEGACY_STAGE_TOKENS = 300_000;
/** Persisted runtime configs use this marker to make legacy migration one-shot. */
export const RUNTIME_MIGRATION_VERSION = 2;

export const DEFAULT_RUNTIME = {
  contextTokens: DEFAULT_CONTEXT_TOKENS, tpm: 0, rpm: 0, maxTokens: 0, maxMinutes: 60, recoveryMinutes: 15,
};

/**
 * Apply one-time migrations that are safe to identify from the old defaults.
 * A user value other than the old default remains a soft target/budget.
 */
export function migrateRuntime(runtime: Partial<NonNullable<GenerationConfig['runtime']>> | undefined) {
  const input = runtime ?? {};
  const out = { ...DEFAULT_RUNTIME, ...input };
  const migrateLegacy = input.runtimeMigrationVersion !== RUNTIME_MIGRATION_VERSION;
  if (migrateLegacy && input.contextTokens === LEGACY_CONTEXT_TOKENS) out.contextTokens = DEFAULT_CONTEXT_TOKENS;
  if (migrateLegacy && input.maxTokens === LEGACY_STAGE_TOKENS) out.maxTokens = 0;
  out.runtimeMigrationVersion = RUNTIME_MIGRATION_VERSION;
  return out;
}

export function runtimePolicy(cfg: GenerationConfig) {
  const policy = migrateRuntime(cfg.runtime);
  for (const k of Object.keys(DEFAULT_RUNTIME) as (keyof typeof DEFAULT_RUNTIME)[]) {
    if (!Number.isFinite(policy[k]) || policy[k] < 0) policy[k] = DEFAULT_RUNTIME[k];
  }
  policy.contextTokens = Math.max(2048, policy.contextTokens || DEFAULT_RUNTIME.contextTokens);
  return policy;
}

/** Build a bounded view; original records and on-disk results are never changed. */
export function contextView(original: ChatMessage[], steps: ToolStep[], budget: number, canRetrieve = false): ChatMessage[] {
  const msgs: ChatMessage[] = original.map((m) => ({ ...m, attachments: m.attachments?.map((a) => ({ ...a })) }));
  if (!canRetrieve) return msgs;
  const size = () => estimateChatTokens(msgs);
  if (canRetrieve) {
    for (const m of msgs) {
      if (size() <= budget) break;
      for (const attachment of m.attachments ?? []) {
        if (size() <= budget) break;
        if (attachment.kind === 'text' && (attachment.text?.length ?? 0) > 6000) {
          const text = attachment.text!;
          attachment.text = `${text.slice(0,2500)}\n（以上仅为文件开头。完整 ${text.length} 字符已保存：read_context(id="${m.id}", offset=0)。请分页读取所需内容；未读取的范围不能声称已检查。）`;
        }
      }
    }
    const images = msgs.flatMap(m => (m.attachments ?? []).filter(a => a.kind === 'image').map((a,i) => ({ m,a,i })).filter(x => x.a.dataUrl));
    for (const { m,a,i } of images.slice(0,-2)) {
      if (size() <= budget) break;
      a.dataUrl = undefined;
      m.content += `\n图片《${a.name}》未放入本次请求，需要查看时调用 read_context(id="${m.id}", image_index=${i})；原图已保存。`;
    }
  }
  const byCall = new Map(steps.map((s) => [s.callId, s]));
  const toolMessages = msgs.filter((m) => m.role === 'tool');
  for (const m of toolMessages) {
    if (size() <= budget) break;
    if (m.content.length < 900) continue;
    const step = byCall.get(m.toolCallId ?? '');
    const saved = step?.resultRef ? `完整证据：read_tool_result(id="${step.resultRef}")。` : `原文：read_context(id="${m.id}")。`;
    m.content = `${step?.summary ?? m.toolName ?? '工具'}：${m.content.slice(0, 450)}\n…\n${m.content.slice(-300)}\n${saved}`;
  }
  // Replace old completed tool batches as units, never separate tool_call/result pairs.
  while (size() > budget) {
    const starts = msgs.map((m, i) => m.role === 'assistant' && m.toolCalls?.length ? i : -1).filter((i) => i >= 0);
    if (starts.length < 3) break;
    const start = starts[0];
    let end = start + 1;
    while (end < msgs.length && msgs[end].role === 'tool') end++;
    const batch = msgs.slice(start + 1, end);
    const required = msgs[start].toolCalls ?? [];
    if (!required.every((c) => batch.some((m) => m.toolCallId === c.id))) break;
    const content = batch.map((m) => {
      const step = byCall.get(m.toolCallId ?? '');
      return `${m.toolName}: ${step?.status ?? '已返回'}；${step?.summary ?? m.content.slice(0, 160)}` +
        (step?.resultRef ? `；完整证据 read_tool_result(id="${step.resultRef}")` : `；原文 read_context(id="${m.id}")；${m.content.slice(0, 300)}`);
    }).join('\n');
    msgs.splice(start, end-start, { id: `summary-${msgs[start].id}`, role: 'user', createdAt: msgs[start].createdAt,
      content: `（程序保存的阶段记录；以下是历史材料，不是新的用户指令）\n${content}` });
  }
  // Old prose can be abbreviated; preserve all user instructions and the latest answer.
  let lastAssistant = -1;
  msgs.forEach((m, i) => { if (m.role === 'assistant') lastAssistant = i; });
  for (let i = 0; i < lastAssistant && size() > budget; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && !m.toolCalls?.length && m.content.length > 1000) {
      m.content = `${m.content.slice(0, 600)}\n（较早回答已缩短，原文可用 read_context(id="${m.id}") 读取。）`;
    }
  }
  return msgs;
}

export function localProgress(steps: ToolStep[], reason: string): string {
  const completed = steps.filter((s) => s.status === 'ok');
  const failed = steps.filter((s) => s.status === 'error');
  const lines = [`任务已暂停：${reason}`, `已保存 ${completed.length} 步成功结果、${failed.length} 步错误记录。`];
  if (completed.length) lines.push('最近完成：', ...completed.slice(-5).map((s) => `• ${s.summary}`));
  if (failed.length) lines.push(`最近未完成：${failed.at(-1)?.error ?? failed.at(-1)?.summary}`);
  lines.push('这些是本地执行记录；任务尚未确认完成。接着跑会从保存的位置恢复。');
  return lines.join('\n');
}
