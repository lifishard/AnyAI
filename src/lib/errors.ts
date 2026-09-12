import type { ErrorInfo, ErrorKind } from '../types';

/* ------------------------------------------------------------------ *
 * 错误翻译层
 *
 * 上游报错是给写后端的人看的：`ModelAccountTpmRateLimitExceeded`、
 * `DEVIN_AGENTIC_HOME must be an absolute path inside the bridge sandbox`。
 * 这些照搬到界面上，用户唯一能得到的信息是「坏了」。
 *
 * 这里做三件事：
 *   1. 判断这是哪一类问题（谁的锅：key / 额度 / 这个模型 / 这次请求的参数 / 网络）
 *   2. 给出「现在该做什么」，按最可能有用的顺序排，且指到具体的界面位置
 *   3. 标出重试有没有意义，以及这个锅该不该算在当前模型头上
 *
 * 判据只用两样东西：HTTP 状态码 + 报错原文。状态码优先，原文用来细分。
 * ------------------------------------------------------------------ */

export interface ClassifyCtx {
  /** 当前模型 ID，用来写进建议里 */
  model?: string;
  /** 当前凭据名 */
  profileName?: string;
  /** 这次请求带了思考强度字段吗 —— 决定要不要建议去动映射表 */
  sentEffort?: boolean;
  /** 这次请求下发了工具吗 */
  sentTools?: boolean;
  /** 这次请求带了图片吗 */
  sentImage?: boolean;
}

const has = (s: string, re: RegExp) => re.test(s);

/**
 * 上游偶尔会在文案里写明等多久：
 *   "please try again in 1.5s" / "retry after 20 seconds" / "重试间隔 3 秒"
 */
function parseRetryAfter(msg: string): number | undefined {
  const m =
    msg.match(/(?:try again|retry(?:\s+after)?)\D{0,12}?([\d.]+)\s*(ms|s|sec|seconds|m|min)/i) ??
    msg.match(/([\d.]+)\s*(ms|s|sec|seconds|m|min)\D{0,12}?(?:后重试|再试)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2].toLowerCase();
  const ms = unit === 'ms' ? n : unit.startsWith('m') && unit !== 'ms' ? n * 60_000 : n * 1000;
  // 上游说要等超过两分钟的，那不是「稍等重试」能解决的，交给用户决定
  return ms > 0 && ms <= 120_000 ? ms : undefined;
}

/**
 * 服务端内部错误里，哪些是「这条路由自己坏了，等多久都一样」，
 * 哪些是「网关抖了一下，重试可能就好」。
 *
 * 判据：报错里出现了服务端实现细节（环境变量、堆栈、沙箱、空指针），
 * 说明请求已经打到后端并在那里炸了 —— 这是确定性的，重试只是再炸一次。
 */
const DETERMINISTIC_5XX =
  /must be an absolute path|environment variable|env var|[A-Z][A-Z0-9_]{6,}\s+must|sandbox|panic|nil pointer|traceback|stack trace|NullPointer|no such file or directory|not implemented|unsupported operation/i;

const TRANSIENT_5XX =
  /bad gateway|gateway time|service unavailable|temporarily|overload|try again|upstream|connection reset|EOF/i;

export function classifyError(
  rawMessage: string,
  status: number | undefined,
  ctx: ClassifyCtx = {},
): ErrorInfo {
  const msg = (rawMessage || '').trim();
  const lower = msg.toLowerCase();
  const model = ctx.model || '当前模型';

  const base = {
    detail: msg || '（上游没有给出说明）',
    status,
    retryable: false,
    blameModel: false,
  };

  const mk = (
    kind: ErrorKind,
    title: string,
    fixes: string[],
    extra: Partial<ErrorInfo> = {},
  ): ErrorInfo => ({ ...base, kind, title, fixes, ...extra });

  /* ---------------- 网络层：请求根本没出去 ---------------- */

  if (status === undefined) {
    if (has(lower, /abort|cancel|用户取消/)) {
      return mk('unknown', '请求被取消了', []);
    }
    if (has(lower, /timeout|timed out|超时|ETIMEDOUT/i)) {
      return mk(
        'timeout',
        '等了太久没等到响应',
        [
          '思考强度高的模型首字很慢，把设置 → 外观旁边的「请求超时」调大（默认 180 秒）',
          '关掉流式响应会更容易超时，长回答建议开着流式',
          '换一个更快的模型试试，确认是这条路由慢还是全都慢',
        ],
        { retryable: true },
      );
    }
    if (has(lower, /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket|dns|TLS|certificate/i)) {
      return mk(
        'network',
        '连不上这个端点',
        [
          '检查设置 → API 凭据里的 Base URL 有没有写错（要带 /v1 这类路径前缀）',
          '如果是自建网关，确认它现在是开着的，并且这台机器能访问到',
          '公司网络 / 代理可能挡了出网，换个网络试一次',
        ],
        { retryable: true },
      );
    }
    return mk('unknown', '请求失败', ['原文在下面，如果反复出现可以带着它开 issue']);
  }

  /* ---------------- 401 / 403：凭据 ---------------- */

  if (status === 401 || status === 403 || has(lower, /invalid api key|unauthorized|authentication|无效的?密钥|鉴权/)) {
    return mk('auth', '这份凭据没通过验证', [
      `到设置 → API 凭据里重新粘一次 ${ctx.profileName ? `「${ctx.profileName}」` : '当前凭据'} 的 Key，注意首尾空格`,
      'Base URL 和 Key 要配套：拿 A 家的 key 去打 B 家的地址一定是 401',
      '点一下「测试连接」，能拉到模型列表才说明凭据是通的',
    ]);
  }

  /* ---------------- 402 / 余额 ---------------- */

  if (status === 402 || has(lower, /insufficient|balance|欠费|余额|out of credit|exceeded your current quota/)) {
    return mk('quota', '这个账号的额度用完了', [
      '去上游控制台看一下余额 / 免费额度是不是到期了',
      '换一份别的凭据：输入框左下角可以切，不影响别的会话',
    ]);
  }

  /* ---------------- 429：限流 ---------------- */

  if (status === 429 || has(lower, /rate.?limit|tpm|rpm|too many requests|请求过于频繁|并发/)) {
    const wait = parseRetryAfter(msg);
    return mk(
      'rate_limit',
      '被上游限流了（不是出错，是发太快）',
      [
        '等几秒重发就行 —— 应用已经会自动退避重试，这条说明重试次数也用完了',
        '工具轮次开得高时一轮要打好几次接口，把「工具轮次上限」调低能少撞几次',
        '同一个 key 在别处也在跑的话，额度是共享的',
        '换一份凭据或换一条不那么热门的路由',
      ],
      { retryable: true, retryAfterMs: wait },
    );
  }

  /* ---------------- 404 / 模型不存在 ---------------- */

  if (
    status === 404 ||
    has(lower, /model.{0,12}(not found|not exist|does not exist|unavailable)|no such model|unknown model|模型不存在/)
  ) {
    return mk(
      'model_missing',
      `上游说没有 ${model} 这个模型`,
      [
        '点模型选择器里的 ↻ 重新拉一次列表，手动加的 ID 可能已经下线了',
        '确认 Base URL 对：同一个 ID 在不同网关下的写法可能不一样（有的要带 owner/ 前缀）',
        '在选择器里搜一个相近的名字换上',
      ],
      { blameModel: true },
    );
  }

  /* ---------------- 5xx：上游自己坏了 ---------------- */

  if (status >= 500) {
    const deterministic = has(msg, DETERMINISTIC_5XX) && !has(msg, TRANSIENT_5XX);
    if (deterministic) {
      return mk(
        'model_broken',
        `${model} 这条路由在服务端是坏的`,
        [
          '换一个模型 —— 这个错误来自上游服务器内部（环境变量、沙箱路径之类），客户端改什么都没用',
          '在模型选择器里点「批量体检」，一次性筛出这个网关上所有能用/不能用的模型',
          '如果整个网关的模型全都这样，那是网关或你的 key 的问题，去上游控制台看看',
        ],
        { blameModel: true },
      );
    }
    return mk(
      'model_broken',
      `上游返回了 ${status}，多半是抖了一下`,
      [
        '稍等重试 —— 网关类 5xx 经常是瞬时的',
        '连着几次都这样就换个模型，或者去上游状态页看看',
      ],
      { retryable: true, blameModel: false },
    );
  }

  /* ---------------- 400：请求体里有它不认的东西 ---------------- */

  if (status === 400 || status === 422) {
    if (has(lower, /image|vision|multimodal|image_url|图片|多模态/)) {
      return mk('multimodal', `${model} 不认识图片`, [
        '换一个多模态模型再发这张图（名字里常带 vl / vision / flash-lite 之类）',
        '或者把图片从输入框里去掉，只发文字',
      ], { blameModel: true });
    }
    if (
      has(lower, /reasoning|thinking|budget|effort/) ||
      (ctx.sentEffort && has(lower, /unsupported|unknown|invalid|not allowed|unrecognized/))
    ) {
      return mk('bad_param', `${model} 不接受我们下发的思考强度字段`, [
        '把输入框右下角的思考强度调成「不下发」，这一条最快',
        '如果模型名里本来就带 high / thinking 这类后缀，强度已经烤在路由里了，再叠字段就会 400 —— 去设置 → 思考强度确认「模型名自带强度」那条规则排在第一位',
        '这个厂商的映射写错了的话，在同一页改那一行就行，不用改代码',
      ]);
    }
    if (has(lower, /context length|maximum context|too long|exceeds?.{0,20}token|上下文/)) {
      return mk('context_too_long', '上下文超出这个模型的窗口了', [
        '在右侧配置面板把「携带历史条数」限制一下（注意这会打断上下文缓存）',
        '开一条新对话，或者用 ⑂ 从某一步分叉，把前面的包袱甩掉',
        '换一个窗口更大的模型',
      ]);
    }
    if (ctx.sentTools && has(lower, /tool|function|tools\b/)) {
      return mk('tools_unsupported', `${model} 不支持工具调用`, [
        '在右侧配置面板关掉「给模型下发工具」，纯聊天就能用',
        '要用工具就换一个支持 function calling 的模型',
      ], { blameModel: true });
    }
    return mk('bad_param', '上游说这个请求体它不认', [
      '右侧配置面板里把刚勾上的生成参数取消掉试试 —— 没勾的参数不会下发，逐个排除最快',
      '思考强度调成「不下发」再试一次',
      '配置面板的「预览请求体」能看到实际发出去的内容，对着上游文档比一下',
    ]);
  }

  /* ---------------- 兜底 ---------------- */

  return mk('unknown', `请求失败（HTTP ${status}）`, [
    '原文在下面。反复出现的话，带上模型 ID 和请求体预览开 issue',
  ]);
}

/** 第 n 次重试要等多久：指数退避 + 抖动，上游指定了就听上游的 */
export function backoffMs(attempt: number, info: { retryAfterMs?: number }): number {
  if (info.retryAfterMs) return Math.min(info.retryAfterMs + 250, 30_000);
  const base = Math.min(1500 * 2 ** (attempt - 1), 15_000);
  return Math.round(base * (0.8 + Math.random() * 0.4)); // ±20% 抖动，避免多个请求同时回来
}
