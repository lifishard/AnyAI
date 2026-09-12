'use strict';
/**
 * 联网工具：搜索 + 抓网页。
 *
 * 搜索做成可切换的 provider，不跟任何一家绑死。
 * HTML 转 Markdown 是手写的轻量版，不引 turndown/cheerio —— 打包体积和
 * 依赖面都省下来，代价是对付奇葩页面时不如成熟库准。
 */
const { ok, fail, fetchWithTimeout, clip } = require('./common.cjs');

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

async function searchTavily(query, max, apiKey, timeoutMs) {
  const res = await fetchWithTimeout(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        api_key: apiKey, // 老版本认 body 里的 key，新版本认 Bearer，两个都给
        query,
        max_results: max,
        search_depth: 'basic',
        include_answer: false,
      }),
    },
    timeoutMs,
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Tavily 返回 HTTP ${res.status}：${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return (data.results || []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: r.content || '',
  }));
}

async function searchBrave(query, max, apiKey, timeoutMs) {
  const u = new URL('https://api.search.brave.com/res/v1/web/search');
  u.searchParams.set('q', query);
  u.searchParams.set('count', String(max));
  const res = await fetchWithTimeout(
    u.toString(),
    {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    },
    timeoutMs,
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Brave 返回 HTTP ${res.status}：${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const list = (data.web && data.web.results) || [];
  return list.map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: r.description || '',
  }));
}

async function searchSearxng(query, max, baseUrl, timeoutMs) {
  if (!baseUrl) throw new Error('没有配置 SearXNG 地址');
  const u = new URL('/search', baseUrl.replace(/\/+$/, ''));
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'json');
  const res = await fetchWithTimeout(u.toString(), { headers: { Accept: 'application/json' } }, timeoutMs);
  const text = await res.text();
  if (!res.ok) throw new Error(`SearXNG 返回 HTTP ${res.status}：${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return (data.results || []).slice(0, max).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: r.content || '',
  }));
}

async function webSearch(args, ctx, secrets) {
  const query = String(args.query || '').trim();
  if (!query) return fail('query 不能为空');
  const max = Math.min(10, Math.max(1, Number(args.max_results) || 6));
  const provider = ctx.searchProvider || 'tavily';

  try {
    let results;
    if (provider === 'tavily') {
      const key = await secrets('tavily');
      if (!key) return fail('还没填 Tavily API Key。设置 → 工具 → 搜索里填一个，或者切换到别的搜索源。');
      results = await searchTavily(query, max, key, ctx.toolTimeoutMs);
    } else if (provider === 'brave') {
      const key = await secrets('brave');
      if (!key) return fail('还没填 Brave Search API Key。设置 → 工具 → 搜索里填一个，或者切换到别的搜索源。');
      results = await searchBrave(query, max, key, ctx.toolTimeoutMs);
    } else {
      results = await searchSearxng(query, max, ctx.searxngUrl, ctx.toolTimeoutMs);
    }

    if (!results.length) return ok('没有搜到任何结果。换个关键词试试。', { summary: `搜索「${query}」：0 条` });

    const body = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${String(r.snippet).slice(0, 600)}`)
      .join('\n\n');

    return ok(body, {
      summary: `搜索「${query}」：${results.length} 条`,
      sources: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
    });
  } catch (e) {
    return fail(e);
  }
}

/* ------------------------------------------------------------------ *
 * 抓网页 + HTML → Markdown
 * ------------------------------------------------------------------ */

function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  };
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (named[n.toLowerCase()] !== undefined ? named[n.toLowerCase()] : m));
}

function htmlToMarkdown(html, baseUrl) {
  let s = String(html);

  // 先把真正不要的整块砍掉
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|iframe|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';

  // 正文优先：有 <article> 或 <main> 就只要那一块
  const article = s.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const main = s.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (article && article[1].length > 600) s = article[1];
  else if (main && main[1].length > 600) s = main[1];

  // 代码块
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, ''));
    return `\n\n\`\`\`\n${code.trim()}\n\`\`\`\n\n`;
  });
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, i) => `\`${decodeEntities(i.replace(/<[^>]+>/g, ''))}\``);

  // 标题
  for (let n = 1; n <= 6; n++) {
    const re = new RegExp(`<h${n}\\b[^>]*>([\\s\\S]*?)</h${n}>`, 'gi');
    s = s.replace(re, (_, i) => `\n\n${'#'.repeat(n)} ${i.replace(/<[^>]+>/g, '').trim()}\n\n`);
  }

  // 链接：相对地址补全成绝对地址，否则喂给模型没法用
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    if (!text) return '';
    let abs = href;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      /* 拼不出来就用原值 */
    }
    if (!abs || abs.startsWith('javascript:')) return text;
    return `[${text}](${abs})`;
  });

  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|section|h[1-6]|ul|ol|table)>/gi, '\n\n');
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, i) => `**${i.replace(/<[^>]+>/g, '')}**`);

  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();

  return { title, markdown: s };
}

async function fetchUrl(args, ctx) {
  const url = String(args.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return fail('url 必须是完整的 http(s) 地址');
  const maxChars = Math.min(120000, Math.max(500, Number(args.max_chars) || 20000));

  try {
    const res = await fetchWithTimeout(
      url,
      {
        redirect: 'follow',
        headers: {
          // 不少站点对没有 UA 的请求直接 403
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      },
      ctx.toolTimeoutMs,
    );

    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    const text = await res.text();

    if (!res.ok) {
      return fail(`抓取失败 HTTP ${res.status}。页面可能需要登录或做了反爬，可以改用 chrome_read_page。`);
    }

    if (ctype.includes('json')) {
      return ok(clip(text, maxChars), {
        summary: `读取 ${url}（JSON）`,
        sources: [{ title: url, url }],
      });
    }
    if (!ctype.includes('html') && !ctype.includes('xml') && !ctype.includes('text')) {
      return fail(`这个地址返回的是 ${ctype || '未知类型'}，不是网页或文本。`);
    }

    const { title, markdown } = htmlToMarkdown(text, url);
    if (!markdown.trim()) {
      return fail('页面抓到了但正文是空的 —— 多半是要 JS 渲染。改用 chrome_read_page 试试。');
    }

    return ok(`# ${title || url}\n\n来源：${url}\n\n${clip(markdown, maxChars)}`, {
      summary: `读取 ${title || url}`,
      sources: [{ title: title || url, url }],
    });
  } catch (e) {
    return fail(e);
  }
}

module.exports = { webSearch, fetchUrl, htmlToMarkdown };
