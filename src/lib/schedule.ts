import { getTransport } from './transport';
import { uid } from './store';

/* ------------------------------------------------------------------ *
 * 定时任务
 *
 * 老实说清楚它的边界：调度器跑在渲染进程里，**应用必须开着才会触发**。
 * 要做到关掉窗口也能跑，得把整个 Agent 循环搬进主进程再复制一遍 —— 那是
 * 另一个量级的改动，收益也有限（工具确认弹窗没人点，照样卡住）。
 *
 * 补偿措施：错过的任务在下次打开应用时会被发现，按「补跑一次」处理。
 * ------------------------------------------------------------------ */

const K_TASKS = 'snc:tasks:v1';

export type ScheduleKind = 'interval' | 'daily' | 'weekly' | 'cron';

export interface Schedule {
  kind: ScheduleKind;
  /** interval：每多少分钟 */
  everyMinutes?: number;
  /** daily / weekly：几点几分，本地时区 */
  hour?: number;
  minute?: number;
  /** weekly：0=周日 … 6=周六 */
  weekdays?: number[];
  /** cron：标准 5 段 */
  cron?: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  /** 触发时发给模型的那句话 */
  prompt: string;
  schedule: Schedule;
  enabled: boolean;
  /** 在哪个项目下建对话 */
  projectId: string | null;
  /** 用哪份凭据 / 哪个模型；留空就用全局默认 */
  keyProfileId: string | null;
  model: string;
  /** 每次新开一个对话，还是都追加到同一个 */
  target: 'new' | 'same';
  /** target=same 时用的那个对话 */
  conversationId?: string;
  /** 错过了要不要补跑 */
  catchUp: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastResult?: string;
  nextRunAt?: number;
}

export function makeTask(name: string): ScheduledTask {
  return {
    id: uid('t'),
    name: name.trim() || '新任务',
    prompt: '',
    schedule: { kind: 'daily', hour: 9, minute: 0 },
    enabled: false,
    projectId: null,
    keyProfileId: null,
    model: '',
    target: 'new',
    catchUp: true,
    createdAt: Date.now(),
  };
}

export async function loadTasks(): Promise<ScheduledTask[]> {
  try {
    const raw = await getTransport().kvGet(K_TASKS);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? (list as ScheduledTask[]) : [];
  } catch {
    return [];
  }
}

export async function saveTasks(list: ScheduledTask[]): Promise<void> {
  await getTransport().kvSet(K_TASKS, JSON.stringify(list));
}

/* ------------------------------------------------------------------ *
 * cron：只认标准 5 段（分 时 日 月 周），支持 * , - / 。
 * 不引库 —— 就这点语法，自己算比多一个依赖划算。
 * ------------------------------------------------------------------ */

function parseField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isFinite(step) || step < 1) return null;

    let lo = min;
    let hi = max;
    if (rangePart !== '*') {
      const m = rangePart.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) return null;
      lo = Number(m[1]);
      hi = m[2] !== undefined ? Number(m[2]) : lo;
      if (stepPart && m[2] === undefined) hi = max; // 「5/10」= 从 5 开始每 10
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export interface CronSpec {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  /** 日和周都不是 * 时，cron 的语义是「满足其一即可」 */
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseCron(expr: string): CronSpec | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = parseField(f[0], 0, 59);
  const hour = parseField(f[1], 0, 23);
  const dom = parseField(f[2], 1, 31);
  const month = parseField(f[3], 1, 12);
  const dow = parseField(f[4].replace(/7/g, '0'), 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: f[2] !== '*',
    dowRestricted: f[4] !== '*',
  };
}

function cronMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.includes(d.getMinutes())) return false;
  if (!spec.hour.includes(d.getHours())) return false;
  if (!spec.month.includes(d.getMonth() + 1)) return false;

  const domOk = spec.dom.includes(d.getDate());
  const dowOk = spec.dow.includes(d.getDay());

  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

/** 从 from 之后的下一个触发时刻；算不出来返回 null */
export function nextRun(s: Schedule, from: Date = new Date()): number | null {
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  switch (s.kind) {
    case 'interval': {
      const mins = Math.max(1, s.everyMinutes ?? 60);
      return from.getTime() + mins * 60_000;
    }
    case 'daily': {
      const d = new Date(from.getTime());
      d.setSeconds(0, 0);
      d.setHours(s.hour ?? 9, s.minute ?? 0);
      if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    case 'weekly': {
      const days = s.weekdays?.length ? s.weekdays : [1];
      let best: number | null = null;
      for (let i = 0; i <= 7; i++) {
        const d = new Date(from.getTime());
        d.setSeconds(0, 0);
        d.setDate(d.getDate() + i);
        d.setHours(s.hour ?? 9, s.minute ?? 0);
        if (!days.includes(d.getDay())) continue;
        if (d.getTime() <= from.getTime()) continue;
        if (best === null || d.getTime() < best) best = d.getTime();
      }
      return best;
    }
    case 'cron': {
      const spec = parseCron(s.cron ?? '');
      if (!spec) return null;
      // 逐分钟往前试，最多试一年，找不到就认输
      const d = new Date(start.getTime());
      for (let i = 0; i < 366 * 24 * 60; i++) {
        if (cronMatches(spec, d)) return d.getTime();
        d.setMinutes(d.getMinutes() + 1);
      }
      return null;
    }
    default:
      return null;
  }
}

export function describeSchedule(s: Schedule): string {
  const hhmm = `${String(s.hour ?? 9).padStart(2, '0')}:${String(s.minute ?? 0).padStart(2, '0')}`;
  const DAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  switch (s.kind) {
    case 'interval': {
      const m = s.everyMinutes ?? 60;
      return m >= 60 && m % 60 === 0 ? `每 ${m / 60} 小时` : `每 ${m} 分钟`;
    }
    case 'daily':
      return `每天 ${hhmm}`;
    case 'weekly': {
      const days = (s.weekdays?.length ? s.weekdays : [1]).map((d) => DAY[d]).join('、');
      return `每周${days.replace(/周/g, '')} ${hhmm}`;
    }
    case 'cron':
      return parseCron(s.cron ?? '') ? `cron: ${s.cron}` : `cron 写错了：${s.cron}`;
    default:
      return '未配置';
  }
}

/** 现在该跑哪些任务 */
export function dueTasks(tasks: ScheduledTask[], now = Date.now()): ScheduledTask[] {
  return tasks.filter((t) => {
    if (!t.enabled || !t.prompt.trim()) return false;
    if (!t.nextRunAt) return false;
    if (t.nextRunAt > now) return false;
    // 错过太久又不许补跑的，直接跳过（只把 nextRunAt 往前推）
    if (!t.catchUp && now - t.nextRunAt > 30 * 60_000) return false;
    return true;
  });
}
