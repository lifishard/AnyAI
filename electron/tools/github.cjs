'use strict';
const { ok, fail, fetchWithTimeout, clip } = require('./common.cjs');

const API = 'https://api.github.com';

function headers(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AnyAI',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function githubApi(args, ctx, secrets) {
  const method = String(args.method || 'GET').toUpperCase();
  let p = String(args.path || '').trim();
  if (!p) return fail('path 不能为空');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.startsWith('/https://') || p.includes('://')) return fail('path 只写 API 路径，不要带域名');

  const token = await secrets('github');
  if (!token && method !== 'GET') {
    return fail('这个操作需要 GitHub Token。设置 → 工具 → GitHub 里填一个 personal access token。');
  }

  try {
    const opts = { method, headers: headers(token) };
    if (method !== 'GET' && method !== 'DELETE' && args.body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(args.body);
    }

    const res = await fetchWithTimeout(`${API}${p}`, opts, ctx.toolTimeoutMs);
    const text = await res.text();

    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const extra = remaining === '0' ? '（API 限额用完了；填上 token 额度会高很多）' : '';
      return fail(`GitHub 返回 HTTP ${res.status}${extra}：${text.slice(0, 400)}`);
    }

    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* 不是 JSON 就原样返回 */
    }

    return ok(clip(pretty, 40000), { summary: `GitHub ${method} ${p}` });
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

module.exports = { githubApi, githubSearch };
