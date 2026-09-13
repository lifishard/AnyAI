import type { EffortLevel, EffortMapping } from './lib/effort';
import type { LearnedLimit } from './lib/limits';

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
  /** Endpoint-qualified keys prevent settings following a renamed gateway accidentally. */
  routeProfiles?: Record<string, RouteOverrides>;
  /** Explicitly link credentials that share an upstream account/project quota. */
  quotaGroup?: string;
}

export interface RouteOverrides {
  contextWindow?: number;
  maxOutput?: number;
  rpm?: number;
  tpm?: number;
  itpm?: number;
  otpm?: number;
  outputField?: 'max_tokens' | 'max_completion_tokens' | 'none';
  cachedInputCounts?: boolean;
  effortStyle?: 'mapping' | 'none' | 'reasoning_effort' | 'thinking_object' | 'thinking_budget';
  effortValues?: Partial<Record<EffortLevel, string>>;
}

export interface ContextSnapshot {
  inputTokens: number;
  outputReserve: number;
  contextWindow?: number;
  workingBudget: number;
  source: string;
  estimated: boolean;
  components: { system: number; tools: number; conversation: number; attachments: number; toolResults: number };
  compressionCount: number;
  quota?: { rpm?: number; tpm?: number; itpm?: number; otpm?: number };
  lastReduction?: number;
  phase?: 'preparing' | 'compacting' | 'waiting' | 'running';
  routeKey: string;
  at: number;
}

export interface Milestone {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  acceptance?: string;
  evidence: string[];
  note?: string;
  updatedAt: number;
}

export interface AcceptanceCheck {
  kind: 'file_exists' | 'json' | 'ics' | 'answer_contains' | 'review';
  path?: string;
  contains?: string[];
  requiredKeys?: string[];
  count?: number;
}
export interface RequirementVersion {
  revision: number;
  title: string;
  sourceId: string;
  sourceQuote: string;
  check: AcceptanceCheck;
  at: number;
}
export interface RequirementVerification {
  revision: number;
  status: 'passed' | 'failed' | 'unverifiable';
  method: 'program' | 'model';
  detail: string;
  evidence: string[];
  at: number;
}
export interface DeliveryRequirement extends RequirementVersion {
  id: string;
  milestoneId?: string;
  history: RequirementVersion[];
  verification?: RequirementVerification;
  verificationHistory?: RequirementVerification[];
}
export interface DeliveryReport {
  requirements: DeliveryRequirement[];
  coverage: 'model_defined' | 'not_defined';
  status: 'unchecked' | 'passed' | 'failed' | 'unverifiable';
  at: number;
}
export interface RecoveryInfo {
  kind: 'user' | 'quota' | 'budget' | 'input' | 'permission' | 'uncertain' | 'verification' | 'connection' | 'other';
  reason: string;
  next: string;
  target?: string;
  completed: string[];
  remaining: string[];
  outputPaths: string[];
  canAddInput: boolean;
}

export interface ContextCompaction {
  version: 1;
  id: string;
  /** Original messages before this boundary remain in working, but leave the wire view. */
  throughId: string;
  throughIndex: number;
  facts: { text: string; sources: string[] }[];
  decisions: { text: string; sources: string[] }[];
  unresolved: { text: string; sources: string[] }[];
  nextSteps: string[];
  beforeTokens: number;
  afterTokens: number;
  createdAt: number;
  requestId?: string;
  strategy?: 'semantic';
}

export interface RunRequestStat {
  route: string;
  effort: string;
  purpose: string;
  estimatedInput: number;
  actualInput?: number;
  output?: number;
  reservedOutput: number;
  at: number;
  elapsedMs?: number;
  outcome?: 'pending' | 'accepted' | 'failed' | 'rejected' | 'cancelled';
  detail?: string;
  dispatchedAt?: number;
  httpStatus?: number;
  failureKind?: ErrorInfo['kind'];
}

export interface ModelInfo {
  id: string;
  label?: string;
  ownedBy?: string;
  /** true = 用户手动添加的，不是从 /models 拉到的 */
  custom?: boolean;
  contextWindow?: number;
  maxOutput?: number;
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
  /** 客户端工作预算；0 表示该项不限制。与服务端额度分别记录。 */
  runtime?: {
    contextTokens: number;
    tpm: number;
    rpm: number;
    maxTokens: number;
    maxMinutes: number;
    recoveryMinutes: number;
    contextMode?: 'auto' | 'manual';
    semanticCompression?: boolean;
    milestones?: boolean;
  };
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
  path?: string;
}

/** 原文快照在来源消息被编辑后仍可阅读；id 用于跳回来源。 */
export interface MessageQuote {
  id: string;
  messageId: string;
  role: Role;
  text: string;
}

/** Personal annotation on a selected passage; not included in model requests. */
export interface MessageAnnotation {
  id: string;
  quote: MessageQuote;
  text: string;
  createdAt: number;
}

export interface FileRecord {
  path: string;
  name: string;
  size: number;
  direction: 'input' | 'output';
  verifiedAt: number;
  modifiedAt?: number;
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
  files?: FileRecord[];
  resultRef?: string;
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
  reasoning_tokens?: number;
}

export interface ChatMessage {
  contextKind?: 'handoff';
  handoff?: HandoffInfo;
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
  /**
   * 上游给的 finish_reason。不是 stop 一类的正常值时界面会标出来 ——
   * 「怎么答到一半就没了」这个问题，答案就在这个字段里。
   */
  stopReason?: string;
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
  /**
   * 断线保护：这一轮跑到一半的现场。
   *
   * agent 循环内部那个 working 数组（含全部工具往返）以前只活在内存里 ——
   * 一旦请求失败、用户按停止、或者应用被关掉，八步的成果就随之消失，
   * 只能从头再问一遍。存下来之后，「继续」就只是从这里接着跑。
   *
   * 只在**没跑完**的 assistant 消息上有值；正常收尾会清掉。
   */
  runState?: RunState;
  quotes?: MessageQuote[];
  annotations?: MessageAnnotation[];
  quoteOnly?: boolean;
  /** 本地生成的进度说明，不是模型生成的完成声明。 */
  progress?: string;
  milestones?: Milestone[];
  contextSnapshot?: ContextSnapshot;
  delivery?: DeliveryReport;
  taskId?: string;
  supplementalInputs?: {id:string;content:string;createdAt:number}[];
}

/** 中断现场。够用来无缝续跑，也够小到能塞进 localStorage */
export interface RunState {
  contextArchive?: ChatMessage[];
  contextArchiveSteps?: ToolStep[];
  handoff?: HandoffInfo;
  lastModel?: string;
  /** agent 内部的完整消息序列，含工具往返 */
  working: ChatMessage[];
  /** 停在第几轮 */
  round: number;
  /** 为什么停：出错、用户按停、应用关了 */
  stoppedBy: 'error' | 'user' | 'unknown';
  /** 已经攒下的来源，续跑时编号要接着排 */
  sources?: SourceRef[];
  at: number;
  version?: 2;
  runId?: string;
  phase?: 'request' | 'tools' | 'final';
  status?: 'running' | 'waiting' | 'paused' | 'completed';
  pendingCalls?: ToolCall[];
  toolCursor?: number;
  steps?: ToolStep[];
  content?: string;
  reasoning?: string;
  extraSystem?: string;
  usage?: Usage;
  spentTokens?: number;
  startedAt?: number;
  nextRetryAt?: number;
  reason?: string;
  errorInfo?: ErrorInfo;
  failedRequestId?: string;
  /** 重启后恢复待核实操作时，由用户选择核实后跳过或明确允许重试。 */
  uncertainCallId?: string;
  milestones?: Milestone[];
  compactions?: ContextCompaction[];
  contextSnapshot?: ContextSnapshot;
  runtimeVersion?: string;
  requestStats?: RunRequestStat[];
  requirements?: DeliveryRequirement[];
  requirementSourceIds?: string[];
  delivery?: DeliveryReport;
  recovery?: RecoveryInfo;
  attemptId?: string;
  attemptStartedAt?: number;
  isResumedAttempt?: boolean;
  supplementalInputs?: {id:string;content:string;createdAt:number}[];
  replanPending?: boolean;
  pendingInputMessages?: ChatMessage[];
  waitKind?: 'quota' | 'approval';
}

export interface HandoffInfo {
  fromModel?: string;
  toModel: string;
  mode: 'resume' | 'followup';
  at: number;
  status: 'prepared' | 'sent';
  checkpoints: number;
  sourceMessages: number;
  savedSteps: number;
  summaryAvailable: boolean;
}

export interface RunRecord {
  id: string;
  conversationId: string;
  answerId: string;
  question: ChatMessage;
  config: GenerationConfig;
  keyProfileId: string;
  projectId?: string | null;
  title: string;
  state: RunState;
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
  clients?: { codexBin:string };
  collaborationView?: { visible:boolean; projectId?:string };
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
  /** 技能与本地文件夹的双向同步 */
  skillSync: SkillSyncConfig;
  /** 配置结构版本，用来跑一次性迁移。当前是 2 */
  schemaVersion?: number;
  /** 记住的授权，没有就是从来没记过（或者已经被撤销 / 过期清掉了） */
  rememberedGrants?: RememberedGrants;
  /**
   * 从上游报错里学到的窗口大小，键包含 profileId、规范化 base URL 与 model。
   * 内置对照表永远会缺你正在用的那条路由，所以这里只记录明确上游证据。
   */
  modelLimits?: Record<string, LearnedLimit>;
}

export interface SkillSyncConfig {
  /** 空 = 没配，功能不启用。默认建议 ~/.claude/skills */
  dir: string;
  /** 启动时自动同步一次 */
  auto: boolean;
}

/* ---------------- 传输层协议 ---------------- */

/** 这一轮为什么结束 —— 上游的 finish_reason 归一化之后的样子 */
export interface StopInfo {
  /** 上游原文，没给就是 null（通常意味着流被掐了） */
  reason: string | null;
  /** 收到分片但没等到函数名、因而被丢掉的工具调用个数 */
  droppedCalls: number;
}

export interface ChatStreamHandlers {
  onContent(delta: string): void;
  onReasoning(delta: string): void;
  onToolCalls(calls: ToolCall[]): void;
  onUsage(usage: Usage): void;
  /** 可选：不关心为什么停的调用方可以不实现 */
  onStop?(info: StopInfo): void;
  /**
   * 因为避让限流而要等一会儿。放在 handlers 里而不是 init 里 ——
   * init 要过 IPC，函数过不去。
   */
  onPaceWait?(ms: number): void;
  onDispatch?(): void;
  onResponse?(status: number, headers: Record<string, string>): void;
  onDone(): void;
  /** status 是上游的 HTTP 状态码，拿不到时为 undefined（网络层直接挂了） */
  onError(message: string, status?: number): void;
}

/**
 * @cloneable
 *
 * ⚠ 这个对象会被原样送过 Electron 的 IPC（structuredClone）。
 * **只能放能被结构化克隆的东西** —— 放一个函数进来，整条请求会在 0.0 秒
 * 直接失败并报 "An object could not be cloned."，而且一个字节都没发出去。
 * 回调一律放 ChatStreamHandlers，那个对象留在渲染进程里，不过 IPC。
 */
export interface ChatRequestInit {
  requestId: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  stream: boolean;
  timeoutMs: number;
  /**
   * 限流节奏按这个键分组，通常是凭据 id —— 配额是按 key 算的，不是按地址。
   * 不传就退回用地址分组，总比不分组强。
   */
  paceKey?: string;
  /**
   * 这一次至少隔这么久再发，即使当前节奏更快。
   * 排查用它把自己放慢到「不可能触发限流」的程度 —— 这样收到的限流才是证据。
   */
  paceMinMs?: number;
  /** 这次请求大约要花多少 token —— TPM 令牌桶按它扣额度 */
  paceTokens?: number;
  /** 这条路由已知的 TPM 上限；未知就不启用令牌桶 */
  paceTpm?: number;
  runId?: string;
  round?: number;
  attempt?: number;
  purpose?: 'agent' | 'final' | 'probe' | 'salvage' | 'compaction';
  paceInput?: number;
  paceOutput?: number;
  paceItpm?: number;
  paceOtpm?: number;
  cachedInputCounts?: boolean;
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
  /**
   * 工具返回的图片（截屏）。工具消息本身塞不进图片（多数网关只认文本），
   * 所以 agent 会在工具结果之后补一条带图的 user 消息。
   */
  imageDataUrl?: string;
  files?: FileRecord[];
  resultRef?: string;
  /** 原生执行日志显示操作已开始但没有可靠完成记录。 */
  uncertain?: boolean;
  operationStatus?: 'not_started' | 'completed' | 'uncertain';
}

/**
 * 会话级的额外授权。
 *
 * 刻意**不落盘**：关掉应用就没了，下次要用再申请一次。
 * 一个能执行命令、能控屏幕的权限如果被永久记住，用户迟早会忘了自己给过。
 */
export interface SessionGrants {
  /** 临时放行的目录，并进 workspaceRoots */
  extraRoots: string[];
  /** 允许 run_command 提权（执行时系统仍会弹 UAC） */
  admin: boolean;
  /** 允许截屏和控制鼠标键盘 */
  screen: boolean;
}

/**
 * 跨重启记住的授权。只记目录和屏幕，**不记提权** —— 见 GrantDialog 的说明。
 * 带过期时间：没有期限的授权就是没人管的授权。
 */
export interface RememberedGrants {
  extraRoots: string[];
  screen: boolean;
  /** Unix 毫秒。到点之后整份作废，重新申请 */
  expiresAt: number;
}

export interface AccessRequest {
  scope: 'path' | 'admin' | 'screen';
  target?: string;
  reason: string;
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
  size?: number;
  verifiedAt?: number;
  direction?: 'input' | 'output';
}

/** 工具执行时传给原生层的上下文（不含明文密钥，密钥由原生层自己从安全存储取） */
export interface ToolContext {
  teamExecution?: { projectId:string; runId:string; attemptId:string; memberId:string; fileSessionId?:string };
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
  /** 本次会话临时授予的权限。原生层据此决定放不放行提权和屏幕控制 */
  grants: SessionGrants;
  execution?: { runId: string; callId: string; retryUncertain?: boolean };
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
