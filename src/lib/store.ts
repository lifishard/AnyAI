import type {
  AppSettings,
  Conversation,
  GenerationConfig,
  SessionGrants,
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
    claudeExtraArgs: '',
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
    skillSync: { dir: '', auto: false },
  };
}

/** 从设置里拎出传给原生层的工具上下文（不含密钥） */
export function toolContextOf(
  s: AppSettings,
  projectId: string | null = null,
  grants: SessionGrants = { extraRoots: [], admin: false, screen: false },
): ToolContext {
  return {
    projectId,
    grants,
    // 会话里临时放行的目录并进白名单 —— 它们跟设置里那些一样要过 guardPath，
    // 只是活不过这次会话
    workspaceRoots: [...s.tools.workspaceRoots, ...grants.extraRoots],
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed.schemaVersion ?? 1) > 2) throw new Error("设置格式不兼容，请使用兼容版本");
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
    if(merged.tools.claudeExtraArgs.trim()==='--permission-mode acceptEdits')merged.tools.claudeExtraArgs='';
    merged.remote = { enabled: false, url: '', token: '', ...(parsed.remote ?? {}) };
    merged.skillSync = { dir: '', auto: false, ...(parsed.skillSync ?? {}) };
    /*
     * 一次性迁移：把老配置里默认开着的 max_tokens 关掉。
     *
     * 它当初是「默认开 + 4096」，等于给每一次请求都扣了一顶输出天花板。
     * 这种由默认值造成的截断，用户几乎不可能自己定位到 —— 现象在输出末尾，
     * 原因在一个他从没打开过的面板里。所以这里替他关掉一次。
     *
     * 只做一次，认 schemaVersion。用户之后自己重新开它，不会再被关。
     */
    if ((parsed.schemaVersion ?? 1) < 2) {
      const mt = merged.defaultConfig.params.max_tokens;
      if (mt) merged.defaultConfig.params = { ...merged.defaultConfig.params, max_tokens: { ...mt, enabled: false } };
      merged.schemaVersion = 2;
    } else {
      merged.schemaVersion = parsed.schemaVersion;
    }

    // 过期的记忆当场丢掉，别让它在设置里躺成一条永远不会生效的死记录
    merged.rememberedGrants =
      parsed.rememberedGrants && parsed.rememberedGrants.expiresAt > Date.now()
        ? parsed.rememberedGrants
        : undefined;
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
  } catch (error) {
    throw new Error(`设置读取失败：${String(error)}`);
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
    if (!Array.isArray(list)) throw new Error("会话格式无效");

    /*
     * 每条会话都拷了一份自己的 config，所以那顶 max_tokens 天花板也拷进去了。
     * 只迁移 defaultConfig 的话，老对话会继续被截断，而用户以为已经修好了。
     * 这里单独读一次设置判版本 —— 多一次 kv 读，换「修了就是修了」。
     */
    let stripCap = false;
    try {
      const sRaw = await getTransport().kvGet(K_SETTINGS);
      stripCap = !sRaw || ((JSON.parse(sRaw) as Partial<AppSettings>).schemaVersion ?? 1) < 2;
    } catch {
      /* 读不到就不迁移，宁可不动用户的东西 */
    }

    return list.map((c) => {
      const config = mergeParamDefaults(c.config ?? defaultGenerationConfig());
      if (stripCap && config.params.max_tokens) {
        config.params = {
          ...config.params,
          max_tokens: { ...config.params.max_tokens, enabled: false },
        };
      }
      return {
        ...c,
        config,
        messages: (c.messages ?? []).map((m) => ({ ...m, pending: false })),
      };
    });
  } catch (error) {
    throw new Error(`会话读取失败：${String(error)}`);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function saveConversationsDebounced(list: Conversation[], onError?: (error: unknown) => void): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void getTransport().kvSet(K_CONVS, JSON.stringify(list)).catch(error => onError?.(error));
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
