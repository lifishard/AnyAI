import type {
  AppSettings,
  Conversation,
  GenerationConfig,
  ToolConfig,
  ToolContext,
} from '../types';
import { defaultGenerationConfig, mergeParamDefaults } from './paramSchema';
import { BAKED_IN_PATTERN, defaultEffortMappings } from './effort';
import { getTransport } from './transport';

const K_SETTINGS = 'snc:settings:v1';
const K_CONVS = 'snc:conversations:v1';

export function uid(prefix = ''): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix ? `${prefix}-${rnd}` : rnd;
}

export function defaultToolConfig(): ToolConfig {
  return {
    workspaceRoots: [],
    searchProvider: 'tavily',
    searxngUrl: '',
    chromePort: 9222,
    claudeBin: '',
    claudeExtraArgs: '--permission-mode acceptEdits',
    claudeTimeoutMs: 600000,
    toolTimeoutMs: 120000,
  };
}

export function defaultSettings(): AppSettings {
  return {
    keyProfiles: [],
    activeKeyProfileId: null,
    customModels: {},
    cachedModels: {},
    defaultConfig: defaultGenerationConfig(),
    theme: 'system',
    sendKey: 'enter',
    fontScale: 1,
    showReasoningByDefault: true,
    requestTimeoutMs: 180000,
    tools: defaultToolConfig(),
    remote: { enabled: false, url: '', token: '' },
    effortMappings: defaultEffortMappings(),
    modelHealth: {},
    autoRetry: 2,
  };
}

/** 从设置里拎出传给原生层的工具上下文（不含密钥） */
export function toolContextOf(s: AppSettings, projectId: string | null = null): ToolContext {
  return {
    projectId,
    workspaceRoots: s.tools.workspaceRoots,
    searchProvider: s.tools.searchProvider,
    searxngUrl: s.tools.searxngUrl,
    chromePort: s.tools.chromePort,
    claudeBin: s.tools.claudeBin,
    claudeExtraArgs: s.tools.claudeExtraArgs,
    claudeTimeoutMs: s.tools.claudeTimeoutMs,
    toolTimeoutMs: s.tools.toolTimeoutMs,
  };
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await getTransport().kvGet(K_SETTINGS);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const merged: AppSettings = { ...defaultSettings(), ...parsed };
    merged.defaultConfig = mergeParamDefaults(
      (parsed.defaultConfig ?? defaultGenerationConfig()) as GenerationConfig,
    );
    merged.keyProfiles = (parsed.keyProfiles ?? []).map((p) => ({
      ...p,
      extraHeaders: p.extraHeaders ?? {},
    }));
    merged.customModels = parsed.customModels ?? {};
    merged.cachedModels = parsed.cachedModels ?? {};
    merged.tools = { ...defaultToolConfig(), ...(parsed.tools ?? {}) };
    merged.remote = { enabled: false, url: '', token: '', ...(parsed.remote ?? {}) };
    merged.effortMappings = parsed.effortMappings?.length
      ? parsed.effortMappings
      : defaultEffortMappings();
    // 「模型名自带强度」这条是后加的，老配置里没有。补在最前面 ——
    // 少了它，dva/claude-5-fable-high 会被「claude」那条抓走再塞一个 thinking 对象。
    if (!merged.effortMappings.some((m) => m.id === 'baked-in')) {
      merged.effortMappings = [
        {
          id: 'baked-in',
          pattern: BAKED_IN_PATTERN,
          label: '模型名自带强度',
          style: 'none',
          levels: { low: '', medium: '', high: '', xhigh: '', max: '' },
        },
        ...merged.effortMappings,
      ];
    }
    return merged;
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  await getTransport().kvSet(K_SETTINGS, JSON.stringify(s));
}

export async function loadConversations(): Promise<Conversation[]> {
  try {
    const raw = await getTransport().kvGet(K_CONVS);
    if (!raw) return [];
    const list = JSON.parse(raw) as Conversation[];
    if (!Array.isArray(list)) return [];
    return list.map((c) => ({
      ...c,
      config: mergeParamDefaults(c.config ?? defaultGenerationConfig()),
      messages: (c.messages ?? []).map((m) => ({ ...m, pending: false })),
    }));
  } catch {
    return [];
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function saveConversationsDebounced(list: Conversation[]): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void getTransport().kvSet(K_CONVS, JSON.stringify(list));
  }, 400);
}

export async function saveConversationsNow(list: Conversation[]): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await getTransport().kvSet(K_CONVS, JSON.stringify(list));
}

export function newConversation(cfg: GenerationConfig, keyProfileId: string | null): Conversation {
  const now = Date.now();
  return {
    id: uid('c'),
    title: '新对话',
    messages: [],
    config: JSON.parse(JSON.stringify(cfg)) as GenerationConfig,
    keyProfileId,
    createdAt: now,
    updatedAt: now,
  };
}

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '新对话';
  return t.length > 24 ? `${t.slice(0, 24)}…` : t;
}

/* --------- 密钥读写（走各平台的安全存储） --------- */

export function secretGet(id: string) {
  return getTransport().secretGet(id);
}
export function secretSet(id: string, value: string) {
  return getTransport().secretSet(id, value);
}
export function secretDelete(id: string) {
  return getTransport().secretDelete(id);
}
