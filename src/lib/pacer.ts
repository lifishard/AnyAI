/** Shared request queue, cancellation and a rolling minute ledger. */
export interface PaceState {
  intervalMs: number;
  lastSentAt: number;
  streak: number;
  hits: number;
  blockedUntil?: number;
  remaining?: Partial<Record<'requests' | 'tokens' | 'input' | 'output', { value: number; resetAt: number }>>;
}
interface Spent { id: string; at: number; tokens: number }
const WINDOW_MS = 60_000;
const STORAGE_KEY = 'anyai:rate-ledger:v2';
const states = new Map<string, PaceState>();
const spent = new Map<string, Spent[]>();
const chains = new Map<string, Promise<void>>();
let serial = 0;
try {
  const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || '{}');
  for (const [key, value] of Object.entries(saved.states ?? {})) {
    const s = value as PaceState;
    if (Number.isFinite(s.lastSentAt) && Date.now() - s.lastSentAt < 300_000) states.set(key, s);
  }
  for (const [key, value] of Object.entries(saved.spent ?? {})) {
    if (Array.isArray(value)) spent.set(key, value.filter((x) =>
      typeof x.id === 'string' && Number.isFinite(x.tokens) && Date.now() - x.at < WINDOW_MS));
  }
} catch { /* Storage is optional; never store API keys here. */ }
function persist() {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
    states: Object.fromEntries(states), spent: Object.fromEntries(spent),
  })); } catch { /* Rate accounting still works in memory. */ }
}
function stateOf(key: string): PaceState {
  let s = states.get(key);
  if (!s) { s = { intervalMs: 350, lastSentAt: 0, streak: 0, hits: 0 }; states.set(key, s); }
  return s;
}
export function paceOf(key: string): PaceState { return { ...stateOf(key) }; }
export function resetDeadline(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return now+Number(value)*1000;
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g)];
  if (parts.length && parts.map(m => m[0]).join('') === value.replace(/\s/g,'')) {
    return now+parts.reduce((n,m) => n+Number(m[1])*({ ms:1,s:1000,m:60000,h:3600000 }[m[2]] ?? 0),0);
  }
  const date = Date.parse(value); return Number.isFinite(date) ? date : undefined;
}
export function noteQuotaHeaders(key: string, headers: Record<string,string>, now = Date.now()): void {
  const s = stateOf(key); s.remaining ??= {};
  for (const [dimension, suffix] of [['requests','requests'],['tokens','tokens'],['input','input-tokens'],['output','output-tokens']] as const) {
    const prefix = headers[`x-ratelimit-remaining-${suffix}`] !== undefined ? 'x-ratelimit' : 'anthropic-ratelimit';
    const raw = headers[`${prefix}-${prefix === 'x-ratelimit' ? `remaining-${suffix}` : `${suffix}-remaining`}`];
    if (raw === undefined || !Number.isFinite(Number(raw)) || Number(raw) < 0) continue;
    const reset = headers[`${prefix}-${prefix === 'x-ratelimit' ? `reset-${suffix}` : `${suffix}-reset`}`];
    s.remaining[dimension] = { value: Number(raw), resetAt: resetDeadline(reset,now) ?? now+60000 };
  }
  persist();
}
export function waitForQuota(key: string, want: { tokens: number; input: number; output: number }, now = Date.now()): number {
  const remaining = stateOf(key).remaining ?? {};
  return Math.max(0,...Object.entries({ requests:1,...want }).map(([k,n]) => {
    const entry = remaining[k as keyof typeof remaining];
    return entry && entry.value < n && entry.resetAt > now ? entry.resetAt-now+250 : 0;
  }));
}
export function consumeQuota(key: string, want: { tokens: number; input: number; output: number }): void {
  const remaining = stateOf(key).remaining ?? {};
  for (const [k,n] of Object.entries({ requests:1,...want })) {
    const entry = remaining[k as keyof typeof remaining];
    if (entry && entry.resetAt > Date.now()) entry.value = Math.max(0,entry.value-n);
  }
  persist();
}
export function resetPace(key?: string): void { if (key) states.delete(key); else states.clear(); persist(); }
export function noteRateLimit(key: string, retryAfterMs?: number): number {
  const s = stateOf(key);
  s.hits++; s.streak = 0;
  s.intervalMs = Math.min(20_000, Math.max(700, s.intervalMs * 2));
  // Retry-After is a deadline, not an interval to cap at twenty seconds.
  const delay = retryAfterMs ?? 62_000;
  s.blockedUntil = Math.max(s.blockedUntil ?? 0, Date.now() + Math.max(0, delay));
  persist();
  return delay;
}
export function noteSuccess(key: string): void {
  const s = stateOf(key);
  if (++s.streak >= 3) { s.streak = 0; s.intervalMs = Math.max(200, Math.round(s.intervalMs * 0.75)); }
  persist();
}
export function abortError(): Error {
  const e = new Error('请求已停止'); e.name = 'AbortError'; return e;
}
export async function waitCancellable(ms: number, signal?: AbortSignal, onWait?: (ms: number) => void): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    const left = deadline - Date.now();
    onWait?.(left);
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(abortError()); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, Math.min(1000, left));
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    });
  }
  if (signal?.aborted) throw abortError();
}
export async function paced<T>(key: string, fn: () => Promise<T>, opts: {
  onWait?: (ms: number) => void;
  aborted?: () => boolean;
  signal?: AbortSignal;
  minIntervalMs?: number;
} = {}): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  // A cancelled waiter must not allow the next waiter to overtake the active request.
  const tail = prev.catch(() => {}).then(() => gate);
  chains.set(key, tail);
  let removeAbort = () => {};
  try {
    await Promise.race([prev, new Promise<never>((_, reject) => {
      const stop = () => reject(abortError());
      opts.signal?.addEventListener('abort', stop, { once: true });
      removeAbort = () => opts.signal?.removeEventListener('abort', stop);
      if (opts.signal?.aborted) stop();
    })]);
    if (opts.signal?.aborted || opts.aborted?.()) throw abortError();
    const s = stateOf(key);
    const floor = Math.max(s.intervalMs, opts.minIntervalMs ?? 0);
    const wait = Math.max(0, (s.lastSentAt ? s.lastSentAt + floor : 0) - Date.now(), (s.blockedUntil ?? 0) - Date.now());
    if (wait) await waitCancellable(wait, opts.signal, opts.onWait);
    if (opts.signal?.aborted || opts.aborted?.()) throw abortError();
    s.lastSentAt = Date.now(); persist();
    return await fn();
  } finally {
    removeAbort(); release();
    void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  }
}
const RATE_LIMITED = /rate.?limit|\brpm\b|\btpm\b|qps|quota.{0,12}(exceed|exhaust)|too many requests|429|请求过于频繁|并发|限流/i;
export function isRateLimited(msg: string, status?: number): boolean { return status === 429 || RATE_LIMITED.test(msg || ''); }
export function describePace(key: string): string {
  const s = stateOf(key);
  return `发送间隔 ${s.intervalMs}ms；已避让限流 ${s.hits} 次`;
}
export const ASSUMED_TPM = 20_000;
export function spacingForTokens(tokens: number, tpm = ASSUMED_TPM): number {
  return tokens > 0 && tpm > 0 ? Math.ceil(tokens / tpm * 60_000) : 0;
}
export function isTokenLimit(msg: string): boolean { return /tpm|token.{0,16}(per|\/)\s*min|每分钟.{0,8}token|token.{0,8}限制/i.test(msg || ''); }
function recent(key: string, now: number): Spent[] {
  const list = (spent.get(key) ?? []).filter((x) => now - x.at < WINDOW_MS);
  spent.set(key, list); return list;
}
export function tokensInWindow(key: string, now = Date.now()): number { return recent(key, now).reduce((a,b) => a+b.tokens, 0); }
export function reserveTokens(key: string, id: string, tokens: number): void {
  if (tokens <= 0) return;
  const list = recent(key, Date.now());
  const existing = list.find((x) => x.id === id);
  if (existing) existing.tokens = tokens;
  else list.push({ id, at: Date.now(), tokens });
  persist();
}
/** Usage replaces this request's reservation; repeated cumulative usage is not added twice. */
export function reconcileTokens(key: string, id: string, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens < 0) return;
  const list = recent(key, Date.now());
  const existing = list.find((x) => x.id === id);
  if (existing) existing.tokens = tokens;
  else list.push({ id, at: Date.now(), tokens });
  persist();
}
export function noteTokens(key: string, tokens: number): void { reserveTokens(key, `legacy-${++serial}`, tokens); }
export function waitForTokens(key: string, want: number, tpm?: number, now = Date.now()): number {
  if (!tpm || tpm <= 0 || want <= 0) return 0;
  if (want > tpm) throw new Error(`单次请求预算 ${want} token 超过整分钟额度 ${tpm}。请缩小上下文或输出预算；等待不能解决。`);
  const list = recent(key, now).sort((a,b) => a.at-b.at);
  let used = list.reduce((a,b) => a+b.tokens, 0);
  if (used + want <= tpm) return 0;
  for (const item of list) { used -= item.tokens; if (used + want <= tpm) return Math.max(0, item.at + WINDOW_MS + 250 - now); }
  return 0;
}
export function resetTokens(key?: string): void { if (key) spent.delete(key); else spent.clear(); persist(); }
