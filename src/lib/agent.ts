import type {
  AccessRequest,
  ChatMessage,
  ErrorInfo,
  GenerationConfig,
  KeyProfile,
  SourceRef,
  ToolCall,
  ToolContext,
  StopInfo,
  ToolResult,
  ToolStep,
  Usage,
} from '../types';
import { buildHeaders, endpoint } from './api';
import { buildRequestBody, type ContentPart, type WireMessage } from './paramSchema';
import { TOOL_BY_NAME, availableTools } from './tools/registry';
import type { EffortMapping } from './effort';
import { backoffMs, classifyError, stopReasonInfo } from './errors';
import { getTransport } from './transport';
import { uid } from './store';
import { composeSystem } from './system';
import { estimateTokens, inputBudget, looksLikeOverflow, parseLimits, type LearnedLimit } from './limits';

export interface AgentEvents {
  onContentDelta(s: string): void;
  onReasoningDelta(s: string): void;
  /** 一步开始 / 状态变化，同一个 step.id 会多次回调，按 id 覆盖即可 */
  onStep(step: ToolStep): void;
  onSources(sources: SourceRef[]): void;
  onUsage(u: Usage): void;
  onRound(round: number, maxRounds: number): void;
  /** 生成期间的临时提示，例如「限流，3 秒后重试」。传空串表示清掉 */
  onNotice(text: string): void;
  /**
   * 这一轮上游给的 finish_reason（null = 上游压根没给）。
   * 正常收尾也会回调，界面自己决定要不要显示 —— 它是「为什么停」的唯一证据，
   * 不该只在出错时才存在。
   */
  onStopReason(reason: string | null): void;
  onDone(): void;
  onError(message: string, info: ErrorInfo): void;
}

export interface RunAgentArgs {
  requestId: string;
  profile: KeyProfile;
  apiKey: string;
  config: GenerationConfig;
  /** 历史消息，不含本轮正在生成的那条 assistant */
  history: ChatMessage[];
  /**
   * 每次调工具前现取一次，而不是开跑时定死一份 —— 会话中途拿到的新授权
   * （目录 / 管理员 / 屏幕）必须对**后面**的工具调用立刻生效，
   * 否则模型申请完还得等下一轮才能用，白白多烧一轮。
   */
  toolCtx: () => ToolContext;
  effortMappings: EffortMapping[];
  /** 项目规范 / 记忆 / 文档目录 / 本轮唤起的技能，拼在 system prompt 里 */
  extraSystem: string;
  timeoutMs: number;
  canRunHostTools: boolean;
  /** 限流 / 5xx 时自动重试几次，0 = 关掉 */
  autoRetry: number;
  /** 用于错误归类的展示名 */
  profileName?: string;
  /** 这条路由已知的窗口大小（从之前的报错里学来的），没有就返回 undefined */
  limitOf?: () => LearnedLimit | undefined;
  /** 又从报错里学到了新的窗口信息，交给上层存起来 */
  onLearnLimit?: (l: LearnedLimit) => void;
  /** 危险工具执行前的确认。返回 false 表示拒绝 */
  confirm(step: ToolStep): Promise<boolean>;
  /**
   * 模型申请会话级权限（目录 / 管理员 / 屏幕）。
   * 这一步不走原生层：授权状态活在渲染进程里，必须由用户在弹窗上点头。
   */
  grantAccess(req: AccessRequest): Promise<ToolResult>;
  events: AgentEvents;
}

/** 可以中途叫停的句柄 */
export interface AgentHandle {
  abort(): void;
}

/* ------------------------------------------------------------------ *
 * 历史消息 → 请求体 messages
 * ------------------------------------------------------------------ */

function toWire(
  history: ChatMessage[],
  cfg: GenerationConfig,
  withTools: boolean,
  extraSystem = '',
): WireMessage[] {
  let msgs = history.filter((m) => !m.error);

  if (cfg.historyLimit > 0 && msgs.length > cfg.historyLimit) {
    // 从后往前截，但不能把 tool 消息和它对应的 assistant 拆开
    msgs = msgs.slice(-cfg.historyLimit);
    while (msgs.length && msgs[0].role === 'tool') msgs.shift();
  }

  const out: WireMessage[] = [];

  for (const m of msgs) {
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: m.content,
        tool_call_id: m.toolCallId,
        name: m.toolName,
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });
      continue;
    }
    const atts = m.attachments ?? [];
    if (!m.content.trim() && atts.length === 0) continue;

    const texts = atts.filter((a) => a.kind === 'text');
    const images = atts.filter((a) => a.kind === 'image' && a.dataUrl);

    // 文本附件直接拼进正文，用围栏标出来源文件名
    let text = m.content;
    for (const a of texts) {
      text += `\n\n附件《${a.name}》的内容：\n\`\`\`\n${a.text ?? ''}\n\`\`\``;
    }

    if (images.length === 0) {
      out.push({ role: m.role, content: text });
      continue;
    }

    // 有图就必须用分段数组，字符串形式塞不进图片
    const parts: ContentPart[] = [{ type: 'text', text: text || '（见图）' }];
    for (const a of images) {
      parts.push({ type: 'image_url', image_url: { url: a.dataUrl as string } });
    }
    out.push({ role: m.role, content: parts });
  }

  const sys = composeSystem(cfg.systemPrompt, extraSystem, withTools);
  if (sys) out.unshift({ role: 'system', content: sys });

  return out;
}

/* ------------------------------------------------------------------ *
 * 上下文压缩
 *
 * 轮次开到几十轮之后，工具输出会把上下文撑爆 —— 一次 list_dir 就可能几千字符。
 * 策略：保留最近那批工具输出的全文，更早的压成一句摘要。
 *
 * 代价说清楚：改写历史会让上下文缓存的前缀失配一次。但能触发压缩的对话
 * 早就超出缓存能省下的量级了，而且每条只会被压一次，压完前缀重新稳定。
 * ------------------------------------------------------------------ */

/*
 * 软上限：1M token。
 *
 * 以前这里是 120_000 **字符**的工具输出预算，每一轮无条件执行。那是一道
 * 应用自己画的线，跟模型能吃多少无关 —— 用户拿 200K 窗口的模型跑长任务，
 * 一样在 120K 字符处被悄悄削掉历史。
 *
 * 现在的规矩：**不到 1M token 不动它**。真正的硬限制只有两个，都不是我们定的：
 *   1. 这条路由的窗口（撞出来之后记在 limits.ts 里，按它压）
 *   2. 1M token 这道系统级的线 —— 再往上，压缩本身的开销和出错概率都不划算了
 *
 * 到线时会先在界面上说一声再压，而不是默默削。
 */
const SOFT_LIMIT_TOKENS = 1_000_000;

/** 到达软上限后压到这里，留出继续干活的余量 */
const SOFT_TARGET_TOKENS = 700_000;

const TOOL_OUTPUT_BUDGET = 120_000;

/**
 * 压到 budget（字符数）以内。预算作为参数传进来，是因为撞墙之后要能压得更狠：
 * 120K → 30K → 8K。一次压不下去就再压一轮，而不是把整条任务判死。
 *
 * 返回是否真的压掉了东西 —— 压不动了就没必要再重试同一个请求。
 */
function compactToolOutputs(msgs: ChatMessage[], budget = TOOL_OUTPUT_BUDGET): boolean {
  let used = 0;
  let changed = false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'tool') continue;
    if (m.content.startsWith('（旧的工具输出已省略')) continue;

    used += m.content.length;
    if (used <= budget) continue;

    const head = m.content.replace(/\s+/g, ' ').slice(0, 240);
    m.content = `（旧的工具输出已省略以控制上下文长度。开头是：${head}…）`;
    changed = true;
  }
  return changed;
}

/**
 * 工具输出已经压无可压时，最后一招：把**中段的对话本身**折叠掉。
 *
 * 保留头尾 —— 开头是任务定义，结尾是当前进展，中间那截推理过程丢了
 * 还能接着干。全丢了就只能从头再来，而「从头再来」正是这次要消灭的东西。
 */
function foldMiddle(msgs: ChatMessage[], keepHead: number, keepTail: number): boolean {
  const first = msgs.findIndex((m) => m.role !== 'system');
  if (first < 0) return false;
  const start = first + keepHead;
  const end = msgs.length - keepTail;
  if (end - start < 2) return false;

  const dropped = end - start;
  msgs.splice(start, dropped, {
    id: uid('m'),
    role: 'user',
    content: `（为了不超出上下文窗口，中间 ${dropped} 条消息已折叠。之前做过的事请以后面的工具结果为准；` +
      '缺了必要信息就重新查一次，不要凭印象编。）',
    createdAt: Date.now(),
  });
  return true;
}

/* ------------------------------------------------------------------ *
 * 工具返回值 → 喂回模型的文本
 * ------------------------------------------------------------------ */

function renderToolOutput(res: ToolResult, numbered: SourceRef[]): string {
  if (!res.ok) return `工具执行失败：${res.error ?? '未知错误'}`;

  if (!numbered.length) return res.content;

  const head = numbered
    .map((s) => `[${s.n}] ${s.title}${s.url ? ` — ${s.url}` : s.path ? ` — ${s.path}` : ''}`)
    .join('\n');
  return `可引用来源（在回答里用方括号编号引用）：\n${head}\n\n---\n${res.content}`;
}

/**
 * 把这一轮的失败原因取出来。
 *
 * 存在的唯一理由是重置 TS 的控制流窄化 —— 见调用点那段注释。
 * 返回类型是显式声明的，所以调用方拿到的永远是 string | null。
 */
function takeFailure(s: { failed: string | null }): string | null {
  return s.failed;
}

/** 可被中止打断的等待 */
async function sleep(ms: number, aborted: () => boolean): Promise<void> {
  const step = 120;
  for (let left = ms; left > 0; left -= step) {
    if (aborted()) return;
    await new Promise((r) => setTimeout(r, Math.min(step, left)));
  }
}

/* ------------------------------------------------------------------ *
 * 主循环
 * ------------------------------------------------------------------ */

export function runAgent(args: RunAgentArgs): AgentHandle {
  const { config: cfg, events } = args;
  let aborted = false;

  const handle: AgentHandle = {
    abort() {
      aborted = true;
      void getTransport().abort(args.requestId);
    },
  };

  void (async () => {
    try {
      // 本平台真正能跑的工具，跟用户勾选的取交集
      const usable = new Set(availableTools(args.canRunHostTools).map((t) => t.name));
      const toolNames = cfg.toolsEnabled
        ? cfg.enabledTools.filter((n) => usable.has(n) && TOOL_BY_NAME[n])
        : [];

      /*
       * 「开着工具开关，但一个工具都发不出去」必须当场说破。
       *
       * 之前这里是静默的：请求体里没有 tools，模型手上空空如也，于是它
       * 只能用嘴描述自己在调用工具 ——「现在真正调用工具获取信息」然后停住。
       * 看起来像模型在敷衍，其实是应用根本没给它工具。
       */
      if (cfg.toolsEnabled && toolNames.length === 0) {
        const why = cfg.enabledTools.length
          ? '勾选的那些工具在这个平台上都跑不了（比如在手机上勾了只有桌面端才有的工具）'
          : '一个工具都没勾';
        events.onError('工具开关是开的，但实际下发的工具数为 0', {
          kind: 'tools_unsupported',
          title: '这次请求里没有任何工具',
          detail: `toolsEnabled=true，enabledTools=[${cfg.enabledTools.join(', ')}]，可用交集为空。原因：${why}。`,
          fixes: [
            '右侧配置面板 →「给模型下发工具」下面，至少勾一个工具',
            '要让它截屏或点鼠标，先勾上 request_access，让它自己开口申请',
            '不想用工具的话，把「给模型下发工具」整个关掉 —— 那样模型就不会再说要调用工具了',
          ],
          retryable: false,
          blameModel: false,
        });
        return;
      }

      // 最后一条用户消息带没带图，用来把「纯文本模型收到图片」的 400 翻译准确
      const hasImage = [...args.history]
        .reverse()
        .find((m) => m.role === 'user')
        ?.attachments?.some((a) => a.kind === 'image') ?? false;

      // 这一整次提问累积的历史（含工具往返），每轮都在它上面追加
      const working: ChatMessage[] = [...args.history];
      const sources: SourceRef[] = [];
      const seenUrls = new Set<string>();
      // 上限钉在 1000：配置文件被改坏或从旧版本迁移过来时，
      // 不该出现「一个问题打十万次接口」这种可能
      const maxRounds = Math.min(1000, Math.max(1, cfg.maxToolRounds || 1));
      // 「说了要调工具但没传过来」的重来次数，整次提问共用一个额度
      let emptyToolRetries = 0;
      // 上下文溢出后的「压缩再来」次数，整次提问共用
      let overflowRetries = 0;

      for (let round = 1; round <= maxRounds; round++) {
        if (aborted) break;
        events.onRound(round, maxRounds);

        /*
         * 软上限检查。注意它跟下面那段「按路由窗口压」是两件事：
         * 这一段管的是「大到系统扛不住」，下面那段管的是「上游收不下」。
         */
        const totalNow = estimateTokens(
          working.map((m) => m.content).join('\n'),
        );
        if (totalNow > SOFT_LIMIT_TOKENS) {
          events.onNotice(
            `上下文到了 ${Math.round(totalNow / 10000) / 100}M token，正在折叠较早的内容…`,
          );
          let guard = 0;
          while (
            estimateTokens(working.map((m) => m.content).join('\n')) > SOFT_TARGET_TOKENS &&
            guard++ < 8
          ) {
            if (!compactToolOutputs(working, TOOL_OUTPUT_BUDGET >> Math.min(guard - 1, 5))) {
              if (!foldMiddle(working, 2, 8)) break;
            }
          }
        }

        /*
         * 上下文预算。知道窗口多大就先自己压，不知道就先发出去、撞了再学。
         * 「撞了再学」不丢人 —— 丢人的是撞完把 22 步的工作一起扔掉。
         */
        const mt = cfg.params.max_tokens;
        const wantOutput = mt?.enabled ? Number(mt.value) || 4096 : 4096;
        const budget = inputBudget(args.limitOf?.(), wantOutput);
        if (budget) {
          let guard = 0;
          while (guard++ < 6) {
            const est = estimateTokens(
              toWire(working, cfg, toolNames.length > 0, args.extraSystem)
                .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
                .join('\n'),
            );
            if (est <= budget) break;
            // 先压工具输出，压不动了再折中段
            if (!compactToolOutputs(working, Math.max(2000, 30_000 >> (guard - 1)))) {
              if (!foldMiddle(working, 2, 6)) break;
            }
          }
        }

        const roomLeft = budget
          ? budget -
            estimateTokens(
              toWire(working, cfg, toolNames.length > 0, args.extraSystem)
                .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
                .join('\n'),
            )
          : null;
        let body = buildRequestBody(
          cfg,
          toWire(working, cfg, toolNames.length > 0, args.extraSystem),
          toolNames,
          args.effortMappings,
          roomLeft,
        );

        let roundContent = '';
        let roundReasoning = '';
        let roundCalls: ToolCall[] = [];
        let roundStop: StopInfo = { reason: null, droppedCalls: 0 };
        // 放在对象里而不是裸 let：闭包里赋的值 TS 的控制流分析看不见，
        // 裸变量会被窄化成 null，后面 if 判断直接被当成死代码
        const roundState: { failed: string | null; status?: number } = { failed: null };

        /*
         * 限流和瞬时 5xx 都属于「等一会儿再来就好」，让用户自己点重发是把
         * 本可以自动处理的事丢回给人。这里退避重试。
         *
         * 只在**一个字都还没吐出来**时才重试 —— 流式已经开始之后重试会让
         * 前半段内容在界面上出现两次，那比直接报错更糟。
         */
        const maxAttempts = 1 + Math.max(0, args.autoRetry);
        for (let attempt = 1; ; attempt++) {
          roundContent = '';
          roundReasoning = '';
          roundCalls = [];
          roundStop = { reason: null, droppedCalls: 0 };
          roundState.failed = null;
          roundState.status = undefined;

          await getTransport().chat(
            {
              requestId: args.requestId,
              url: endpoint(args.profile.baseUrl, 'chat/completions'),
              headers: buildHeaders(args.apiKey, args.profile),
              body,
              stream: cfg.stream,
              timeoutMs: args.timeoutMs,
              // 配额是按凭据算的，不是按地址 —— 同一把 key 在别的会话里也在跑时，
              // 按地址分组会各记各的，两边都以为自己还有余量
              paceKey: args.profile.id,
            },
            {
              onPaceWait(ms) {
                events.onNotice(
                  `为避开限流，${Math.ceil(ms / 1000)} 秒后发出（这是刻意放慢，不是卡住）`,
                );
              },
              onContent(d) {
                roundContent += d;
                events.onContentDelta(d);
              },
              onReasoning(d) {
                roundReasoning += d;
                events.onReasoningDelta(d);
              },
              onToolCalls(calls) {
                roundCalls = calls;
              },
              onStop(info) {
                roundStop = info;
              },
              onUsage(u) {
                events.onUsage(u);
              },
              onDone() {},
              onError(msg, status) {
                roundState.failed = msg;
                roundState.status = status;
              },
            },
          );

          /*
           * 为什么要绕一个函数才能把错误取出来。
           *
           * `failed` 只在上面那个 onError 闭包里被赋值，而 TS 的控制流分析
           * 看不进闭包 —— 它只看得见循环开头那句 `roundState.failed = null`，
           * 于是认定这里的 failed 就是 null。判空之后剩下的分支被窄化成
           * never，传给 classifyError 还能蒙混过关（never 赋给谁都行），
           * 一旦对它调 .slice 就当场报错。
           *
           * 上一版试过 `const failMsg: string | null = roundState.failed` ——
           * **不管用**。const 的类型注解定的是「能装什么」，实际类型仍然取
           * 初始化表达式那一刻的窄化结果，也就是 null。
           *
           * 函数边界才是唯一能重置窄化的东西：takeFailure 的返回类型是声明
           * 出来的 string | null，调用点拿到的就是它，跟外面窄成什么样无关。
           */
          const failMsg = takeFailure(roundState);
          const failStatus = roundState.status;
          if (!failMsg || aborted) break;

          /*
           * 上下文撑爆了。这是唯一一类「重发同样的请求必然再失败，但把请求
           * 改小一点就能成」的错误 —— 所以它不该跟限流共用退避重试，而该走
           * 自己的路：压缩 → 重建请求体 → 立刻再试。
           *
           * 这里是整个改动的重点。之前 22 步的检索结果会随着这一个 400 一起
           * 作废，用户得从头再问一遍；现在只是中间那截被折叠掉，任务接着跑。
           */
          if (looksLikeOverflow(failMsg) || failStatus === 413) {
            const learned = parseLimits(failMsg);
            if (learned.maxContext || learned.maxOutput) {
              args.onLearnLimit?.({ ...learned, at: Date.now(), from: failMsg.slice(0, 300) });
            }
            if (overflowRetries < 3) {
              overflowRetries++;
              // 每次都压得更狠：30K → 8K → 2K 字符的工具输出预算
              const shrink = [30_000, 8_000, 2_000][overflowRetries - 1];
              const squeezed = compactToolOutputs(working, shrink) || foldMiddle(working, 2, 6);
              if (squeezed) {
                events.onNotice(`上下文超了，已折叠较早的内容（第 ${overflowRetries} 次），正在续跑…`);
                body = buildRequestBody(
                  cfg,
                  toWire(working, cfg, toolNames.length > 0, args.extraSystem),
                  toolNames,
                  args.effortMappings,
                  roomLeft,
                );
                continue;
              }
            }
            // 压无可压才认输，而且要说清是压过之后仍然放不下
            events.onNotice('');
            events.onError(failMsg, {
              kind: 'context_too_long',
              title: '压缩过之后仍然放不下',
              detail: failMsg,
              fixes: [
                '用 ⑂ 从关键的那一步分叉出新对话，只带需要的上下文继续',
                '换一个窗口更大的模型 —— 这条路由的窗口刚才已经从报错里学到了，会记在这个模型名下',
                '右侧配置面板把 max_tokens 调小，输出占的那部分也算在窗口里',
              ],
              retryable: false,
              blameModel: false,
            });
            return;
          }

          const info = classifyError(failMsg, failStatus, {
            model: cfg.model,
            profileName: args.profileName,
            sentEffort: cfg.effortLevel !== 'off',
            sentTools: toolNames.length > 0,
            sentImage: hasImage,
          });
          const emitted = roundContent.length > 0 || roundReasoning.length > 0;

          if (!info.retryable || emitted || attempt >= maxAttempts) {
            events.onNotice('');
            events.onError(failMsg, info);
            return;
          }

          const wait = backoffMs(attempt, info);
          events.onNotice(
            `${info.title} — ${Math.ceil(wait / 1000)} 秒后自动重试（第 ${attempt}/${maxAttempts - 1} 次）`,
          );
          await sleep(wait, () => aborted);
          if (aborted) break;
        }

        events.onNotice('');
        if (aborted) break;

        /* ---- 没有工具调用：可能是答完了，也可能是出事了 ---- */
        if (!roundCalls.length) {
          events.onStopReason(roundStop.reason);

          // 上游说它要调工具，却一个都没解析出来 —— 几乎都是流在工具调用
          // 中间断了。重来一次比把一个空气泡甩给用户强。只给两次机会，
          // 不然一条坏路由能把 maxRounds 烧干净。
          const wantedTools =
            /^(tool_calls|function_call)$/i.test(roundStop.reason ?? '') || roundStop.droppedCalls > 0;
          if (wantedTools && emptyToolRetries < 2 && !aborted) {
            emptyToolRetries++;
            events.onNotice('工具调用没传完整，正在重来一次…');
            await sleep(800, () => aborted);
            if (aborted) break;
            continue;
          }

          const why = stopReasonInfo(roundStop, {
            hadContent: roundContent.trim().length > 0 || roundReasoning.trim().length > 0,
            sentTools: toolNames.length > 0,
            model: cfg.model,
          });
          if (why) {
            events.onError(why.title, why);
            return;
          }
          break; // 正常收尾
        }

        working.push({
          id: uid('m'),
          role: 'assistant',
          content: roundContent,
          reasoning: roundReasoning || undefined,
          toolCalls: roundCalls,
          createdAt: Date.now(),
        });

        for (const call of roundCalls) {
          if (aborted) break;

          const def = TOOL_BY_NAME[call.name];
          let parsedArgs: Record<string, unknown> = {};
          let parseError: string | null = null;
          try {
            parsedArgs = call.arguments.trim() ? JSON.parse(call.arguments) : {};
          } catch (e) {
            parseError = e instanceof Error ? e.message : '参数不是合法 JSON';
          }

          const step: ToolStep = {
            id: uid('s'),
            callId: call.id,
            name: call.name,
            args: parseError ? call.arguments : parsedArgs,
            status: 'running',
            summary: def ? def.summarize(parsedArgs) : `调用 ${call.name}`,
            startedAt: Date.now(),
          };
          events.onStep(step);

          const finishStep = (patch: Partial<ToolStep>, feedback: string) => {
            Object.assign(step, patch, { elapsedMs: Date.now() - step.startedAt });
            events.onStep({ ...step });
            working.push({
              id: uid('m'),
              role: 'tool',
              content: feedback,
              toolCallId: call.id,
              toolName: call.name,
              createdAt: Date.now(),
            });
          };

          if (!def) {
            finishStep(
              { status: 'error', error: `没有这个工具：${call.name}` },
              `错误：不存在名为 ${call.name} 的工具。可用工具：${toolNames.join(', ')}`,
            );
            continue;
          }
          if (parseError) {
            finishStep(
              { status: 'error', error: `参数解析失败：${parseError}` },
              `错误：参数不是合法 JSON（${parseError}）。请重新以合法 JSON 调用。`,
            );
            continue;
          }
          if (def.dangerous) {
            const ok = await args.confirm(step);
            if (!ok) {
              finishStep(
                { status: 'denied' },
                '用户拒绝了这次操作。请换一种不需要该操作的方式，或者直接说明你需要什么授权。',
              );
              continue;
            }
          }

          let res: ToolResult;
          try {
            if (call.name === 'request_access') {
              // 授权状态活在渲染进程里，原生层没法也不该自己发放
              res = await args.grantAccess({
                scope: String(parsedArgs.scope ?? '') as AccessRequest['scope'],
                target: parsedArgs.target ? String(parsedArgs.target) : undefined,
                reason: String(parsedArgs.reason ?? ''),
              });
            } else {
              res = await getTransport().callTool(call.name, parsedArgs, args.toolCtx());
            }
          } catch (e) {
            res = { ok: false, content: '', error: e instanceof Error ? e.message : String(e) };
          }

          // 来源编号：全局唯一、按 url 去重
          const fresh: SourceRef[] = [];
          for (const src of res.sources ?? []) {
            const key = src.url ?? src.path ?? src.title;
            if (key && seenUrls.has(key)) {
              const existing = sources.find((s) => (s.url ?? s.path ?? s.title) === key);
              if (existing) fresh.push(existing);
              continue;
            }
            if (key) seenUrls.add(key);
            const ref: SourceRef = { ...src, n: sources.length + 1 };
            sources.push(ref);
            fresh.push(ref);
          }
          if (fresh.length) events.onSources([...sources]);

          finishStep(
            {
              status: res.ok ? 'ok' : 'error',
              output: res.content,
              error: res.error,
              summary: res.summary ?? step.summary,
              sources: fresh,
              filePath: res.filePath,
            },
            renderToolOutput(res, fresh),
          );

          // 截屏这类工具返回的是图。多数 OpenAI 兼容端点不接受 role=tool 里带
          // 图片，所以补一条 user 消息把图递进去 —— 模型看得到才谈得上「看着点」。
          if (res.imageDataUrl) {
            working.push({
              id: uid('m'),
              role: 'user',
              content: '（上一步工具返回的截图）',
              attachments: [
                {
                  id: uid('att'),
                  kind: 'image',
                  name: 'screenshot.png',
                  mime: 'image/png',
                  size: res.imageDataUrl.length,
                  dataUrl: res.imageDataUrl,
                },
              ],
              createdAt: Date.now(),
            });
          }
        }

        if (round === maxRounds) {
          // 轮次用尽还在要工具：告诉模型收手，让它用已有信息作答
          working.push({
            id: uid('m'),
            role: 'user',
            content:
              '（系统提示）工具调用轮次已达上限，不要再调用任何工具了。请基于已经拿到的信息直接给出最终回答，信息不足的地方如实说明。',
            createdAt: Date.now(),
          });
          const finalBody = buildRequestBody(cfg, toWire(working, cfg, false, args.extraSystem), [], args.effortMappings);
          await getTransport().chat(
            {
              requestId: args.requestId,
              url: endpoint(args.profile.baseUrl, 'chat/completions'),
              headers: buildHeaders(args.apiKey, args.profile),
              body: finalBody,
              stream: cfg.stream,
              timeoutMs: args.timeoutMs,
              // 配额是按凭据算的，不是按地址 —— 同一把 key 在别的会话里也在跑时，
              // 按地址分组会各记各的，两边都以为自己还有余量
              paceKey: args.profile.id,
            },
            {
              onPaceWait: (ms) =>
                events.onNotice(`为避开限流，${Math.ceil(ms / 1000)} 秒后发出（这是刻意放慢，不是卡住）`),
              onContent: (d) => events.onContentDelta(d),
              onReasoning: (d) => events.onReasoningDelta(d),
              onToolCalls: () => {},
              onUsage: (u) => events.onUsage(u),
              onDone: () => {},
              onError: (m, status) =>
                events.onError(
                  m,
                  classifyError(m, status, {
                    model: cfg.model,
                    profileName: args.profileName,
                    sentEffort: cfg.effortLevel !== 'off',
                  }),
                ),
            },
          );
        }
      }

      events.onDone();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      events.onError(m, classifyError(m, undefined, { model: cfg.model }));
    }
  })();

  return handle;
}
