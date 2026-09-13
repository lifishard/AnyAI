import type { ContextSnapshot, GenerationConfig, KeyProfile, ModelInfo, RouteOverrides } from '../types';
import { estimateRequestTokens, type LearnedLimit } from './limits';

export const RUNTIME_VERSION = 'delivery-1';
const CALIBRATION_KEY = 'anyai:context-calibration:v1';
type Calibration = { ratio: number; count: number; at: number };
const calibration = new Map<string,Calibration>();
try {
  const raw = JSON.parse(globalThis.localStorage?.getItem(CALIBRATION_KEY) || '{}');
  for (const [key,value] of Object.entries(raw)) {
    const c = value as Calibration;
    if (Number.isFinite(c.ratio) && c.ratio >= 1 && c.ratio <= 4 && Date.now()-c.at < 7*86400000) calibration.set(key,c);
  }
} catch { /* Estimates remain available without storage. */ }
function calibrationKey(profile: KeyProfile, cfg: GenerationConfig, body: Record<string,unknown>): string {
  const images = Array.isArray(body.messages) && body.messages.some((m: { content?: unknown }) => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
  return `${routeKey(profile,cfg.model)}::${cfg.effortLevel}::${images ? 'vision' : 'text'}`;
}
export function calibratedTokens(body: Record<string,unknown>, profile: KeyProfile, cfg: GenerationConfig): number {
  const entry = calibration.get(calibrationKey(profile,cfg,body));
  const ratio = entry && Date.now()-entry.at < 7*86400000 ? entry.ratio : 1;
  return Math.ceil(estimateRequestTokens(body)*ratio);
}
export function observeInput(body: Record<string,unknown>, profile: KeyProfile, cfg: GenerationConfig, actual?: number): void {
  if (!actual || actual < 1) return;
  const estimated = estimateRequestTokens(body), key = calibrationKey(profile,cfg,body), old = calibration.get(key);
  const measured = Math.max(1,Math.min(4,actual/Math.max(1,estimated)*1.08));
  calibration.set(key,{ ratio: Math.max(measured,(old?.ratio ?? 1)*0.9), count:(old?.count ?? 0)+1, at:Date.now() });
  if (calibration.size > 200) calibration.delete(calibration.keys().next().value!);
  try { globalThis.localStorage?.setItem(CALIBRATION_KEY,JSON.stringify(Object.fromEntries(calibration))); } catch { /* Optional cache */ }
}
export function routeKey(profile: KeyProfile, model: string): string {
  return `${profile.baseUrl.trim().replace(/\/+$/, '')}::chat-completions::${model}`;
}
export function quotaKey(profile: KeyProfile): string {
  return profile.quotaGroup?.trim() ? `pool:${profile.quotaGroup.trim()}` : `${profile.id}::${profile.baseUrl.trim().replace(/\/+$/, '')}`;
}
export function positive(value: unknown): number | undefined {
  const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
const min = (...values: unknown[]) => {
  const valid = values.map(positive).filter((x): x is number => x !== undefined);
  return valid.length ? Math.min(...valid) : undefined;
};
export function capabilities(profile: KeyProfile, cfg: GenerationConfig, learned?: LearnedLimit, metadata?: ModelInfo) {
  const override: RouteOverrides = profile.routeProfiles?.[routeKey(profile, cfg.model)] ?? {};
  // Error/header observations expire; explicit settings and model metadata do not silently disappear.
  const fresh = (key: 'maxContext' | 'maxOutput' | 'rpm' | 'tpm' | 'itpm' | 'otpm') => learned && Date.now()-(learned.observedAt?.[key] ?? learned.at) < 7*86400000 ? learned[key] : undefined;
  const window = min(override.contextWindow, metadata?.contextWindow, fresh('maxContext'));
  const sources = [['用户设置',override.contextWindow],['模型元数据',metadata?.contextWindow],['近期上游报告',fresh('maxContext')]] as const;
  return { ...override, contextWindow: window, maxOutput: min(override.maxOutput, metadata?.maxOutput, fresh('maxOutput')),
    rpm: min(override.rpm, cfg.runtime?.rpm, fresh('rpm')), tpm: min(override.tpm, cfg.runtime?.tpm, fresh('tpm')),
    itpm: min(override.itpm, fresh('itpm')), otpm: min(override.otpm, fresh('otpm')),
    source: window ? sources.filter(([,n]) => positive(n)).map(([label,n]) => `${label} ${n!.toLocaleString()}`).join('；')+'（取较小值）' : '窗口未知；使用保守工作预算' };
}
export function prepareBody(body: Record<string, unknown>, cfg: GenerationConfig, cap: RouteOverrides): Record<string, unknown> {
  const out = { ...body };
  if (out.model !== cfg.model) throw new Error('附加字段不能替换已选择的模型；请在模型选择器中切换');
  if (cfg.customBody?.trim()) {
    const custom = JSON.parse(cfg.customBody);
    if (!custom || typeof custom !== 'object' || Array.isArray(custom)) throw new Error('附加字段必须是 JSON 对象');
    if ('messages' in custom || 'tools' in custom) throw new Error('附加字段不能替换任务消息或工具；这会绕过上下文管理');
  }
  if (cfg.thinkingStyle === 'auto' && cap.effortStyle && cap.effortStyle !== 'mapping') {
    delete out.reasoning_effort; delete out.thinking; delete out.thinking_budget; delete out.enable_thinking;
    if (cap.effortStyle !== 'none' && cfg.effortLevel !== 'off') {
      const value = cap.effortValues?.[cfg.effortLevel];
      if (!value) throw new Error(`当前路由尚未配置 ${cfg.effortLevel} 的思考映射，请补充设置`);
      if (cap.effortStyle === 'reasoning_effort') out.reasoning_effort = value;
      else {
        const budget = positive(value); if (!budget) throw new Error('思考预算必须是正整数');
        if (cap.effortStyle === 'thinking_object') out.thinking = { type: 'enabled', budget_tokens: budget };
        else { out.enable_thinking = true; out.thinking_budget = budget; }
      }
    }
  }
  for (const field of ['max_tokens','max_completion_tokens']) if (out[field] !== undefined && !positive(out[field])) throw new Error(`${field} 必须是正整数`);
  const explicit = min(out.max_tokens, out.max_completion_tokens);
  if (out.max_tokens !== undefined && out.max_completion_tokens !== undefined) throw new Error('请只设置一种输出上限字段');
  if (explicit && cap.maxOutput && explicit > cap.maxOutput) throw new Error('输出预算超过当前路由已知上限，请调整输出配置');
  if (cap.outputField === 'none' && explicit) throw new Error('路由配置不支持输出上限字段，请关闭该参数');
  if (cap.outputField && cap.outputField !== 'none' && explicit) {
    delete out.max_tokens; delete out.max_completion_tokens; out[cap.outputField] = explicit;
  }
  return out;
}
export function outputReserve(body: Record<string, unknown>, cfg: GenerationConfig, cap: RouteOverrides): number {
  const thought = positive((body.thinking as { budget_tokens?: number })?.budget_tokens ?? body.thinking_budget) ?? 0;
  const explicit = positive(body.max_completion_tokens ?? body.max_tokens);
  if (explicit && thought >= explicit) throw new Error('输出上限必须覆盖思考预算并留出答案空间');
  const fallback = ({ off: 4096, low: 4096, medium: 8192, high: 16384, xhigh: 24576, max: 32768 } as Record<string, number>)[cfg.effortLevel] ?? 8192;
  const wanted = explicit ?? Math.max(thought ? thought+2048 : 0, Math.min(cap.maxOutput ?? Infinity, fallback));
  if (cap.maxOutput && wanted > cap.maxOutput) throw new Error('所选思考预算无法放入已知输出上限');
  return wanted;
}
export function workingBudget(cfg: GenerationConfig, cap: RouteOverrides, reserve: number): number {
  const manual = cfg.runtime?.contextMode === 'manual' || (!cfg.runtime?.contextMode && cfg.runtime?.contextTokens !== undefined && cfg.runtime.contextTokens !== 24000);
  const configured = cfg.runtime?.contextTokens || 24000;
  const available = cap.contextWindow ? cap.contextWindow-reserve-Math.max(1024, Math.ceil(cap.contextWindow*0.03)) : Infinity;
  const preferred = manual ? configured : cap.contextWindow ? Math.min(96000, available) : 24000;
  return Math.floor(Math.min(preferred, available, cap.tpm ? cap.tpm-reserve : Infinity, cap.itpm ?? Infinity));
}
export function snapshot(body: Record<string, unknown>, cfg: GenerationConfig, profile: KeyProfile, cap: ReturnType<typeof capabilities>, count = 0): ContextSnapshot {
  const messages = (body.messages ?? []) as { role: string; content: unknown }[];
  const countParts = (items: unknown[]) => items.length ? estimateRequestTokens(items) : 0;
  const system = countParts(messages.filter(m => m.role === 'system'));
  const toolResults = countParts(messages.filter(m => m.role === 'tool'));
  const tools = Array.isArray(body.tools) ? countParts(body.tools) : 0;
  const attachments = messages.reduce((sum, m) => sum+(Array.isArray(m.content) ? estimateRequestTokens([{ ...m, content: m.content.filter(p => p.type === 'image_url') }]) : 0), 0);
  const inputTokens = calibratedTokens(body,profile,cfg), reserve = outputReserve(body, cfg, cap);
  return { inputTokens, outputReserve: reserve, contextWindow: cap.contextWindow, workingBudget: workingBudget(cfg, cap, reserve),
    source: cap.source, estimated: true, components: { system, tools, toolResults, attachments, conversation: Math.max(0,inputTokens-system-tools-toolResults-attachments) },
    compressionCount: count, quota:{rpm:cap.rpm,tpm:cap.tpm,itpm:cap.itpm,otpm:cap.otpm}, routeKey: routeKey(profile, cfg.model), phase: 'preparing', at: Date.now() };
}
