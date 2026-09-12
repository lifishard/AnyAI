import type {
  AccessRequest,
  ChatMessage,
  ErrorInfo,
  GenerationConfig,
  KeyProfile,
  SourceRef,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolStep,
  Usage,
} from '../types';
import { buildHeaders, endpoint } from './api';
import { buildRequestBody, type ContentPart, type WireMessage } from './paramSchema';
import { TOOL_BY_NAME, availableTools } from './tools/registry';
import type { EffortMapping } from './effort';
import { backoffMs, classifyError } from './errors';
import { getTransport } from './transport';
import { uid } from './store';

/* ------------------------------------------------------------------ *
 * 给模型的工具使用守则。
 * 只有真的下发了 tools 才追加，否则白白占 token 还会让模型胡乱提工具。
 * ------------------------------------------------------------------ */
const TOOL_SYSTEM_SUFFIX = `
你可以调用工具来完成任务。守则：
1. 涉及最新信息、具体数字、价格、版本号，或任何你不确定的事实，先用 web_search 查证再回答，不要凭记忆编造。
2. 引用了搜索结果或网页内容时，在相应句子末尾用 [1]、[2] 标注来源编号，编号对应工具返回结果里给出的编号。不要编造编号。
3. 搜索结果的摘要不够判断时，用 fetch_url 读全文；需要登录态或 JS 渲染后才有内容的页面，改用 chrome_read_page。
4. 会改变状态的操作（写文件、执行命令、提交 issue），先用一句话说明你要做什么再调用。
5. 信息够了就直接回答，不要为了用工具而用工具。同一个工具不要用相同参数反复调用。
`.trim();

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

  const sys = [cfg.systemPrompt.trim(), extraSystem.trim(), withTools ? TOOL_SYSTEM_SUFFIX : '']
    .filter(Boolean)
    .join('\n\n');
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

const TOOL_OUTPUT_BUDGET = 120_000;

function compactToolOutputs(msgs: ChatMessage[]): void {
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'tool') continue;
    if (m.content.startsWith('（旧的工具输出已省略')) continue;

    used += m.content.length;
    if (used <= TOOL_OUTPUT_BUDGET) continue;

    const head = m.content.replace(/\s+/g, ' ').slice(0, 240);
    m.content = `（旧的工具输出已省略以控制上下文长度。开头是：${head}…）`;
  }
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

      // 最后一条用户消息带没带图，用来把「纯文本模型收到图片」的 400 翻译准确
      const hasImage = [...args.history]
        .reverse()
        .find((m) => m.role === 'user')
        ?.attachments?.some((a) => a.kind === 'image') ?? false;

      // 这一整次提问累积的历史（含工具往返），每轮都在它上面追加
      const working: ChatMessage[] = [...args.history];
      const sources: SourceRef[] = [];
      const seenUrls = new Set<string>();
      const maxRounds = Math.max(1, cfg.maxToolRounds || 1);

      for (let round = 1; round <= maxRounds; round++) {
        if (aborted) break;
        events.onRound(round, maxRounds);

        compactToolOutputs(working);
        const body = buildRequestBody(
          cfg,
          toWire(working, cfg, toolNames.length > 0, args.extraSystem),
          toolNames,
          args.effortMappings,
        );

        let roundContent = '';
        let roundReasoning = '';
        let roundCalls: ToolCall[] = [];
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
            },
            {
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

          if (!roundState.failed || aborted) break;

          const info = classifyError(roundState.failed, roundState.status, {
            model: cfg.model,
            profileName: args.profileName,
            sentEffort: cfg.effortLevel !== 'off',
            sentTools: toolNames.length > 0,
            sentImage: hasImage,
          });
          const emitted = roundContent.length > 0 || roundReasoning.length > 0;

          if (!info.retryable || emitted || attempt >= maxAttempts) {
            events.onNotice('');
            events.onError(roundState.failed, info);
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

        // 没有工具调用 = 这就是最终回答
        if (!roundCalls.length) break;

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
            },
            {
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
