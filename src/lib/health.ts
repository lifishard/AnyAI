import type {
  ErrorInfo,
  KeyProfile,
  ModelHealth,
  ModelHealthMap,
  ModelHealthStatus,
  ModelInfo,
} from '../types';
import { quotaKey } from './adaptive';
import { buildHeaders, endpoint } from './api';
import { getTransport } from './transport';
import { classifyError } from './errors';
import { pacingFloor, parseRateLimits, type LearnedLimit } from './limits';
import { isRateLimited, paceOf } from './pacer';

/* ------------------------------------------------------------------ *
 * 模型健康度
 *
 * 接了聚合网关之后，模型列表里几百条路由并不是每条都活着：有的后端根本没起来
 * （500），有的 ID 早就下线了（404）。这些混在列表里，用户只能靠一次次撞上去发现。
 *
 * 这里做两件事：
 *   1. 真实对话失败时顺手记一笔 —— 不用用户做任何事
 *   2. 提供「批量体检」：给每个模型发一个最小请求，把死掉的挑出来
 *
 * 判据刻意保守：
 *   - 只有「服务端确定性坏掉」和「模型不存在」会让模型从默认列表里消失
 *   - 限流、超时、鉴权失败都不算模型的锅 —— 那是账号或网络的问题，
 *     把模型标黑只会让人以后找不到它
 * ------------------------------------------------------------------ */

/** 达到这个失败权重才从默认列表里藏起来 */
const HIDE_THRESHOLD = 2;

export function healthOf(
  map: ModelHealthMap,
  profileId: string | null,
  modelId: string,
): ModelHealth | undefined {
  if (!profileId) return undefined;
  return map[profileId]?.[modelId];
}

/** 这个模型该不该从默认列表里藏起来 */
export function shouldHide(h: ModelHealth | undefined): boolean {
  if (!h) return false;
  if (h.muted) return true;
  if (h.status !== 'broken' && h.status !== 'missing') return false;
  return h.fails >= HIDE_THRESHOLD;
}

function put(
  map: ModelHealthMap,
  profileId: string,
  modelId: string,
  h: ModelHealth,
): ModelHealthMap {
  return { ...map, [profileId]: { ...(map[profileId] ?? {}), [modelId]: h } };
}

/**
 * 一次真实对话失败后记一笔。
 *
 * 权重：确定性的服务端崩溃和「模型不存在」记 2 分，一次就够藏起来 ——
 * 这两种重试一百次结果也一样。可能是瞬时的（502、网关抖动）记 1 分，
 * 要连着撞上两次才算数。
 */
export function recordFailure(
  map: ModelHealthMap,
  profileId: string | null,
  modelId: string,
  info: ErrorInfo,
): ModelHealthMap {
  if (!profileId || !modelId) return map;

  let status: ModelHealthStatus;
  let weight: number;

  switch (info.kind) {
    case 'model_missing':
      status = 'missing';
      weight = 2;
      break;
    case 'model_broken':
      status = 'broken';
      weight = info.retryable ? 1 : 2; // retryable = 看起来是瞬时的
      break;
    case 'rate_limit':
      status = 'ratelimited';
      weight = 0; // 不是模型的锅
      break;
    case 'timeout':
      status = 'timeout';
      weight = 0;
      break;
    default:
      return map; // 鉴权、参数、上下文超长……都跟模型本身好不好无关
  }

  const prev = map[profileId]?.[modelId];
  return put(map, profileId, modelId, {
    status,
    code: info.status,
    reason: info.title,
    at: Date.now(),
    fails: (prev?.fails ?? 0) + weight,
    muted: prev?.muted,
  });
}

/** 成功一次就清账 —— 之前的失败不再累积 */
export function recordSuccess(
  map: ModelHealthMap,
  profileId: string | null,
  modelId: string,
): ModelHealthMap {
  if (!profileId || !modelId) return map;
  const prev = map[profileId]?.[modelId];
  // 没记录过 = 默认就是健康的，不必给几百个模型各存一条
  if (!prev) return map;
  if (prev.status === 'ok' && prev.fails === 0) return map;
  return put(map, profileId, modelId, {
    status: 'ok',
    at: Date.now(),
    fails: 0,
    muted: prev?.muted,
  });
}

/** 手动压下 / 恢复一个模型 */
export function setMuted(
  map: ModelHealthMap,
  profileId: string | null,
  modelId: string,
  muted: boolean,
): ModelHealthMap {
  if (!profileId) return map;
  const prev = map[profileId]?.[modelId];
  return put(map, profileId, modelId, {
    status: prev?.status ?? 'unknown',
    code: prev?.code,
    reason: prev?.reason,
    at: prev?.at ?? Date.now(),
    fails: prev?.fails ?? 0,
    muted,
  });
}

/** 清掉一份凭据下的全部记录 */
export function clearHealth(map: ModelHealthMap, profileId: string | null): ModelHealthMap {
  if (!profileId) return map;
  const next = { ...map };
  delete next[profileId];
  return next;
}

/** 把模型列表按健康度分成「正常」和「有问题」两堆 */
export function partitionModels(
  models: ModelInfo[],
  map: ModelHealthMap,
  profileId: string | null,
): { good: ModelInfo[]; bad: ModelInfo[] } {
  const good: ModelInfo[] = [];
  const bad: ModelInfo[] = [];
  for (const m of models) {
    if (shouldHide(healthOf(map, profileId, m.id))) bad.push(m);
    else good.push(m);
  }
  return { good, bad };
}

/* ------------------------------------------------------------------ *
 * 批量体检
 * ------------------------------------------------------------------ */

export interface ProbeProgress {
  done: number;
  total: number;
  /** 正在测的模型 */
  current: string;
  /** 刚出结果的那一个 */
  last?: { id: string; health: ModelHealth };
}

export interface ProbeOutcome {
  health: Record<string, ModelHealth>;
  stopped: boolean;
  /** 让整轮体检没法继续的问题（key 不对之类），有值时上面的结果不可信 */
  fatal?: ErrorInfo;
}

/**
 * 给一个模型发最小请求，只看它活不活。
 *
 * 刻意不带工具、不带思考强度、不带任何可选参数 —— 只测「这条路由通不通」，
 * 不测「这条路由支不支持某个功能」。混在一起测的话，一个不支持 tools 的好模型
 * 会被误判成坏的。
 */
async function probeOne(
  profile: KeyProfile,
  apiKey: string,
  modelId: string,
  timeoutMs: number,
  limitOf?: (model: string) => LearnedLimit | undefined,
  onLearnLimit?: (model: string, l: LearnedLimit) => void,
): Promise<{ ok: boolean; info?: ErrorInfo; hollow?: boolean }> {
  let failMsg: string | null = null;
  let failStatus: number | undefined;
  /** 这次请求到底吐出东西了没有 —— 用来识别「200 但正文是空的」 */
  let sawAnything = false;

  await getTransport().chat(
    {
      requestId: `probe-${modelId}-${Date.now()}`,
      url: endpoint(profile.baseUrl, 'chat/completions'),
      headers: buildHeaders(apiKey, profile),
      body: {
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 16,
        stream: false,
      },
      stream: false,
      timeoutMs,
      /*
       * 体检必须跟正常对话排在**同一条队伍**里。
       *
       * 之前这里什么都没传，于是它按地址分组，跟对话各排各的 —— 一边在
       * 聊天一边点体检，两条队伍互相看不见，加起来就把配额打爆了。
       * 配额是按凭据算的，队伍也必须按凭据分。
       */
      paceKey: quotaKey(profile),
      paceMinMs: pacingFloor(limitOf?.(modelId), 32),
    },
    {
      onContent(d) {
        if (d) sawAnything = true;
      },
      onReasoning(d) {
        if (d) sawAnything = true;
      },
      onToolCalls() {},
      onUsage(u) {
        if (u?.completion_tokens || u?.total_tokens) sawAnything = true;
      },
      onDone() {},
      onError(msg, status) {
        failMsg = msg;
        failStatus = status;
      },
    },
  );

  // 有些网关把非聊天模型（图像生成之类）也列进 /models，请求打过去返回 200
  // 但正文里什么都没有。这种不算坏，但也不该打上「体检通过」的勾。
  if (failMsg === null) return { ok: true, hollow: !sawAnything };

  // 体检撞到的限流跟对话撞到的是同一条线，学到的东西也该记在同一个地方
  const msg: string = failMsg;
  if (isRateLimited(msg, failStatus)) {
    onLearnLimit?.(modelId, {
      ...parseRateLimits(msg),
      minIntervalMs: paceOf(quotaKey(profile)).intervalMs,
      at: Date.now(),
      from: msg.slice(0, 300),
    });
  }
  return { ok: false, info: classifyError(msg, failStatus, { model: modelId }) };
}

function toHealth(r: { ok: boolean; info?: ErrorInfo; hollow?: boolean }): ModelHealth {
  if (r.ok) {
    return {
      status: 'ok',
      at: Date.now(),
      fails: 0,
      reason: r.hollow ? '返回 200 但正文是空的 —— 可能不是聊天模型' : undefined,
    };
  }
  const info = r.info!;
  const status: ModelHealthStatus =
    info.kind === 'model_missing'
      ? 'missing'
      : info.kind === 'model_broken'
        ? 'broken'
        : info.kind === 'rate_limit'
          ? 'ratelimited'
          : info.kind === 'timeout'
            ? 'timeout'
            : 'unknown';
  return {
    status,
    code: info.status,
    reason: info.title,
    at: Date.now(),
    // 体检是专门去测的，确定性的坏一次就够定性；限流/超时不计分
    fails: status === 'broken' || status === 'missing' ? (info.retryable ? 1 : 2) : 0,
  };
}

/**
 * 批量体检。
 *
 * 并发刻意压得很低（默认 2）并且撞到限流就整体降速 —— 体检本身把额度打爆
 * 是最蠢的失败方式，那会让一批好模型被记成 ratelimited。
 */
export async function probeModels(opts: {
  profile: KeyProfile;
  apiKey: string;
  models: string[];
  timeoutMs?: number;
  concurrency?: number;
  onProgress?: (p: ProbeProgress) => void;
  shouldStop?: () => boolean;
  /** 这条凭据下某个模型已知的限流上限 */
  limitOf?: (model: string) => LearnedLimit | undefined;
  /** 体检过程中学到的新上限 */
  onLearnLimit?: (model: string, l: LearnedLimit) => void;
}): Promise<ProbeOutcome> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const total = opts.models.length;
  const health: Record<string, ModelHealth> = {};
  const concurrency = Math.max(1, Math.min(4, opts.concurrency ?? 2));
  let done = 0;
  let stopped = false;
  let fatal: ErrorInfo | undefined;
  /** 撞到限流后整体暂停到这个时刻 */
  let pauseUntil = 0;

  const queue = [...opts.models];

  const worker = async () => {
    for (;;) {
      if (stopped || fatal) return;
      if (opts.shouldStop?.()) {
        stopped = true;
        return;
      }
      const id = queue.shift();
      if (!id) return;

      const wait = pauseUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));

      opts.onProgress?.({ done, total, current: id });

      let r = await probeOne(opts.profile, opts.apiKey, id, timeoutMs, opts.limitOf, opts.onLearnLimit);

      // key 不对 / 余额没了：再测下去只会得到一堆假阴性
      if (!r.ok && (r.info!.kind === 'auth' || r.info!.kind === 'quota')) {
        fatal = r.info;
        return;
      }

      // 限流：让所有 worker 一起停一会儿，再给这一个第二次机会 ——
      // 别把好模型冤枉成坏的
      if (!r.ok && r.info!.kind === 'rate_limit') {
        pauseUntil = Date.now() + (r.info!.retryAfterMs ?? 5000);
        await new Promise((res) => setTimeout(res, pauseUntil - Date.now()));
        if (stopped || opts.shouldStop?.()) {
          stopped = true;
          return;
        }
        r = await probeOne(opts.profile, opts.apiKey, id, timeoutMs, opts.limitOf, opts.onLearnLimit);
      }

      const h = toHealth(r);
      health[id] = h;
      done++;
      opts.onProgress?.({ done, total, current: id, last: { id, health: h } });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { health, stopped, fatal };
}

/** 把体检结果并进总表 */
export function mergeProbe(
  map: ModelHealthMap,
  profileId: string | null,
  result: Record<string, ModelHealth>,
): ModelHealthMap {
  if (!profileId) return map;
  const prev = map[profileId] ?? {};
  const next = { ...prev };
  for (const [id, h] of Object.entries(result)) {
    // 用户手动压下的保持压下，体检不推翻人的决定
    next[id] = { ...h, muted: prev[id]?.muted };
  }
  return { ...map, [profileId]: next };
}

export const HEALTH_LABEL: Record<ModelHealthStatus, string> = {
  ok: '正常',
  broken: '服务端报错',
  missing: '不存在',
  ratelimited: '被限流',
  timeout: '超时',
  unknown: '未知',
};
