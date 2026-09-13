'use strict';
/**
 * 通过 Chrome DevTools Protocol 控制用户自己的 Chrome。
 *
 * 前提：Chrome 用 --remote-debugging-port=9222 启动。这样能直接用上你已经
 * 登录的会话（内网、需要登录的站点），代价是那个端口对本机所有进程都开着。
 *
 * 只用两类接口：
 *   - HTTP  /json/list、/json/new  —— 列标签页、开新页
 *   - WS    Runtime.evaluate 等    —— 读页面、点击、执行脚本
 */
const WebSocket = require('ws');
const { ok, fail, fetchWithTimeout, clip } = require('./common.cjs');
const { htmlToMarkdown } = require('./web.cjs');

function endpointBase(ctx) {
  return `http://127.0.0.1:${ctx.chromePort || 9222}`;
}

const HINT =
  'Chrome 没有开远程调试端口。请完全退出 Chrome，然后这样启动一次：\n' +
  '  chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\\Google\\Chrome\\User Data"\n' +
  '（把这行做成快捷方式最省事。端口要和设置里的一致。）';

async function listTargets(ctx) {
  let res;
  try {
    res = await fetchWithTimeout(`${endpointBase(ctx)}/json/list`, {}, 8000);
  } catch {
    throw new Error(HINT);
  }
  if (!res.ok) throw new Error(HINT);
  const all = await res.json();
  return all.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

async function pickTarget(ctx, tabId) {
  const pages = await listTargets(ctx);
  if (!pages.length) throw new Error('Chrome 里没有可操作的标签页。');
  if (tabId) {
    const hit = pages.find((p) => p.id === tabId);
    if (!hit) throw new Error(`找不到标签页 ${tabId}。先用 chrome_tabs 拿最新的 id。`);
    return hit;
  }
  return pages[0];
}

/** 连上一个 target，发若干条 CDP 指令，拿最后一条的结果 */
function cdp(wsUrl, commands, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    let id = 0;
    let idx = 0;
    let lastResult = null;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
      reject(new Error('Chrome 没有在预期时间内响应'));
    }, timeoutMs || 30000);

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
      if (err) reject(err);
      else resolve(val);
    };

    const sendNext = () => {
      if (idx >= commands.length) {
        finish(null, lastResult);
        return;
      }
      const cmd = commands[idx++];
      id += 1;
      cmd.__id = id;
      ws.send(JSON.stringify({ id, method: cmd.method, params: cmd.params || {} }));
    };

    ws.on('open', sendNext);
    ws.on('error', (e) => finish(new Error(`连接 Chrome 失败：${e.message}`)));
    ws.on('close', () => {
      if (!settled) finish(null, lastResult);
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id === undefined) return; // 事件推送，忽略
      if (msg.error) {
        finish(new Error(`CDP 错误：${msg.error.message || JSON.stringify(msg.error)}`));
        return;
      }
      lastResult = msg.result;
      sendNext();
    });
  });
}

async function evaluate(ctx, tabId, expression, timeoutMs) {
  const target = await pickTarget(ctx, tabId);
  const result = await cdp(
    target.webSocketDebuggerUrl,
    [
      {
        method: 'Runtime.evaluate',
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        },
      },
    ],
    timeoutMs,
  );
  if (result && result.exceptionDetails) {
    const d = result.exceptionDetails;
    throw new Error(`页面脚本抛错：${(d.exception && d.exception.description) || d.text}`);
  }
  return { target, value: result && result.result ? result.result.value : undefined };
}

/* ------------------------------------------------------------------ *
 * 对外的四个工具
 * ------------------------------------------------------------------ */

async function chromeTabs(_args, ctx) {
  try {
    const pages = await listTargets(ctx);
    const body = pages
      .map((p, i) => `${i + 1}. id=${p.id}\n   ${p.title}\n   ${p.url}`)
      .join('\n\n');
    return ok(body || '（没有打开的标签页）', { summary: `Chrome：${pages.length} 个标签页` });
  } catch (e) {
    return fail(e);
  }
}

async function chromeNavigate(args, ctx) {
  const url = String(args.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return fail('url 必须是完整的 http(s) 地址');

  try {
    if (args.tab_id) {
      const target = await pickTarget(ctx, String(args.tab_id));
      await cdp(
        target.webSocketDebuggerUrl,
        [{ method: 'Page.enable' }, { method: 'Page.navigate', params: { url } }],
        ctx.toolTimeoutMs,
      );
      await new Promise((r) => setTimeout(r, 1200)); // 给页面一点加载时间
      return ok(`已在标签页 ${target.id} 打开 ${url}`, { summary: `Chrome 打开 ${url}` });
    }

    const res = await fetchWithTimeout(
      `${endpointBase(ctx)}/json/new?${encodeURIComponent(url)}`,
      { method: 'PUT' },
      10000,
    );
    if (!res.ok) {
      // 老版本 Chrome 只认 GET
      const alt = await fetchWithTimeout(`${endpointBase(ctx)}/json/new?${encodeURIComponent(url)}`, {}, 10000);
      if (!alt.ok) throw new Error(HINT);
      const t = await alt.json();
      return ok(`已新开标签页 ${t.id}：${url}`, { summary: `Chrome 打开 ${url}` });
    }
    const t = await res.json();
    await new Promise((r) => setTimeout(r, 1200));
    return ok(`已新开标签页 ${t.id}：${url}`, { summary: `Chrome 打开 ${url}` });
  } catch (e) {
    return fail(e);
  }
}

/** 在页面里跑的正文提取脚本：优先 article/main，其次 body */
const EXTRACT_JS = `(() => {
  const pick = document.querySelector('article') || document.querySelector('main') || document.body;
  const clone = pick.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,svg,iframe,nav,footer,aside,form').forEach(n => n.remove());
  return JSON.stringify({ title: document.title, url: location.href, html: clone.innerHTML });
})()`;

async function chromeReadPage(args, ctx) {
  try {
    const maxChars = Math.min(120000, Math.max(500, Number(args.max_chars) || 20000));
    const { target, value } = await evaluate(ctx, args.tab_id, EXTRACT_JS, ctx.toolTimeoutMs);
    if (!value) return fail('没能从页面拿到内容。页面可能还没加载完。');

    let payload;
    try {
      payload = JSON.parse(value);
    } catch {
      return fail('页面返回的内容无法解析。');
    }

    const { markdown } = htmlToMarkdown(payload.html, payload.url);
    if (!markdown.trim()) return fail('页面正文是空的。');

    return ok(`# ${payload.title || payload.url}\n\n来源：${payload.url}\n\n${clip(markdown, maxChars)}`, {
      summary: `读取 Chrome 页面：${payload.title || target.url}`,
      sources: [{ title: payload.title || payload.url, url: payload.url }],
    });
  } catch (e) {
    return fail(e);
  }
}

async function chromeClick(args, ctx) {
  const selector = String(args.selector || '').trim();
  if (!selector) return fail('selector 不能为空');
  try {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOT_FOUND';
      el.scrollIntoView({ block: 'center' });
      el.click();
      return 'OK';
    })()`;
    const { value } = await evaluate(ctx, args.tab_id, expr, ctx.toolTimeoutMs);
    if (value === 'NOT_FOUND') return fail(`选择器 ${selector} 没有匹配到元素`);
    await new Promise((r) => setTimeout(r, 800));
    return ok(`已点击 ${selector}`, { summary: `Chrome 点击 ${selector}` });
  } catch (e) {
    return fail(e);
  }
}

async function chromeEval(args, ctx) {
  const expression = String(args.expression || '').trim();
  if (!expression) return fail('expression 不能为空');
  try {
    const { value } = await evaluate(ctx, args.tab_id, expression, ctx.toolTimeoutMs);
    let text;
    if (value === undefined) text = '(undefined)';
    else if (typeof value === 'string') text = value;
    else {
      try {
        text = JSON.stringify(value, null, 2);
      } catch {
        text = String(value);
      }
    }
    return ok(ctx.execution ? text : clip(text, 40000), { summary: 'Chrome 执行脚本完成' });
  } catch (e) {
    return fail(e);
  }
}

async function chromeFetchJson(args, ctx) {
  try {
    const options = { path: String(args.path || ''), fields: args.fields, items_path: args.items_path,
      offset: args.offset, limit: args.limit };
    const project = require('./json-page.cjs').projectJson;
    const expr = `(async () => {
      const options = ${JSON.stringify(options)};
      const url = new URL(options.path, location.href);
      if (!/^https?:$/.test(url.protocol) || url.origin !== location.origin) throw new Error('只能读取当前标签页同源的已登录 API');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(url.href, { credentials: 'same-origin', signal: controller.signal });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch { return { httpStatus: response.status, error: '返回值不是 JSON', sample: text.slice(0, 1200) }; }
        if (!response.ok) return { httpStatus: response.status, error: JSON.stringify(data).slice(0, 2000) };
        const result = (${project.toString()})(data, options);
        const link = response.headers.get('link') || '';
        const next = link.match(/<([^>]+)>;\\s*rel=["']?next["']?/i);
        return { httpStatus: response.status, url: url.href, ...result, nextPage: next ? next[1] : null };
      } finally { clearTimeout(timer); }
    })()`;
    const { value } = await evaluate(ctx, args.tab_id, expr, 25000);
    if (value?.error) return fail(`HTTP ${value.httpStatus}：${value.error}`);
    return ok(JSON.stringify(value), { summary: `读取已登录 API（${value?.items?.length ?? 0} 条）`,
      sources: value?.url ? [{ title: '已登录页面的 API 数据', url: value.url }] : [] });
  } catch (e) { return fail(e); }
}

module.exports = { chromeTabs, chromeNavigate, chromeReadPage, chromeClick, chromeEval, chromeFetchJson };
