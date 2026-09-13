import type { ChatMessage, Conversation, RunRecord } from '../types';
import { desktop, getTransport } from './transport';
import { collectArtifacts } from './artifacts';
import { localProgress } from './task-context';
import { deliveryReport } from './delivery';
import { observeRun, reconcileObservations, removeObservations } from './observations';

const KEY = 'anyai:runs:v2';
const records = new Map<string, RunRecord>();
const forgotten = new Set<string>();
const forgottenConversations = new Set<string>();
let fallbackChain = Promise.resolve();
export async function loadRuns(): Promise<RunRecord[]> {
  const bridge = desktop();
  const list: RunRecord[] = bridge?.runList ? await bridge.runList()
    : JSON.parse(await getTransport().kvGet(KEY) || '[]');
  records.clear();
  for (const r of list) if (r.id && r.state?.working) records.set(r.id, r);
  await reconcileObservations([...records.values()]);
  return [...records.values()];
}
export async function saveRun(record: RunRecord): Promise<void> {
  if (forgotten.has(record.id) || forgottenConversations.has(record.conversationId)) return;
  const snapshot = structuredClone(record);
  const bridge = desktop();
  if (bridge?.runSave) {
    await bridge.runSave(snapshot);
    if (forgotten.has(snapshot.id) || forgottenConversations.has(snapshot.conversationId)) await bridge.runRemove?.(snapshot.id);
    else {records.set(snapshot.id, snapshot);await observeRun(snapshot);}
    return;
  }
  fallbackChain = fallbackChain.catch(() => {}).then(async () => {
    if (forgotten.has(snapshot.id) || forgottenConversations.has(snapshot.conversationId)) return;
    records.set(snapshot.id, snapshot);
    await getTransport().kvSet(KEY, JSON.stringify([...records.values()]));
    await observeRun(snapshot);
  });
  await fallbackChain;
}
export async function forgetRuns(conversationId: string, answerIds?: Set<string>): Promise<void> {
  if (!answerIds) forgottenConversations.add(conversationId);
  const selected = [...records.values()].filter((r) => r.conversationId === conversationId && (!answerIds || answerIds.has(r.answerId)));
  for (const r of selected) forgotten.add(r.id);
  const bridge = desktop();
  for (const r of selected) {
    if (bridge?.runRemove) await bridge.runRemove(r.id);
    records.delete(r.id);
  }
  if (!bridge?.runRemove) {
    fallbackChain = fallbackChain.catch(() => {}).then(() => getTransport().kvSet(KEY, JSON.stringify([...records.values()])));
    await fallbackChain;
  }
  await removeObservations(conversationId,answerIds);
}

export function runRecord(id:string):RunRecord|undefined {const r=records.get(id);return r?structuredClone(r):undefined;}
export function runTitle(id:string):string|undefined {const r=records.get(id);return r?(r.question.content.trim().replace(/\s+/g,' ').slice(0,96)||r.title):undefined;}
/** Recover even if the conversation's debounced save had not yet happened. */
export function recoverConversations(original: Conversation[], saved: RunRecord[]): Conversation[] {
  const list = original.map((c) => ({ ...c, messages: [...c.messages] }));
  for (const r of [...saved].sort((a,b) => a.state.at-b.state.at)) {
    const state = r.state;
    let conv = list.find((c) => c.id === r.conversationId);
    if (!conv) {
      conv = { id: r.conversationId, title: r.title, config: r.config, keyProfileId: r.keyProfileId,
        projectId: r.projectId, createdAt: r.question.createdAt, updatedAt: state.at, messages: [] };
      list.push(conv);
    }
    const index = conv.messages.findIndex((m) => m.id === r.answerId);
    const existing = index >= 0 ? conv.messages[index] : undefined;
    // The journal is authoritative for this run; ordinary chat saves may lag behind it.
    if ((existing?.runState?.at ?? 0) > state.at) continue;
    const completed = state.status === 'completed';
    const recovered = { ...state, status: completed ? 'completed' as const : 'paused' as const,
      reason: state.reason || '应用关闭或连接中断，执行记录已恢复' };
    const message: ChatMessage = {
      ...existing, id: r.answerId, role: 'assistant', createdAt: existing?.createdAt ?? r.question.createdAt,
      model: r.config.model, pending: false, content: state.content ?? existing?.content ?? '',
      reasoning: state.reasoning ?? existing?.reasoning, steps: state.steps ?? existing?.steps,
      sources: state.sources, usage: state.usage, runState: completed ? undefined : recovered,
      milestones: state.milestones, contextSnapshot: state.contextSnapshot, delivery: state.delivery ?? deliveryReport(state), taskId:r.id, supplementalInputs:state.supplementalInputs,
      progress: completed ? undefined : localProgress(state.steps ?? [], recovered.reason),
      artifacts: [...(existing?.artifacts ?? []), ...collectArtifacts(state.content ?? '', state.steps ?? [])]
        .filter((a, i, all) => all.findIndex((b) => b.path && a.path ? b.path === a.path && b.direction === a.direction : b.id === a.id) === i),
      error: state.errorInfo?.detail, errorInfo: state.errorInfo,
    };
    if (index >= 0) conv.messages[index] = message;
    else {
      if (!conv.messages.some((m) => m.id === r.question.id)) conv.messages.push(r.question);
      conv.messages.push(message);
    }
    conv.updatedAt = Math.max(conv.updatedAt, state.at);
  }
  return list;
}
