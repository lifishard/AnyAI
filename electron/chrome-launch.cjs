'use strict';
/**
 * 帮用户把「能被控制的 Chrome」拉起来。
 *
 * 关键背景：Chrome 136 之后，--remote-debugging-port 在**默认用户目录**下会被
 * 直接忽略（Google 的安全变更，防的是拿调试端口偷 cookie）。所以必须指定一个
 * 非默认的 --user-data-dir，否则端口根本不会监听。
 *
 * 于是这里用一份独立的持久化配置目录：第一次要在那个窗口里登录一遍你要用的
 * 网站，之后配置一直留着，不用重复登录。换来的是不碰你日常那份 Chrome 配置。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { app } = require('electron');

function profileDir() {
  return path.join(app.getPath('userData'), 'chrome-profile');
}

/** 找一个能用的 Chromium 系浏览器。Edge 也走 CDP，Windows 上当兜底 */
function findBrowser() {
  const candidates = [];

  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    candidates.push(
      { name: 'Chrome', p: path.join(pf, 'Google\\Chrome\\Application\\chrome.exe') },
      { name: 'Chrome', p: path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe') },
      { name: 'Chrome', p: path.join(local, 'Google\\Chrome\\Application\\chrome.exe') },
      { name: 'Edge', p: path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe') },
      { name: 'Edge', p: path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe') },
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      { name: 'Chrome', p: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Chromium', p: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
      { name: 'Edge', p: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    );
  } else {
    candidates.push(
      { name: 'Chrome', p: '/usr/bin/google-chrome' },
      { name: 'Chrome', p: '/usr/bin/google-chrome-stable' },
      { name: 'Chromium', p: '/usr/bin/chromium' },
      { name: 'Chromium', p: '/usr/bin/chromium-browser' },
    );
  }

  for (const c of candidates) {
    try {
      if (c.p && fs.existsSync(c.p)) return c;
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
}

/** 端口上有没有一个活着的调试实例 */
async function probe(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { running: false };
    const info = await res.json();
    return { running: true, browser: info.Browser || '' };
  } catch {
    return { running: false };
  }
}

async function status(port) {
  const found = findBrowser();
  const p = await probe(port);
  return {
    running: p.running,
    browser: p.browser || '',
    browserPath: found ? found.p : '',
    browserName: found ? found.name : '',
    profileDir: profileDir(),
    port,
  };
}

async function launch(port, customPath) {
  const already = await probe(port);
  if (already.running) {
    return { ok: true, alreadyRunning: true, browser: already.browser, profileDir: profileDir() };
  }

  const found = customPath && fs.existsSync(customPath)
    ? { name: path.basename(customPath), p: customPath }
    : findBrowser();

  if (!found) {
    return {
      ok: false,
      error:
        '没找到 Chrome / Edge 的可执行文件。装一个 Chrome，或者在设置里手动填 chrome.exe 的绝对路径。',
    };
  }

  const dir = profileDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `建不了配置目录 ${dir}：${e.message}` };
  }

  const args = [
    `--remote-debugging-port=${port}`,
    // 必须是非默认目录，否则 Chrome 136+ 会无视调试端口
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];

  try {
    const child = spawn(found.p, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  } catch (e) {
    return { ok: false, error: `启动失败：${e.message}` };
  }

  // 等它把端口监听起来，最多 8 秒
  for (let i = 0; i < 32; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const p = await probe(port);
    if (p.running) {
      return {
        ok: true,
        alreadyRunning: false,
        browser: p.browser,
        browserName: found.name,
        profileDir: dir,
      };
    }
  }

  return {
    ok: false,
    error:
      `${found.name} 起来了，但 ${port} 端口没有开始监听。` +
      '如果你本来就开着同名浏览器，先把它全部退干净再试一次 —— ' +
      '已有实例在跑的时候，新进程只会把请求转给旧实例，不会带上调试端口。',
  };
}

module.exports = { launch, status, profileDir, findBrowser };
