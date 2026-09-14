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
  // 保留上游等待时间，是否超过自动恢复预算由任务执行器决定。
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
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

/**
 * 网关背后要起一个命令行工具，而那个工具在网关那台机器上根本没装。
 *
 * 这类报错长这样：
 *   Auggie CLI exited with code 1: 'auggie' is not recognized as an internal or external command
 *   spawn claude ENOENT
 *   /bin/sh: 1: codex: not found
 *
 * 判成「瞬时抖动、稍等重试」是最糟的误判 —— 用户会反复重发，而缺的那个
 * 可执行文件不会因为多等一会儿就长出来。
 */
const MISSING_BINARY =
  /is not recognized as an internal or external command|command not found|: not found|\bENOENT\b|exited with code \d|no such binary|executable file not found/i;

/** 从报错里把那个缺失的命令名抠出来，好在建议里直接点名 */
function guessMissingBinary(msg: string): string | null {
  const m =
    msg.match(/'([\w.-]+)' is not recognized/i) ??
    msg.match(/spawn\s+([\w.-]+)\s+ENOENT/i) ??
    msg.match(/([\w.-]+):\s*(?:command )?not found/i) ??
    msg.match(/^([\w.-]+)\s+CLI exited/i);
  return m ? m[1] : null;
}

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

  // OpenRouter also uses 404 when a valid model has no eligible endpoints.
  // Match the routing reason before generic HTTP handling (including SSE errors).
  if (has(lower, /data policy|guardrail restrictions|zdr violation|zdr-violation|zero data retention/)) {
    return mk('routing_policy', '账号隐私或路由限制排除了可用端点', [
      '到 OpenRouter 的 https://openrouter.ai/settings/privacy 核对 ZDR（零数据留存）和免费端点设置',
      '只有接受对应端点的数据政策时才调整设置；也可以保留当前隐私要求，选择符合要求的模型',
      '这不是模型 ID 或 Base URL 写错；应用不会自动放宽账号隐私限制',
    ]);
  }
  if (has(lower, /no endpoints?.*(image|vision)|support image input/)) {
    return mk('multimodal', '当前模型没有支持图片输入的可用端点', [
      '选择支持图片输入的模型，或在新对话中只发送文字',
      '历史消息中的图片也会随上下文发送，仅删除本轮附件可能仍会被拒绝',
    ]);
  }
  if (has(lower, /no endpoints?.*(tool|function)|no providers?.*support.*tool/)) {
    return mk('tools_unsupported', '当前模型没有支持工具调用的可用端点', [
      '选择支持工具调用的模型；免费路由会按本次请求需要的能力筛选端点',
      '纯文字聊天也可能带有询问工具，请使用支持工具的模型继续当前任务',
    ]);
  }
  if (has(lower, /no (available )?endpoints? (found|available)|0 endpoints/)) {
    return mk('route_unavailable', '当前请求没有可用的上游端点', [
      '查看下方上游原文，核对模型支持的能力、路由条件和账号设置',
      '刷新模型列表后选择另一个可用模型；免费端点的供应情况可能变化',
    ]);
  }

  // SSE 中的错误可能没有 HTTP 错误状态，仍应正确识别限流。
  if (/STREAM_EARLY_EOF|stream ended before producing/i.test(msg)) {
    return mk('model_broken','网关连接已建立，但上游没有返回有效内容',[
      '切换具体的可用路由，或在网关中检查当前供应商、账号状态与原始错误',
      '可以关闭流式做一次对照诊断；这类错误不代表本机网关没有启动',
      '已有任务现场会保留，避免连续点击重新发送',
    ]);
  }
  if (status === undefined && /rate.?limit|tpm|rpm|too many requests|限流/i.test(msg)) {
    return mk('rate_limit', '暂时达到调用额度，等待后继续', [], { retryable: true, retryAfterMs: parseRetryAfter(msg) });
  }
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

  if (status === 404) {
    return mk('route_unavailable', '上游未找到这次请求对应的资源', [
      '查看上游原文，确认是模型、请求路径还是路由条件导致的 404',
      '核对 API 凭据中的 Base URL，并刷新模型列表',
    ]);
  }

  /* ---------------- 5xx：上游自己坏了 ---------------- */

  if (status >= 500) {
    // 先看是不是「网关那台机器上缺可执行文件」—— 这比一般的 5xx 更明确，
    // 也更容易给出有用的建议
    const binary = has(msg, MISSING_BINARY) ? guessMissingBinary(msg) : null;
    if (has(msg, MISSING_BINARY)) {
      return mk(
        'model_broken',
        binary
          ? `这条路由要在网关那台机器上跑 ${binary}，但它没装`
          : '这条路由背后的命令行工具没装',
        [
          `换一个模型 —— 这跟你的请求无关，是${binary ? ` ${binary} ` : '那个'}可执行文件不在网关的 PATH 里`,
          binary
            ? `如果那个网关就跑在你自己电脑上，装好 ${binary} 并确保命令行里直接敲 ${binary} 能跑通，再重启网关`
            : '如果网关是你自己跑的，看它的日志确认缺哪个命令',
          '重试没有意义 —— 缺的可执行文件不会因为多等一会儿就出现',
        ],
        { blameModel: true },
      );
    }

    /*
     * 「流开了，但一个真事件都没吐出来」。
     *
     * 这类报错（STREAM_EARLY_EOF / Stream ended before producing…）信息量很低，
     * 因为网关一旦决定用 SSE 回应，就已经把 200 和响应头发出去了 —— 后面再发现
     * 上游拒绝（余额不够、路由挂了），它没法再改成一个正经的 4xx，只能把流一关。
     *
     * 所以真正有用的建议是**关掉流式重发一次**：非流式下网关能返回完整的 JSON
     * 错误体，那里面通常写着真实原因。实测就是这么查出「余额不足」的。
     */
    if (has(msg, /STREAM_EARLY_EOF|stream ended before|no.{0,12}(sse|event).{0,20}(received|produced)|empty stream/i)) {
      return mk(
        'model_broken',
        '上游开了流，但一个内容都没发过来',
        [
          '**把流式关掉再发一次** —— 非流式下上游能返回完整的错误说明，' +
            '多半会直接告诉你真实原因（余额、配额、路由不可用）。开着流式时它已经没法回一个正经错误码了',
          '这条路由如果是按量计费的，先去上游控制台看一眼余额',
          '换一条能用的路由（比如网关里的 auto）',
        ],
        { retryable: false, blameModel: true },
      );
    }

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
  if (info.retryAfterMs) return Math.max(0, info.retryAfterMs) + 250;
  const base = Math.min(1500 * 2 ** (attempt - 1), 15_000);
  return Math.round(base * (0.8 + Math.random() * 0.4)); // ±20% 抖动，避免多个请求同时回来
}

/* ------------------------------------------------------------------ *
 * 「一轮结束了，但没有工具调用」——  到底是正常答完，还是出事了
 *
 * 之前这里是一句 `if (!roundCalls.length) break;`：答完了、被 max_tokens
 * 砍断、被内容过滤拦下、流在半路断掉、工具调用只传了一半 —— 五种情况在
 * 界面上长得一模一样，都表现为「气泡到这就没了」。用户的原话是
 * 「对话有时候很短莫名其妙地就停了」，说的就是这个。
 *
 * 返回 null 表示这是一次正常收尾，不用打扰人。
 *
 * 有一条刻意的保守规定：**上游没给 finish_reason、但内容不为空时，不报错**。
 * 相当多的网关在流式收尾包里根本不写这个字段，逐个报警只会让每次正常回答
 * 都顶着一张红卡片 —— 那比现在的沉默更糟。只有「一个字都没有」才是确凿的。
 * ------------------------------------------------------------------ */

/** 这些 finish_reason 代表「它说完了」，各家叫法不同 */
const CLEAN_STOP = /^(stop|end_turn|stop_sequence|eos|complete|completed|finished|null|normal)$/i;

export function isCleanStop(reason: string | null): boolean {
  return !reason || CLEAN_STOP.test(reason);
}

export function stopReasonInfo(
  stop: { reason: string | null; droppedCalls: number },
  ctx: { hadContent: boolean; sentTools: boolean; model?: string },
): ErrorInfo | null {
  const r = (stop.reason ?? '').toLowerCase();
  const base = { detail: `finish_reason = ${stop.reason ?? '（上游没给）'}`, blameModel: false };

  if (r === 'length' || r === 'max_tokens' || r === 'max_output_tokens') {
    return {
      ...base,
      kind: 'bad_param',
      title: '答到一半被 max_tokens 截断了',
      retryable: false,
      fixes: [
        '右侧配置面板把 max_tokens 调大，或者干脆取消勾选让上游用它自己的上限',
        '上面这段是**完整收到**的部分，不是全部 —— 直接说「接着写」通常能续上',
        '开了工具的话，截断往往发生在它正要发工具调用的那一刻，所以看起来像「说要干活然后没动静」',
      ],
    };
  }

  if (r === 'content_filter' || r === 'safety' || r === 'blocked') {
    return {
      ...base,
      kind: 'unknown',
      title: '上游的内容过滤把这次回答拦下了',
      retryable: false,
      fixes: ['换个说法重问一次', '换一条别的路由 —— 各家的过滤尺度不一样'],
    };
  }

  // 它说了要调工具，但一个都没解析出来（重试过了还是这样）
  if (r === 'tool_calls' || r === 'function_call' || stop.droppedCalls > 0) {
    return {
      ...base,
      kind: 'tools_unsupported',
      title:
        stop.droppedCalls > 0
          ? `有 ${stop.droppedCalls} 个工具调用只传了一半就断了`
          : '上游说这轮要调工具，但工具调用没传过来',
      retryable: true,
      fixes: [
        '直接重发一次 —— 这种多半是流在工具调用中间被掐断了',
        '右侧配置面板把「流式」关掉再试：非流式是整包返回，不存在传一半',
        '换一条路由。有些网关代理工具调用时会把 tool_calls 字段吃掉',
      ],
    };
  }

  // 一个字都没有，还没有结束原因 —— 这是确凿的空回复
  if (!ctx.hadContent) {
    return {
      ...base,
      kind: 'model_broken',
      title: '上游把流开了，但一个字都没发过来',
      retryable: true,
      fixes: [
        '重发一次',
        '这条路由如果是按量计费的，先去上游控制台看一眼余额',
        '换一条能用的路由试试是不是这个模型自己的问题',
      ],
    };
  }

  return null;
}
