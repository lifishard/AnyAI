import type { EffortLevel, EffortMapping } from './lib/effort';

/* ------------------------------------------------------------------ *
 * 全局数据模型
 * ------------------------------------------------------------------ */

/** 一份 API 凭据（可以登记多份，例如免费额度号 / 付费号 / 自建网关） */
export interface KeyProfile {
  id: string;
  /** 显示名，例如 "日日新免费额度" */
  name: string;
  /** API base url，末尾不带斜杠。例如 https://token.sensenova.cn/v1 */
  baseUrl: string;
  /** 真正的密钥不存在这个对象里，只存 id；密钥走 secretGet/secretSet 单独加密保存 */
  hasSecret: boolean;
  /** 附加请求头，给自建网关 / 企业代理用 */
  extraHeaders: Record<string, string>;
  createdAt: number;
}

export interface ModelInfo {
  id: string;
  label?: string;
  ownedBy?: string;
  /** true = 用户手动添加的，不是从 /models 拉到的 */
  custom?: boolean;
}

/** 思考强度的下发风格 —— 不同厂商字段不一样，做成可切换而不是写死 */
export type ThinkingStyle =
  /** 交给映射表按模型自动决定 —— 默认就是这个 */
  | 'auto'
  | 'off'
  | 'reasoning_effort'
  | 'enable_thinking'
  | 'thinking_object'
  | 'custom';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ParamState {
  enabled: boolean;
  value: number | string | boolean;
}

/** 一次会话的全部生成配置 */
export interface GenerationConfig {
  model: string;
  stream: boolean;
  systemPrompt: string;
  /** 带进上下文的历史消息条数上限，0 = 不限制 */
  historyLimit: number;
  /** 思考强度的五级刻度，具体翻译成什么字段由映射表决定 */
  effortLevel: EffortLevel;
  /** 下面三个是老的手动模式，只在 thinkingStyle !== 'auto' 时生效，留给要抠细节的场景 */
  thinkingStyle: ThinkingStyle;
  reasoningEffort: ReasoningEffort;
  thinkingBudget: number;
  params: Record<string, ParamState>;
  /** 完全自由的附加字段，JSON 对象，最后浅合并进请求体 */
  customBody: string;

  /* ---- Agent 相关 ---- */
  /** 是否给模型下发工具 */
  toolsEnabled: boolean;
  /** 启用的工具名单；空数组 = 全部可用工具 */
  enabledTools: string[];
  /** 一次提问最多允许几轮工具调用，防止死循环烧额度 */
  maxToolRounds: number;
  /** 危险工具的放行策略 */
  approvalMode: ApprovalMode;
}

/**
 * 危险工具执行前问不问：
 *   ask  —— 每一步都确认
 *   auto —— 写文件 / Chrome 操作自动放行，命令行和 Claude Code 仍然确认
 *   all  —— 全部放行，一句不问
 */
export type ApprovalMode = 'ask' | 'auto' | 'all';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** 随消息一起发出去的附件 */
export interface Attachment {
  id: string;
  kind: 'text' | 'image';
  name: string;
  mime: string;
  size: number;
  /** kind === 'text' 时的正文 */
  text?: string;
  /** kind === 'image' 时的 data: URL */
  dataUrl?: string;
}

/** 模型要求调用的一个工具 */
export interface ToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串参数（流式时是逐段拼起来的） */
  arguments: string;
}

export type StepStatus = 'running' | 'ok' | 'error' | 'denied';

/** 一次工具执行的记录，用来在 UI 上画「步骤轨迹」 */
export interface ToolStep {
  id: string;
  callId: string;
  name: string;
  /** 解析后的参数，解析失败就放原文 */
  args: unknown;
  status: StepStatus;
  /** 给人看的一句话，例如「搜索：SenseNova 定价」 */
  summary: string;
  /** 工具返回的正文（回灌给模型的那份） */
  output?: string;
  error?: string;
  startedAt: number;
  elapsedMs?: number;
  /** 这一步产出的引用来源 */
  sources?: SourceRef[];
  /** 这一步写出/改动的文件路径 */
  filePath?: string;
}

/** 一条可点开的来源（搜索结果 / 抓取的网页 / 本地文件） */
export interface SourceRef {
  /** 在答案里的编号，从 1 开始 */
  n: number;
  title: string;
  url?: string;
  /** 本地文件路径等非 URL 来源 */
  path?: string;
  snippet?: string;
  favicon?: string;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** 提示词里命中上下文缓存的 token 数（各家字段名不同，已归一化） */
  cached_tokens?: number;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  reasoning?: string;
  createdAt: number;
  pending?: boolean;
  error?: string;
  /** 结构化的失败信息：怎么回事 + 怎么办，用来渲染可操作的错误卡片 */
  errorInfo?: ErrorInfo;
  /** 生成过程中的临时提示（限流重试倒计时之类），成功后清掉 */
  notice?: string;
  usage?: Usage;
  model?: string;
  elapsedMs?: number;

  /* ---- Agent 相关 ---- */
  /** 这一轮回答过程中执行的工具步骤（仅 assistant） */
  steps?: ToolStep[];
  /** 汇总后的来源列表（仅 assistant） */
  sources?: SourceRef[];
  /** 这一轮产出的文件和可预览代码块（仅 assistant） */
  artifacts?: Artifact[];
  /** 模型请求的工具调用，回灌时要原样带上（仅 assistant） */
  toolCalls?: ToolCall[];
  /** role === 'tool' 时对应的调用 id */
  toolCallId?: string;
  /** role === 'tool' 时的工具名 */
  toolName?: string;
  /** 用户消息随附的文件 / 图片 */
  attachments?: Attachment[];
  /** 这条用户消息唤起了哪些技能，只用于展示 */
  skillNames?: string[];
}

export interface Conversation {
  id: string;
  title: string;
  /** 钉在侧栏顶部 */
  pinned?: boolean;
  /** 从哪个会话分叉出来的，只用来显示 */
  forkedFrom?: string;
  /** 属于哪个项目；null = 不在任何项目里 */
  projectId?: string | null;
  /** 由哪个定时任务创建的 */
  taskId?: string;
  messages: ChatMessage[];
  config: GenerationConfig;
  keyProfileId: string | null;
  createdAt: number;
  updatedAt: number;
}

/* ---------------- 工具侧配置 ---------------- */

export type SearchProvider = 'tavily' | 'brave' | 'searxng';

export interface ToolConfig {
  /** 文件 / 命令类工具只允许在这些目录下动手 */
  workspaceRoots: string[];
  searchProvider: SearchProvider;
  /** 自建 SearXNG 的地址 */
  searxngUrl: string;
  /** Chrome 远程调试端口（用 --remote-debugging-port 启动的那个） */
  chromePort: number;
  /** claude CLI 可执行文件，留空就用 PATH 里的 `claude` */
  claudeBin: string;
  /** 透传给 claude 的额外命令行参数，空格分隔。例如 --permission-mode acceptEdits */
  claudeExtraArgs: string;
  /** 给 Claude Code 子进程的超时，毫秒 */
  claudeTimeoutMs: number;
  /** 单个工具调用超时 */
  toolTimeoutMs: number;
}

/** 手机遥控桌面端的配置 */
export interface RemoteConfig {
  enabled: boolean;
  /** 桌面端地址，例如 http://192.168.1.10:8719 */
  url: string;
  /** 配对令牌 */
  token: string;
}

export interface AppSettings {
  keyProfiles: KeyProfile[];
  activeKeyProfileId: string | null;
  customModels: Record<string, ModelInfo[]>;
  cachedModels: Record<string, ModelInfo[]>;
  defaultConfig: GenerationConfig;
  theme: 'system' | 'light' | 'dark';
  sendKey: 'enter' | 'mod-enter';
  fontScale: number;
  showReasoningByDefault: boolean;
  requestTimeoutMs: number;
  tools: ToolConfig;
  remote: RemoteConfig;
  /** 思考强度的跨厂商映射表 */
  effortMappings: EffortMapping[];
  /** 模型健康度：哪些 ID 在这份凭据下是坏的，默认不进模型列表 */
  modelHealth: ModelHealthMap;
  /** 请求失败后自动重试的次数上限（限流和 5xx 才重试），0 = 关掉 */
  autoRetry: number;
}

/* ---------------- 传输层协议 ---------------- */

export interface ChatStreamHandlers {
  onContent(delta: string): void;
  onReasoning(delta: string): void;
  onToolCalls(calls: ToolCall[]): void;
  onUsage(usage: Usage): void;
  onDone(): void;
  /** status 是上游的 HTTP 状态码，拿不到时为 undefined（网络层直接挂了） */
  onError(message: string, status?: number): void;
}

export interface ChatRequestInit {
  requestId: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  stream: boolean;
  timeoutMs: number;
}

export interface ToolResult {
  ok: boolean;
  /** 回灌给模型的正文 */
  content: string;
  /** 给 UI 用的一句话摘要 */
  summary?: string;
  sources?: Omit<SourceRef, 'n'>[];
  error?: string;
  /** 这次调用产出/改动了哪个文件，右侧产物面板靠它收集 */
  filePath?: string;
}

/** 一次回答产出的东西：写出去的文件，或答案里可以直接跑的代码块 */
export interface Artifact {
  id: string;
  kind: 'file' | 'inline';
  /** 文件名或代码块标题 */
  name: string;
  /** kind==='file' 时的绝对路径 */
  path?: string;
  /** html / markdown / svg / code / other */
  type: string;
  /** kind==='inline' 时的正文 */
  text?: string;
  createdAt: number;
}

/** 工具执行时传给原生层的上下文（不含明文密钥，密钥由原生层自己从安全存储取） */
export interface ToolContext {
  workspaceRoots: string[];
  searchProvider: SearchProvider;
  searxngUrl: string;
  chromePort: number;
  claudeBin: string;
  claudeExtraArgs: string;
  claudeTimeoutMs: number;
  toolTimeoutMs: number;
  /** 当前对话属于哪个项目 —— 项目记忆/文档类工具靠它定位 */
  projectId: string | null;
}

export interface Transport {
  kind: 'electron' | 'capacitor' | 'web';
  chat(init: ChatRequestInit, handlers: ChatStreamHandlers): Promise<void>;
  abort(requestId: string): Promise<void>;
  getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown>;
  /** 执行一个工具。桌面端走 IPC，手机端走遥控 HTTP */
  callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
  /** 这个平台能不能本地执行工具（手机端未配对时为 false） */
  canRunTools(): boolean;
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string): Promise<void>;
  secretGet(id: string): Promise<string | null>;
  secretSet(id: string, value: string): Promise<void>;
  secretDelete(id: string): Promise<void>;
}

/* ---------------- 错误分类与模型健康度 ---------------- */

export type ErrorKind =
  | 'auth'            // key 不对 / 没权限
  | 'rate_limit'      // tpm / rpm / 并发打满
  | 'quota'           // 余额或配额用尽
  | 'model_missing'   // 这个 ID 在上游不存在
  | 'model_broken'    // 上游 5xx：那条路由自己坏了
  | 'bad_param'       // 400：某个下发的字段这个模型不认
  | 'context_too_long'
  | 'multimodal'      // 给纯文本模型发了图
  | 'tools_unsupported'
  | 'network'
  | 'timeout'
  | 'unknown';

export interface ErrorInfo {
  kind: ErrorKind;
  /** 一句话说清楚发生了什么，给人看的，不是给日志看的 */
  title: string;
  /** 上游原文，折叠展示 */
  detail: string;
  /** 怎么办，按「最可能有用」排序 */
  fixes: string[];
  /** 等一会儿重试有没有意义 */
  retryable: boolean;
  /** 上游明确说了等多久，或我们的退避建议 */
  retryAfterMs?: number;
  /** 这个锅该不该算在当前模型头上（算了就进「有问题的模型」区） */
  blameModel: boolean;
  status?: number;
}

export type ModelHealthStatus = 'ok' | 'broken' | 'missing' | 'ratelimited' | 'timeout' | 'unknown';

export interface ModelHealth {
  status: ModelHealthStatus;
  /** 上游 HTTP 状态码 */
  code?: number;
  /** 简短原因，鼠标悬停时显示 */
  reason?: string;
  /** 最后一次判定的时间 */
  at: number;
  /** 连续失败次数；成功一次就清零 */
  fails: number;
  /** 用户手动压下的：不管探测结果如何都不在默认列表里显示 */
  muted?: boolean;
}

/** profileId → modelId → 健康度 */
export type ModelHealthMap = Record<string, Record<string, ModelHealth>>;
