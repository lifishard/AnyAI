/** Per-request diagnostics. A retry never replaces the request that failed. */
export interface Exchange {
  requestId: string;
  runId?: string;
  round?: number;
  attempt?: number;
  purpose?: string;
  at: number;
  endedAt?: number;
  url: string;
  stream: boolean;
  request: unknown;
  raw: string;
  truncated: boolean;
  status?: number;
  responseHeaders?: Record<string, string>;
  error?: string;
}
const RAW_CAP = 256_000;
const exchanges: Exchange[] = [];
export function beginExchange(init: { requestId?: string; runId?: string; round?: number; attempt?: number; purpose?: string; url: string; body: unknown; stream: boolean }): void {
  exchanges.push({ ...init, requestId: init.requestId || `request-${Date.now()}`, at: Date.now(), request: init.body, raw: '', truncated: false });
  if (exchanges.length > 40) exchanges.shift();
}
export function lastExchange(): Exchange | null { return exchanges.at(-1) ?? null; }
export function exchangeOf(id?: string): Exchange | null {
  return id ? exchanges.find((e) => e.requestId === id) ?? null : lastExchange();
}
export function failedExchange(runId?: string): Exchange | null {
  return [...exchanges].reverse().find((e) => e.error && (!runId || e.runId === runId) && e.purpose !== 'probe') ?? null;
}
export function importExchanges(items: Exchange[]): void {
  for (const e of items) if (!exchangeOf(e.requestId)) exchanges.push(e);
  exchanges.sort((a,b) => a.at-b.at);
  if (exchanges.length > 100) exchanges.splice(0, exchanges.length-100);
}
export function recordRaw(text: string, requestId?: string): void {
  const e = exchangeOf(requestId); if (!e || !text) return;
  const room = RAW_CAP-e.raw.length;
  e.raw += text.slice(0, Math.max(0,room));
  if (text.length > room) e.truncated = true;
}
export function recordResponse(id: string, status: number, headers: Record<string,string>): void {
  const e = exchangeOf(id); if (e) { e.status = status; e.responseHeaders = headers; }
}
export function endExchange(id: string, error?: string, status?: number): void {
  const e = exchangeOf(id); if (!e) return;
  e.endedAt = Date.now(); if (error) e.error = error; if (status !== undefined) e.status = status;
}
function verdict(e: Exchange): string[] {
  const req = (e.request ?? {}) as Record<string, unknown>;
  const out = [`阶段：${e.purpose || 'agent'}；轮次：${e.round ?? '—'}；尝试：${e.attempt ?? '—'}`];
  out.push(Array.isArray(req.tools) ? `下发 ${req.tools.length} 个工具` : '本次未下发工具（纯文本、收尾或部分诊断请求可以不带工具）');
  out.push(e.status ? `收到 HTTP ${e.status}` : '尚未记录到 HTTP 响应状态');
  if (e.error) out.push(`失败信息：${e.error}`);
  if (!e.raw.trim()) out.push('未记录到响应正文；不能据此推断上游没有返回响应头。');
  const reasons = [...e.raw.matchAll(/"(?:finish|stop)_reason"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (reasons.length) out.push(`结束原因：${[...new Set(reasons)].join('、')}`);
  return out;
}
export function formatExchange(selected?: Exchange | null): string {
  const e = selected ?? failedExchange() ?? lastExchange();
  if (!e) return '还没有请求记录。';
  const list = exchanges.filter((x) => !e.runId || x.runId === e.runId).slice(-20);
  return [
    '请求记录（优先显示失败请求；不含请求 headers）',
    ...list.map((x) => `${x.requestId === e.requestId ? '→' : '·'} ${x.requestId} | ${x.purpose || 'agent'} | 轮次 ${x.round ?? '—'} | HTTP ${x.status ?? '—'} | ${x.error || '无已记录错误'}`),
    '', `请求编号：${e.requestId}`, `地址：${e.url}`, ...verdict(e),
    '', '—— 响应元数据 ——', JSON.stringify(e.responseHeaders ?? {}, null, 2),
    '', '—— 实际发送的请求体 ——', JSON.stringify(e.request, null, 2),
    '', `—— 响应原文${e.truncated ? '（已截断）' : ''} ——`, e.raw || '（空）',
  ].join('\n');
}
