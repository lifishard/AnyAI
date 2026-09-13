'use strict';
const { ok, fail, fetchWithTimeout, clip } = require('./common.cjs');

const API = 'https://api.github.com';
const CDN = 'https://raw.githubusercontent.com';

/**
 * 最近一次 API 调用回报的限额。给设置页显示用。
 * GitHub 不带 token 是**按 IP** 每小时 60 次，没有任何客户端手段能重置它 ——
 * 只能少打、或者带 token（5000 次）。
 */
let lastRateLimit = null;

function rememberRateLimit(res) {
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining === null) return;
  lastRateLimit = {
    limit: Number(res.headers.get('x-ratelimit-limit')) || null,
    remaining: Number(remaining),
    resetAt: Number(res.headers.get('x-ratelimit-reset')) * 1000 || null,
    at: Date.now(),
  };
}

function rateLimitNote() {
  if (!lastRateLimit) return '';
  const { remaining, limit, resetAt } = lastRateLimit;
  if (remaining === null) return '';
  const mins = resetAt ? Math.max(0, Math.round((resetAt - Date.now()) / 60000)) : null;
  return `（API 额度 ${remaining}/${limit ?? '?'}${mins !== null ? `，${mins} 分钟后重置` : ''}）`;
}

/**
 * 公开仓库取文件正文时改走 raw.githubusercontent.com。
 *
 * 这是省额度的关键：CDN 不计入 API 的每小时配额。装一个技能仓库原来要打
 * 二十几次 API，现在只有「列目录」和「拉目录树」两次走 API，正文全走 CDN。
 *
 * 私有仓库 CDN 访问不到，会自动退回 API（那时必须有 token）。
 */
function toCdnUrl(apiPath) {
  const m = apiPath.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+?)(?:\?ref=([^&]+))?$/);
  if (!m) return null;
  const [, owner, repo, filePath, ref] = m;
  return `${CDN}/${owner}/${repo}/${ref ? decodeURIComponent(ref) : 'HEAD'}/${filePath}`;
}

function headers(token, raw) {
  const h = {
    // raw 模式直接拿文件原文：不走 base64、不裹 JSON，省掉一整类体积问题
    Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'wickrunAI',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/**
 * 把过大的 JSON 压到限额内，**但保证它仍然是合法 JSON**。
 *
 * 这是个吃过亏的地方：原来直接 clip 字符串，一个 32KB 的 SKILL.md 经 base64
 * 变成 43K 字符，被从中间切断 —— 调用方 JSON.parse 直接抛错，表现出来却是
 * 「仓库里没有这个文件」。截断 JSON 得到的不是短一点的答案，是垃圾。
 *
 * 现在：数组按条目截，对象把超大的 content 字段摘掉并打上 _truncated 标记，
 * 调用方看到标记就知道该改用 raw 模式去取。
 */
function fitJson(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { text: text.slice(0, maxChars), truncated: true, broken: true };
  }

  if (Array.isArray(data)) {
    const out = [];
    let size = 2;
    for (const item of data) {
      const chunk = JSON.stringify(item);
      if (size + chunk.length + 1 > maxChars) break;
      out.push(item);
      size += chunk.length + 1;
    }
    return { text: JSON.stringify(out), truncated: out.length < data.length };
  }

  if (data && typeof data === 'object') {
    const copy = { ...data };
    // 文件正文是最常见的超大字段
    if (copy.content) {
      delete copy.content;
      copy._hint = '正文太大，没有随 JSON 返回。用 raw:true 重新取这个路径。';
    }
    let out = JSON.stringify({ ...copy, _truncated: true });
    if (out.length <= maxChars) return { text: out, truncated: true };

    // 还是太大：找出最大的那个数组字段（git trees 的 tree、搜索结果的 items
    // 都是这个形状），按条目截到放得下为止。整体结构保持完整。
    let biggest = null;
    for (const [k, v] of Object.entries(copy)) {
      if (Array.isArray(v) && (!biggest || v.length > copy[biggest].length)) biggest = k;
    }
    if (biggest) {
      const arr = copy[biggest];
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const probe = JSON.stringify({ ...copy, [biggest]: arr.slice(0, mid), _truncated: true });
        if (probe.length <= maxChars) lo = mid;
        else hi = mid - 1;
      }
      out = JSON.stringify({ ...copy, [biggest]: arr.slice(0, lo), _truncated: true, _dropped: arr.length - lo });
      return { text: out, truncated: true };
    }

    return { text: out.slice(0, maxChars), truncated: true, broken: true };
  }

  return { text: text.slice(0, maxChars), truncated: true, broken: true };
}

async function githubApi(args, ctx, secrets) {
  const method = String(args.method || 'GET').toUpperCase();
  const raw = Boolean(args.raw);
  /*
   * JSON 返回值的字符上限。
   *
   * 默认 40000 是为了保护模型的上下文 —— 模型看不完也不该看几十万字符的 JSON。
   * 但应用内部的调用（列目录树找技能）是拿去做逻辑判断的，截断意味着**结果不完整**
   * 而不是「少看几行」。这个参数刻意不写进 registry 的 schema：它是给内部调用用的，
   * 不是给模型用的。
   */
  const maxChars = Math.min(2000000, Math.max(1000, Number(args.max_chars) || 40000));
  let p = String(args.path || '').trim();
  if (!p) return fail('path 不能为空');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.startsWith('/https://') || p.includes('://')) return fail('path 只写 API 路径，不要带域名');

  const token = await secrets('github');
  if (!token && method !== 'GET') {
    return fail('这个操作需要 GitHub Token。设置 → 工具 → GitHub 里填一个 personal access token。');
  }

  // 取公开仓库的文件正文：先试 CDN，省下一次 API 额度
  if (raw && method === 'GET') {
    const cdnUrl = toCdnUrl(p);
    if (cdnUrl) {
      try {
        const res = await fetchWithTimeout(cdnUrl, { headers: { 'User-Agent': 'wickrunAI' } }, ctx.toolTimeoutMs);
        if (res.ok) {
          const text = await res.text();
          const LIMIT = 400000;
          const body = text.length > LIMIT ? `${text.slice(0, LIMIT)}\n…（文件过大，已截断）` : text;
          return ok(body, { summary: `GitHub raw ${p}（${text.length} 字符，走 CDN 不计额度）` });
        }
        // 404 在公开仓库里就是「没这个文件」，不必再花一次 API 去确认
        if (res.status === 404 && !token) {
          return fail(`GitHub 返回 HTTP 404：${p} 不存在`);
        }
      } catch {
        /* CDN 挂了就退回 API */
      }
    }
  }

  try {
    const opts = { method, headers: headers(token, raw) };
    if (method !== 'GET' && method !== 'DELETE' && args.body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(args.body);
    }

    const res = await fetchWithTimeout(`${API}${p}`, opts, ctx.toolTimeoutMs);
    rememberRateLimit(res);
    const text = await res.text();

    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const mins = reset ? Math.max(1, Math.round((reset - Date.now()) / 60000)) : null;
      const extra =
        remaining === '0'
          ? `（API 每小时限额已用完${mins ? `，${mins} 分钟后自动恢复` : ''}。` +
            '限额是 GitHub 按 IP 算的，客户端没法重置；填一个 token 额度会从 60 变成 5000）'
          : '';
      return fail(`GitHub 返回 HTTP ${res.status}${extra}：${text.slice(0, 400)}`);
    }

    // raw 模式返回的是文件原文，截断它只是少看几行，不会让结构失效
    if (raw) {
      const LIMIT = 400000;
      const body = text.length > LIMIT ? `${text.slice(0, LIMIT)}\n…（文件过大，已截断）` : text;
      return ok(body, { summary: `GitHub raw ${p}（${text.length} 字符）` });
    }

    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* 不是 JSON 就原样返回 */
    }

    const fitted = fitJson(pretty, maxChars);
    return ok(fitted.text, {
      summary: `GitHub ${method} ${p}${fitted.truncated ? '（响应过大，已裁剪）' : ''}${rateLimitNote()}`,
    });
  } catch (e) {
    return fail(e);
  }
}

async function githubSearch(args, ctx, secrets) {
  const kind = String(args.kind || 'repositories');
  if (!['repositories', 'code', 'issues'].includes(kind)) {
    return fail('kind 只能是 repositories / code / issues');
  }
  const q = String(args.q || '').trim();
  if (!q) return fail('q 不能为空');
  const max = Math.min(30, Math.max(1, Number(args.max_results) || 10));

  const token = await secrets('github');
  if (kind === 'code' && !token) {
    return fail('GitHub 的代码搜索必须带 token。设置 → 工具 → GitHub 里填一个。');
  }

  try {
    const u = new URL(`${API}/search/${kind}`);
    u.searchParams.set('q', q);
    u.searchParams.set('per_page', String(max));

    const res = await fetchWithTimeout(u.toString(), { headers: headers(token) }, ctx.toolTimeoutMs);
    const text = await res.text();
    if (!res.ok) return fail(`GitHub 返回 HTTP ${res.status}：${text.slice(0, 400)}`);

    const data = JSON.parse(text);
    const items = data.items || [];
    if (!items.length) return ok('没有搜到结果。', { summary: `GitHub 搜索：0 条` });

    const sources = [];
    const lines = items.map((it, i) => {
      if (kind === 'repositories') {
        sources.push({ title: it.full_name, url: it.html_url, snippet: it.description || '' });
        return `${i + 1}. ${it.full_name}  ★${it.stargazers_count}  ${it.language || ''}\n   ${it.html_url}\n   ${it.description || '（无描述）'}`;
      }
      if (kind === 'code') {
        sources.push({ title: `${it.repository.full_name}/${it.path}`, url: it.html_url });
        return `${i + 1}. ${it.repository.full_name} — ${it.path}\n   ${it.html_url}`;
      }
      sources.push({ title: it.title, url: it.html_url, snippet: (it.body || '').slice(0, 200) });
      return `${i + 1}. #${it.number} ${it.title}  [${it.state}]\n   ${it.html_url}\n   ${(it.body || '').replace(/\s+/g, ' ').slice(0, 240)}`;
    });

    return ok(lines.join('\n\n'), {
      summary: `GitHub 搜索：${items.length} 条`,
      sources,
    });
  } catch (e) {
    return fail(e);
  }
}

module.exports = { githubApi, githubSearch, lastRateLimit: () => lastRateLimit };
