import type { GenerationConfig, KeyProfile, ModelInfo } from '../types';
import { buildRequestBody, type WireMessage } from './paramSchema';
import { composeSystem } from './system';
import { getTransport } from './transport';

export const BASE_URL_PRESETS = [
  {
    label: '日日新 Token 端点（免费额度，OpenAI 兼容）',
    url: 'https://token.sensenova.cn/v1',
  },
  {
    label: '日日新 OpenAI 兼容模式 v2',
    url: 'https://api.sensenova.cn/compatible-mode/v2',
  },
  {
    label: '日日新 OpenAI 兼容模式 v1',
    url: 'https://api.sensenova.cn/compatible-mode/v1',
  },
  {
    label: 'Kimi / Moonshot（上下文缓存自动生效）',
    url: 'https://api.moonshot.cn/v1',
  },
  {
    label: 'DeepSeek',
    url: 'https://api.deepseek.com/v1',
  },
];

/**
 * 兜底候选模型：只在 /models 拉不到时给个起点，随时可以在设置里增删。
 * 真正的权威列表永远以 GET {base}/models 的返回为准。
 */
export const SEED_MODELS: ModelInfo[] = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash', custom: true },
  { id: 'sensenova-6.7-flash-lite', label: 'SenseNova 6.7 Flash-Lite（多模态）', custom: true },
  { id: 'SenseChat-5', label: 'SenseChat-5', custom: true },
];

export function normalizeBaseUrl(input: string): string {
  let s = (input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, '');
}

export function endpoint(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${path.replace(/^\/+/, '')}`;
}

export function buildHeaders(apiKey: string, profile: KeyProfile | null): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  if (profile?.extraHeaders) {
    for (const [k, v] of Object.entries(profile.extraHeaders)) {
      if (k.trim()) h[k.trim()] = v;
    }
  }
  return h;
}

/** 从 GET /models 拉模型列表，兼容几种常见返回形状 */
export async function fetchModels(
  profile: KeyProfile,
  apiKey: string,
  timeoutMs: number,
): Promise<ModelInfo[]> {
  const t = getTransport();
  const raw = await t.getJson(
    endpoint(profile.baseUrl, 'models'),
    buildHeaders(apiKey, profile),
    timeoutMs,
  );

  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.data)) list = o.data;
    else if (Array.isArray(o.models)) list = o.models;
    else if (o.data && typeof o.data === 'object') {
      const d = o.data as Record<string, unknown>;
      if (Array.isArray(d.models)) list = d.models;
      else if (Array.isArray(d.data)) list = d.data;
    }
  }

  const out: ModelInfo[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      out.push({ id: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id =
      (typeof o.id === 'string' && o.id) ||
      (typeof o.model === 'string' && o.model) ||
      (typeof o.name === 'string' && o.name) ||
      '';
    if (!id) continue;
    out.push({
      id,
      label: typeof o.display_name === 'string' ? o.display_name : undefined,
      ownedBy: typeof o.owned_by === 'string' ? o.owned_by : undefined,
    });
  }
  // 去重 + 按 id 排序
  const seen = new Set<string>();
  return out
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 预览将要发出的请求体，供配置面板里的「查看请求体」用。
 * 只展示一轮的形状，工具往返不在这里体现。
 *
 * extraSystem 是项目规范 + 本轮唤起的技能。它一定要出现在这里 ——
 * 「我 /了一个技能，模型到底收到没有」这个问题，只有预览能回答。
 * system 消息的拼法跟真实请求共用 composeSystem，不另写一份。
 */
export function previewBody(
  cfg: GenerationConfig,
  userText: string,
  toolNames: string[],
  extraSystem = '',
): string {
  const messages: WireMessage[] = [];
  const sys = composeSystem(cfg.systemPrompt, extraSystem, toolNames.length > 0);
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push({ role: 'user', content: userText || '（这里是你输入的问题）' });
  return JSON.stringify(buildRequestBody(cfg, messages, toolNames), null, 2);
}
