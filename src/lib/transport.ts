import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type {
  ChatRequestInit,
  ChatStreamHandlers,
  RemoteConfig,
  ToolContext,
  ToolResult,
  Transport,
  RunRecord,
  FileRecord,
} from '../types';
import {
  createStreamConsumer,
  createToolCallAccumulator,
  extractErrorMessage,
  type ToolCallDelta,
} from './sse';
import { beginExchange, recordRaw, recordResponse, endExchange, type Exchange } from './wiretap';
import {
  isRateLimited,
  noteRateLimit,
  noteSuccess,
  reserveTokens,
  reconcileTokens,
  paced,
  waitForTokens,
  waitCancellable,
  abortError,
  consumeQuota,
  noteQuotaHeaders,
  waitForQuota,
} from './pacer';

/* ================================================================== *
 * 原生桥接的协议
 *
 * 原生层（Electron 主进程 / Android 插件）只负责搬字节，发四种事件：
 *   chunk  —— SSE 原文片段
 *   body   —— 非流式的整包响应体
 *   done   —— 结束
 *   error  —— 已经翻成人话的错误
 * 解析全部在 TS 这一侧（src/lib/sse.ts），三个平台共用同一份实现。
 * ================================================================== */

interface NativeEvent {
  requestId: string;
  type: 'chunk' | 'body' | 'done' | 'error' | 'raw' | 'response';
  data?: unknown;
  /** type === 'error' 时的上游 HTTP 状态码 */
  status?: number;
}

interface ElectronBridge {
  platform: 'electron';
  runSave(record: RunRecord): Promise<void>;
  runList(): Promise<RunRecord[]>;
  runRemove(id: string): Promise<void>;
  exchanges(runId?: string): Promise<Exchange[]>;
  verifyFiles(paths: string[], roots: string[]): Promise<{ files: FileRecord[]; errors: { path: string; error: string }[] }>;
  saveArtifact(name: string, text?: string, sourcePath?: string): Promise<FileRecord | null>;
  saveAnalysisExport?(name:string,bytes:Uint8Array):Promise<FileRecord|null>;
  chat(init: ChatRequestInit): Promise<void>;
  abort(requestId: string): Promise<void>;
  getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown>;
  tool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
  onEvent(cb: (e: NativeEvent) => void): () => void;
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string): Promise<void>;
  secretGet(id: string): Promise<string | null>;
  secretSet(id: string, value: string): Promise<void>;
  secretDelete(id: string): Promise<void>;
  info(): Promise<{
    encryptionAvailable: boolean;
    storePath: string;
    version: string;
    platform: string;
  }>;
  pickFolder(): Promise<string | null>;
  pickFiles(mode: 'file' | 'image'): Promise<PickedFile[]>;
  revealPath(p: string): Promise<void>;
  openPath(p: string): Promise<string | null>;
  readArtifact(
    p: string,
    maxBytes?: number,
  ): Promise<{ ok: boolean; text?: string; size?: number; error?: string }>;
  skillsRead(dir: string): Promise<SkillFolderRead>;
  skillsWrite(dir: string, items: { name: string; md: string }[]): Promise<SkillFolderWrite>;
  skillsDefaultDir(): Promise<string>;
  chromeLaunch(port: number, path?: string): Promise<ChromeLaunchResult>;
  chromeStatus(port: number): Promise<ChromeStatus>;
  remoteStart(port: number, token: string): Promise<RemoteStatus>;
  remoteStop(): Promise<RemoteStatus>;
  remoteStatus(): Promise<RemoteStatus>;
}

/** 技能目录扫描结果 */
export interface SkillFolderRead {
  ok: boolean;
  dir?: string;
  exists?: boolean;
  items: { name: string; md: string; mtimeMs: number; path: string }[];
  error?: string;
}

export interface SkillFolderWrite {
  ok: boolean;
  dir?: string;
  written: string[];
  failed: { name: string; error: string }[];
  error?: string;
}

/** 主进程读回来的一个附件候选 */
export interface PickedFile {
  path: string;
  kind?: 'text' | 'image';
  name?: string;
  mime?: string;
  size?: number;
  text?: string;
  dataUrl?: string;
  error?: string;
}

export interface ChromeStatus {
  running: boolean;
  browser: string;
  browserPath: string;
  browserName: string;
  profileDir: string;
  port: number;
}

export interface ChromeLaunchResult {
  ok: boolean;
  alreadyRunning?: boolean;
  browser?: string;
  browserName?: string;
  profileDir?: string;
  error?: string;
}

/** 遥控服务的运行状态（只有桌面端有） */
export interface RemoteStatus {
  running: boolean;
  port: number;
  token: string;
  addresses: string[];
}

declare global {
  interface Window {
    snc?: ElectronBridge;
  }
}

interface SncHttpPlugin {
  request(opts: {
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    stream: boolean;
    timeoutMs: number;
  }): Promise<{ status: number; body?: string }>;
  abort(opts: { requestId: string }): Promise<void>;
  addListener(
    event: 'sncHttpEvent',
    cb: (e: NativeEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const SncHttp = registerPlugin<SncHttpPlugin>('SncHttp');

/* ------------------------------------------------------------------ *
 * 手机 / 浏览器把工具调用转交给桌面端时用的配置
 * ------------------------------------------------------------------ */

let remoteConfig: RemoteConfig = { enabled: false, url: '', token: '' };

export function setRemoteConfig(cfg: RemoteConfig) {
  remoteConfig = cfg;
}

export function getRemoteConfig(): RemoteConfig {
  return remoteConfig;
}

async function callRemoteTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!remoteConfig.enabled || !remoteConfig.url) {
    return {
      ok: false,
      content: '',
      error: '这台设备不能本地执行工具。请在设置里配好「遥控桌面端」，或者在电脑上操作。',
    };
  }
  const base = remoteConfig.url.replace(/\/+$/, '');
  const res = await fetch(`${base}/tool`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${remoteConfig.token}`,
    },
    body: JSON.stringify({ name, args, ctx }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 保持原文 */
  }
  if (!res.ok) {
    return {
      ok: false,
      content: '',
      error: extractErrorMessage(parsed, `遥控端返回 HTTP ${res.status}`),
    };
  }
  return parsed as ToolResult;
}

/* ------------------------------------------------------------------ *
 * 事件流 → handlers 的公共接线
 * ------------------------------------------------------------------ */

/**
 * 所有出站请求都从这里过，所以限流的账也记在这里 —— 分散到各个调用点去记，
 * 迟早会有一条路漏掉，而漏掉的那条正是把配额打爆的那条。
 */
/**
 * 过 IPC 之前把请求描述削成「一定能被结构化克隆」的样子。
 *
 * 这是一次真实事故的产物：给 ChatRequestInit 加了一个 onPaceWait 回调，
 * 它跟着 ipcRenderer.invoke 一起走，于是每一条请求都在 0.0 秒炸成
 * "An object could not be cloned."，一个字节都没发出去。类型系统拦不住
 * 这个 —— 函数在 TS 看来是完全合法的属性。
 *
 * 所以这里**白名单**而不是黑名单：只有明确列出来的字段能过去。
 * 以后再往 init 上加任何东西，不改这里就传不过去 —— 传不过去比悄悄炸掉好。
 */
export function cloneable(init: ChatRequestInit): ChatRequestInit {
  return {
    requestId: init.requestId,
    url: init.url,
    headers: init.headers,
    body: init.body,
    stream: init.stream,
    timeoutMs: init.timeoutMs,
    runId: init.runId,
    round: init.round,
    attempt: init.attempt,
    purpose: init.purpose,
  };
}

function paceKeyOf(init: ChatRequestInit): string {
  if (init.paceKey) return init.paceKey;
  try {
    return new URL(init.url).host;
  } catch {
    return init.url;
  }
}

function wireHandlers(h: ChatStreamHandlers, init?: ChatRequestInit) {
  if (init) beginExchange(init);
  const acc = createToolCallAccumulator();
  // 最后一个 finish_reason 说了算：多 choice 或带 usage 的收尾包可能各带一个
  let stopReason: string | null = null;
  const consumer = createStreamConsumer({
    onError: (message, status) => h.onError(message, status),
    onContent: (s) => h.onContent(s),
    onReasoning: (s) => h.onReasoning(s),
    onToolCallDelta: (d: ToolCallDelta[]) => acc.feed(d),
    onUsage: (u) => h.onUsage(u),
    onFinishReason: (r) => {
      stopReason = r;
    },
  });

  return {
    // 原文在解析之前先留一份 —— 解析器只会告诉你它看懂了什么，
    // 而这个问题恰恰出在「它没看懂的那部分」上
    consumer: {
      chunk(t: string) {
        recordRaw(t, init?.requestId);
        consumer.chunk(t);
      },
      body(t: string) {
        recordRaw(t, init?.requestId);
        consumer.body(t);
      },
      end() {
        consumer.end();
      },
    },
    finish() {
      consumer.end();
      const calls = acc.result();
      if (calls.length) h.onToolCalls(calls);
      // 先报「为什么停」再报 onDone —— 上层要先拿到原因才能决定这轮算不算结束
      h.onStop?.({ reason: stopReason, droppedCalls: acc.droppedCount() });
      h.onDone();
    },
  };
}

/* ================================================================== *
 * Electron
 * ================================================================== */

class ElectronTransport implements Transport {
  kind = 'electron' as const;
  private bridge: ElectronBridge;

  constructor(bridge: ElectronBridge) {
    this.bridge = bridge;
  }

  chat(init: ChatRequestInit, h: ChatStreamHandlers): Promise<void> {
    return new Promise<void>((resolve) => {
      const { consumer, finish } = wireHandlers(h, init);
      let settled = false;

      const off = this.bridge.onEvent((e) => {
        if (e.requestId !== init.requestId) return;
        switch (e.type) {
          case 'response':
            recordResponse(init.requestId, e.status ?? 0, e.data as Record<string, string>);
            h.onResponse?.(e.status ?? 0, e.data as Record<string, string>);
            break;
          case 'raw':
            recordRaw(String(e.data ?? ''), init.requestId);
            break;
          case 'chunk':
            consumer.chunk(String(e.data ?? ''));
            break;
          case 'body':
            consumer.body(String(e.data ?? ''));
            break;
          case 'done':
            if (settled) return;
            settled = true;
            off();
            finish();
            resolve();
            break;
          case 'error':
            if (settled) return;
            settled = true;
            off();
            h.onError(String(e.data ?? '未知错误'), typeof e.status === 'number' ? e.status : undefined);
            resolve();
            break;
        }
      });

      this.bridge.chat(cloneable(init)).catch((err: unknown) => {
        if (settled) return;
        settled = true;
        off();
        h.onError(err instanceof Error ? err.message : String(err));
        resolve();
      });
    });
  }

  abort(requestId: string) {
    return this.bridge.abort(requestId);
  }
  getJson(url: string, headers: Record<string, string>, timeoutMs: number) {
    return this.bridge.getJson(url, headers, timeoutMs);
  }
  callTool(name: string, args: unknown, ctx: ToolContext) {
    return this.bridge.tool(name, args, ctx);
  }
  canRunTools() {
    return true;
  }
  kvGet(key: string) {
    return this.bridge.kvGet(key);
  }
  kvSet(key: string, value: string) {
    return this.bridge.kvSet(key, value);
  }
  secretGet(id: string) {
    return this.bridge.secretGet(id);
  }
  secretSet(id: string, value: string) {
    return this.bridge.secretSet(id, value);
  }
  secretDelete(id: string) {
    return this.bridge.secretDelete(id);
  }
}

/* ================================================================== *
 * Capacitor (Android)
 * ================================================================== */

class CapacitorTransport implements Transport {
  kind = 'capacitor' as const;

  async chat(init: ChatRequestInit, h: ChatStreamHandlers): Promise<void> {
    const { consumer, finish } = wireHandlers(h, init);
    let settled = false;

    const handle = await SncHttp.addListener('sncHttpEvent', (e) => {
      if (e.requestId !== init.requestId) return;
      switch (e.type) {
        case 'chunk':
          consumer.chunk(String(e.data ?? ''));
          break;
        case 'body':
          consumer.body(String(e.data ?? ''));
          break;
        case 'done':
          if (!settled) {
            settled = true;
            finish();
          }
          break;
        case 'error':
          if (!settled) {
            settled = true;
            h.onError(String(e.data ?? '未知错误'), typeof e.status === 'number' ? e.status : undefined);
          }
          break;
      }
    });

    try {
      const res = await SncHttp.request({
        requestId: init.requestId,
        url: init.url,
        method: 'POST',
        headers: init.headers,
        body: JSON.stringify(init.body),
        stream: init.stream,
        timeoutMs: init.timeoutMs,
      });

      const bodyText = typeof res.body === 'string' ? res.body : '';

      if (res.status >= 400) {
        let parsed: unknown = bodyText;
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          /* 保持原文 */
        }
        if (!settled) {
          settled = true;
          h.onError(extractErrorMessage(parsed, `HTTP ${res.status}`), res.status);
        }
        return;
      }

      if (!init.stream && bodyText) {
        consumer.body(bodyText);
        if (!settled) {
          settled = true;
          finish();
        }
        return;
      }

      // 流式：原生 resolve 之后 done 事件可能还在桥上飘，给它一点时间落地
      if (init.stream && !settled) {
        const deadline = Date.now() + 2000;
        while (!settled && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
        }
        if (!settled) {
          settled = true;
          finish();
        }
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        h.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      await handle.remove();
    }
  }

  async abort(requestId: string) {
    await SncHttp.abort({ requestId });
  }

  async getJson(url: string, headers: Record<string, string>, timeoutMs: number) {
    const res = await SncHttp.request({
      requestId: `get-${Date.now()}`,
      url,
      method: 'GET',
      headers,
      body: '',
      stream: false,
      timeoutMs,
    });
    const text = res.body ?? '';
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 保持原文 */
    }
    if (res.status >= 400) throw new Error(extractErrorMessage(parsed, `HTTP ${res.status}`));
    return parsed;
  }

  callTool(name: string, args: unknown, ctx: ToolContext) {
    return callRemoteTool(name, args, ctx);
  }
  canRunTools() {
    return remoteConfig.enabled && Boolean(remoteConfig.url);
  }

  async kvGet(key: string) {
    const { value } = await Preferences.get({ key });
    return value ?? null;
  }
  async kvSet(key: string, value: string) {
    await Preferences.set({ key, value });
  }
  async secretGet(id: string) {
    const { value } = await Preferences.get({ key: `secret:${id}` });
    return value ?? null;
  }
  async secretSet(id: string, value: string) {
    await Preferences.set({ key: `secret:${id}`, value });
  }
  async secretDelete(id: string) {
    await Preferences.remove({ key: `secret:${id}` });
  }
}

/* ================================================================== *
 * Web（仅开发态；走 vite 的 /__sn 代理绕开 CORS）
 * ================================================================== */

function toDevProxy(url: string): { url: string; origin: string } {
  const u = new URL(url);
  return { url: `/__sn${u.pathname}${u.search}`, origin: `${u.protocol}//${u.host}` };
}

class WebTransport implements Transport {
  kind = 'web' as const;
  private controllers = new Map<string, AbortController>();

  async chat(init: ChatRequestInit, h: ChatStreamHandlers): Promise<void> {
    const { consumer, finish } = wireHandlers(h, init);
    const ctrl = new AbortController();
    this.controllers.set(init.requestId, ctrl);
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs);
    const { url, origin } = toDevProxy(init.url);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...init.headers, 'x-sn-base': origin },
        body: JSON.stringify(init.body),
        signal: ctrl.signal,
      });

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        if (/^(content-type|retry-after|x-request-id|x-ratelimit-[a-z-]+|anthropic-ratelimit-[a-z-]+)$/i.test(key)) responseHeaders[key] = value;
      });
      recordResponse(init.requestId, res.status, responseHeaders);
      h.onResponse?.(res.status, responseHeaders);
      if (!res.ok) {
        const text = await res.text();
        recordRaw(text, init.requestId);
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* 保持原文 */
        }
        h.onError(extractErrorMessage(parsed, `HTTP ${res.status}`), res.status);
        return;
      }

      if (!init.stream || !res.body) {
        consumer.body(await res.text());
        finish();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumer.chunk(decoder.decode(value, { stream: true }));
      }
      finish();
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        h.onError('请求已停止或响应等待超时');
      } else {
        h.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      clearTimeout(timer);
      this.controllers.delete(init.requestId);
    }
  }

  async abort(requestId: string) {
    this.controllers.get(requestId)?.abort();
    this.controllers.delete(requestId);
  }

  async getJson(url: string, headers: Record<string, string>, timeoutMs: number) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const { url: proxied, origin } = toDevProxy(url);
    try {
      const res = await fetch(proxied, {
        headers: { ...headers, 'x-sn-base': origin },
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* 保持原文 */
      }
      if (!res.ok) throw new Error(extractErrorMessage(parsed, `HTTP ${res.status}`));
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  callTool(name: string, args: unknown, ctx: ToolContext) {
    return callRemoteTool(name, args, ctx);
  }
  canRunTools() {
    return remoteConfig.enabled && Boolean(remoteConfig.url);
  }

  async kvGet(key: string) {
    return localStorage.getItem(key);
  }
  async kvSet(key: string, value: string) {
    localStorage.setItem(key, value);
  }
  async secretGet(id: string) {
    return localStorage.getItem(`secret:${id}`);
  }
  async secretSet(id: string, value: string) {
    localStorage.setItem(`secret:${id}`, value);
  }
  async secretDelete(id: string) {
    localStorage.removeItem(`secret:${id}`);
  }
}

/* ================================================================== */

let cached: Transport | null = null;

/**
 * 给任意一个 transport 套上发送节奏控制。
 *
 * 套在**最外层**而不是塞进三个 chat() 实现里：三份实现就是三次机会漏掉，
 * 而漏掉的那条恰好就是把配额打爆的那条。这里是唯一的出口，套一次全都算数。
 *
 * 限流的账也在这里记 —— onError 被包了一层，不管哪个平台、哪条代码路径
 * 报的错，都会经过同一个判断。
 */
function withPacing(t: Transport): Transport {
  const originalChat = t.chat.bind(t);
  const originalAbort = t.abort.bind(t);
  const controls = new Map<string, AbortController>();
  t.abort = async (id) => {
    controls.get(id)?.abort();
    await originalAbort(id);
  };
  t.chat = async (init: ChatRequestInit, h: ChatStreamHandlers) => {
    const key = paceKeyOf(init);
    const controller = new AbortController();
    controls.set(init.requestId, controller);
    let failed = false;
    let retryAfter: number | undefined;
    const wrapped: ChatStreamHandlers = {
      ...h,
      onResponse(status, headers) {
        noteQuotaHeaders(key,headers);
        const value = headers['retry-after'];
        if (value) {
          const seconds = Number(value);
          retryAfter = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(value)-Date.now());
          if (!Number.isFinite(retryAfter)) retryAfter = undefined;
        }
        h.onResponse?.(status, headers);
      },
      onUsage(usage) {
        const tokens = usage.total_tokens ?? ((usage.prompt_tokens ?? 0)+(usage.completion_tokens ?? 0));
        reconcileTokens(key, init.requestId, tokens);
        if (usage.prompt_tokens !== undefined) reconcileTokens(`${key}:input`,init.requestId,Math.max(0,usage.prompt_tokens-(init.cachedInputCounts === false ? usage.cached_tokens ?? 0 : 0)));
        if (usage.completion_tokens !== undefined) reconcileTokens(`${key}:output`,init.requestId,usage.completion_tokens);
        h.onUsage(usage);
      },
      onError(message, status) {
        failed = true;
        endExchange(init.requestId, message, status);
        if (!controller.signal.aborted && isRateLimited(message, status)) {
          noteRateLimit(key, retryAfter ?? parseRetryAfterMs(message));
        }
        h.onError(message, status);
      },
      onDone() {
        endExchange(init.requestId);
        if (!failed && !controller.signal.aborted) noteSuccess(key);
        h.onDone();
      },
    };
    try {
      await paced(key, async () => {
        const need = init.paceTokens ?? 0;
        for (;;) {
          const wait = Math.max(waitForTokens(key, need, init.paceTpm),
            waitForTokens(`${key}:input`,init.paceInput ?? 0,init.paceItpm),
            waitForTokens(`${key}:output`,init.paceOutput ?? 0,init.paceOtpm),
            waitForQuota(key,{ tokens:need,input:init.paceInput ?? 0,output:init.paceOutput ?? 0 }));
          if (!wait) break;
          await waitCancellable(wait, controller.signal, h.onPaceWait);
        }
        if (controller.signal.aborted) throw abortError();
        if (need > 0) reserveTokens(key, init.requestId, need);
        reserveTokens(`${key}:input`,init.requestId,init.paceInput ?? 0);
        reserveTokens(`${key}:output`,init.requestId,init.paceOutput ?? 0);
        consumeQuota(key,{ tokens:need,input:init.paceInput ?? 0,output:init.paceOutput ?? 0 });
        h.onDispatch?.();
        await originalChat(init, wrapped);
      }, { onWait: h.onPaceWait, minIntervalMs: init.paceMinMs, signal: controller.signal });
    } catch (err) {
      if (!failed) wrapped.onError(err instanceof Error ? err.message : String(err));
    } finally {
      if (controls.get(init.requestId) === controller) controls.delete(init.requestId);
    }
  };
  return t;
}

/** 上游说了等多久就等多久 —— 它比我们自己算的准 */
function parseRetryAfterMs(msg: string): number | undefined {
  const m = msg.match(/retry[-_ ]?after[^\d]{0,8}(\d+(?:\.\d+)?)\s*(ms|s|秒)?/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return m[2] === 'ms' ? n : n * 1000;
}

export function getTransport(): Transport {
  if (cached) return cached;
  if (typeof window !== 'undefined' && window.snc?.platform === 'electron') {
    cached = withPacing(new ElectronTransport(window.snc));
  } else if (Capacitor.isNativePlatform()) {
    cached = withPacing(new CapacitorTransport());
  } else {
    cached = withPacing(new WebTransport());
  }
  return cached;
}

/** 桌面端独有的能力（选目录、遥控服务）。其他平台返回 null */
export function desktop(): ElectronBridge | null {
  if (typeof window !== 'undefined' && window.snc?.platform === 'electron') return window.snc;
  return null;
}

export function platformLabel(): string {
  const t = getTransport();
  if (t.kind === 'electron') return '桌面版';
  if (t.kind === 'capacitor') return Capacitor.getPlatform() === 'ios' ? 'iOS' : 'Android';
  return '浏览器（开发态）';
}
