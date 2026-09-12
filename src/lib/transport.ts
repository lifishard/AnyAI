import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type {
  ChatRequestInit,
  ChatStreamHandlers,
  RemoteConfig,
  ToolContext,
  ToolResult,
  Transport,
} from '../types';
import {
  createStreamConsumer,
  createToolCallAccumulator,
  extractErrorMessage,
  type ToolCallDelta,
} from './sse';

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
  type: 'chunk' | 'body' | 'done' | 'error';
  data?: unknown;
}

interface ElectronBridge {
  platform: 'electron';
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
  chromeLaunch(port: number, path?: string): Promise<ChromeLaunchResult>;
  chromeStatus(port: number): Promise<ChromeStatus>;
  remoteStart(port: number, token: string): Promise<RemoteStatus>;
  remoteStop(): Promise<RemoteStatus>;
  remoteStatus(): Promise<RemoteStatus>;
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

function wireHandlers(h: ChatStreamHandlers) {
  const acc = createToolCallAccumulator();
  const consumer = createStreamConsumer({
    onContent: (s) => h.onContent(s),
    onReasoning: (s) => h.onReasoning(s),
    onToolCallDelta: (d: ToolCallDelta[]) => acc.feed(d),
    onUsage: (u) => h.onUsage(u),
  });

  return {
    consumer,
    finish() {
      consumer.end();
      const calls = acc.result();
      if (calls.length) h.onToolCalls(calls);
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
      const { consumer, finish } = wireHandlers(h);
      let settled = false;

      const off = this.bridge.onEvent((e) => {
        if (e.requestId !== init.requestId) return;
        switch (e.type) {
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
            h.onError(String(e.data ?? '未知错误'));
            resolve();
            break;
        }
      });

      this.bridge.chat(init).catch((err: unknown) => {
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
    const { consumer, finish } = wireHandlers(h);
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
            h.onError(String(e.data ?? '未知错误'));
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
          h.onError(extractErrorMessage(parsed, `HTTP ${res.status}`));
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
    const { consumer, finish } = wireHandlers(h);
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

      if (!res.ok) {
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* 保持原文 */
        }
        h.onError(extractErrorMessage(parsed, `HTTP ${res.status}`));
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
        finish();
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

export function getTransport(): Transport {
  if (cached) return cached;
  if (typeof window !== 'undefined' && window.snc?.platform === 'electron') {
    cached = new ElectronTransport(window.snc);
  } else if (Capacitor.isNativePlatform()) {
    cached = new CapacitorTransport();
  } else {
    cached = new WebTransport();
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
