/* ------------------------------------------------------------------ *
 * 发送节奏控制
 *
 * 用户的原话：「有没有什么比较好的策略可以保持连线又不过量？连续、稳定的
 * 工作是第一位的。」
 *
 * 有的，而且这件事三十年前就被解决过一次 —— TCP 的拥塞控制。核心思想是
 * **不去猜对方的容量，而是不断试探并对反馈做出反应**：
 *
 *   顺利  → 一点一点加快（加性增大）
 *   被拒  → 立刻大幅放慢（乘性减小）
 *
 * 为什么不是「读文档上的 RPM 然后按它发」：
 *   - BYOK 客户端根本不知道这条路由的真实配额，聚合网关更是随时在变；
 *   - 同一把 key 可能同时在别的地方用着，配额是共享的；
 *   - 就算知道 60 RPM，按 60 发也一定会撞 —— 服务端的窗口和你的不对齐。
 *
 * 所以这里只做一件事：**记住上次发送的时间，并动态调整两次发送的最小间隔**。
 * 撞到限流就把间隔翻倍，一路顺利就慢慢往回收。它不需要知道配额是多少，
 * 自己会收敛到那条线下面一点的位置。
 *
 * ── 为什么「稳」比「快」重要 ──
 *
 * 一个 22 步的任务，用 1 秒一次的节奏冲，撞限流后退避、重试、再撞，实际
 * 耗时往往比老老实实 3 秒一次还长 —— 而且中途任何一次退避用尽都会让整个
 * 任务报废。稳定的慢，是比不稳定的快更快的。
 * ------------------------------------------------------------------ */

export interface PaceState {
  /** 两次发送之间至少隔多久（毫秒） */
  intervalMs: number;
  /** 上一次实际发出去的时刻 */
  lastSentAt: number;
  /** 连续顺利多少次了 —— 攒够一批才敢加速 */
  streak: number;
  /** 撞过多少次限流，只用来在界面上说明情况 */
  hits: number;
}

/** 起步间隔：不为难任何一条线路，也不至于慢到烦人 */
const START_MS = 350;
/** 最快到什么程度为止。再快没意义 —— 瓶颈早就在模型生成上了 */
const FLOOR_MS = 200;
/** 最慢到什么程度为止。再慢不如直接告诉用户换条路由 */
const CEIL_MS = 20_000;
/** 连续顺利这么多次，才把间隔往回收一点 */
const SPEEDUP_AFTER = 3;

const states = new Map<string, PaceState>();

function stateOf(key: string): PaceState {
  let s = states.get(key);
  if (!s) {
    s = { intervalMs: START_MS, lastSentAt: 0, streak: 0, hits: 0 };
    states.set(key, s);
  }
  return s;
}

export function paceOf(key: string): PaceState {
  return { ...stateOf(key) };
}

/** 主要给测试用：把某条线路的节奏清回初始值 */
export function resetPace(key?: string): void {
  if (key) states.delete(key);
  else states.clear();
}

/**
 * 撞到限流了。
 *
 * 乘性减小：直接翻倍，不是加一点点 —— 已经撞上说明当前节奏就是错的，
 * 慢慢往回挪只会一路继续撞。上游给了 Retry-After 就听它的，它比我们准。
 */
export function noteRateLimit(key: string, retryAfterMs?: number): number {
  const s = stateOf(key);
  s.hits++;
  s.streak = 0;
  const doubled = Math.min(CEIL_MS, Math.max(START_MS, s.intervalMs * 2));
  s.intervalMs = retryAfterMs ? Math.min(CEIL_MS, Math.max(doubled, retryAfterMs)) : doubled;
  return s.intervalMs;
}

/**
 * 这次顺利。
 *
 * 加性减小间隔，而且要连着顺利几次才动 —— 撞完立刻就往回冲，
 * 等于在限流的边缘反复横跳，体感比全程慢速还糟。
 */
export function noteSuccess(key: string): void {
  const s = stateOf(key);
  if (++s.streak < SPEEDUP_AFTER) return;
  s.streak = 0;
  s.intervalMs = Math.max(FLOOR_MS, Math.round(s.intervalMs * 0.75));
}

/**
 * 排在这条线路的队尾，轮到了再发。
 *
 * 同一把 key 上的请求**串行**通过这里。并发发三个然后各自退避，是把
 * 一次限流变成三次的最快方法。串行不会更慢：真正的耗时在模型生成上，
 * 而那部分本来就是一个接一个的。
 */
const chains = new Map<string, Promise<unknown>>();

export async function paced<T>(
  key: string,
  fn: () => Promise<T>,
  opts: {
    onWait?: (ms: number) => void;
    aborted?: () => boolean;
    /**
     * 这一次至少隔这么久再发，即使当前节奏比它快。
     *
     * 给排查那类「宁可慢也绝不能触发限流」的场景用：只有当一串请求在设计上
     * 就不可能把配额打爆时，它返回的限流才是**信号**而不是自己造出来的噪音。
     */
    minIntervalMs?: number;
  } = {},
): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  chains.set(
    key,
    new Promise<void>((r) => {
      release = r;
    }),
  );
  await prev.catch(() => {});

  try {
    const s = stateOf(key);
    const floor = Math.max(s.intervalMs, opts.minIntervalMs ?? 0);
    // 注意第一次也要等：上一个请求可能刚由别处发出去，lastSentAt 是共享的
    const wait = s.lastSentAt ? floor - (Date.now() - s.lastSentAt) : 0;
    if (wait > 0) {
      // 只有等得久到人能察觉时才提示，不然满屏都是「等待 40ms」
      if (wait > 700) opts.onWait?.(wait);
      const step = 100;
      for (let left = wait; left > 0; left -= step) {
        if (opts.aborted?.()) break;
        await new Promise((r) => setTimeout(r, Math.min(step, left)));
      }
    }
    s.lastSentAt = Date.now();
    return await fn();
  } finally {
    release();
    // 链子上最后一个走完就把它清掉，不然 key 会一直挂着一个已完成的 Promise
    if (chains.get(key) === undefined) chains.delete(key);
  }
}

/** 限流的说法各家不一样，这里只认最通用的那几种 */
const RATE_LIMITED =
  /rate.?limit|rpm|tpm|qps|quota.{0,12}(exceed|exhaust)|exhausted|too many requests|429|请求过于频繁|并发|限流/i;

export function isRateLimited(msg: string, status?: number): boolean {
  return status === 429 || RATE_LIMITED.test(msg || '');
}

/** 给界面用的一句话 */
export function describePace(key: string): string {
  const s = stateOf(key);
  if (!s.hits) return `发送间隔 ${s.intervalMs}ms（没撞过限流）`;
  return `发送间隔 ${s.intervalMs}ms —— 撞过 ${s.hits} 次限流，已自动放慢；一路顺利会慢慢收回去`;
}
