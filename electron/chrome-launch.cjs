'use strict';
/**
 * Launch a controllable browser with a dedicated, persistent profile.
 *
 * Chrome 136+ ignores --remote-debugging-port for its default profile, so this
 * module always uses wickrunAI's own profile. The launch record contains only
 * a port and executable path; cookies and login data stay inside Chrome.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const LEGACY_NAMES = ['wickrunAI', 'wickrunai', 'SenseNova Chat', 'sensenova-chat', 'SenseNova-Chat'];

function createChromeLaunch(deps = {}) {
  const electronApp = deps.app || app;
  const io = deps.fs || fs;
  const startProcess = deps.spawn || spawn;
  const request = deps.fetch || fetch;
  const environment = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const wait = deps.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));

  const userData = () => path.resolve(electronApp.getPath('userData'));
  const stateFile = () => path.join(userData(), 'chrome-connection.json');

  function migrateLegacyProfile(target) {
    if (io.existsSync(target)) return;
    const root = userData();
    let appData;
    try { appData = path.resolve(electronApp.getPath('appData')); } catch { return; }
    // Explicitly isolated Electron profiles stay isolated. Only the canonical
    // installed profile adopts data from an earlier app name.
    if (path.dirname(root) !== appData || path.basename(root).toLowerCase() !== 'anyai') return;
    for (const name of LEGACY_NAMES) {
      const candidate = path.join(appData, name, 'chrome-profile');
      if (path.resolve(candidate) === path.resolve(target)) continue;
      try {
        if (!io.existsSync(candidate)) continue;
        io.mkdirSync(path.dirname(target), { recursive: true });
        io.renameSync(candidate, target);
        return;
      } catch {
        // Never copy a live cookie database partially. Leave the source intact.
      }
    }
  }

  function profileDir() {
    const target = path.join(userData(), 'chrome-profile');
    migrateLegacyProfile(target);
    return target;
  }

  function findBrowser() {
    const candidates = [];
    if (platform === 'win32') {
      const pf = environment['ProgramFiles'] || 'C:\\Program Files';
      const pf86 = environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      const local = environment.LOCALAPPDATA || '';
      candidates.push(
        { name: 'Chrome', p: path.join(pf, 'Google\\Chrome\\Application\\chrome.exe') },
        { name: 'Chrome', p: path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe') },
        { name: 'Chrome', p: path.join(local, 'Google\\Chrome\\Application\\chrome.exe') },
        { name: 'Edge', p: path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe') },
        { name: 'Edge', p: path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe') },
      );
    } else if (platform === 'darwin') {
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
    for (const candidate of candidates) {
      try { if (candidate.p && io.existsSync(candidate.p)) return candidate; } catch { /* next */ }
    }
    return null;
  }

  async function probe(port) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await request(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return { running: false };
      const info = await res.json();
      return { running: true, browser: info.Browser || '' };
    } catch { return { running: false }; }
  }

  function readState() {
    try {
      const value = JSON.parse(io.readFileSync(stateFile(), 'utf8'));
      if (value?.version !== 1 || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) return null;
      if (typeof value.browserPath !== 'string' || !path.isAbsolute(value.browserPath)) return null;
      return value;
    } catch { return null; }
  }

  function writeState(port, browserPath) {
    const target = stateFile(), tmp = `${target}.${crypto.randomUUID()}.tmp`;
    io.mkdirSync(path.dirname(target), { recursive: true });
    try {
      io.writeFileSync(tmp, JSON.stringify({ version: 1, port, browserPath, updatedAt: Date.now() }), { mode: 0o600 });
      io.renameSync(tmp, target);
    } finally { try { io.unlinkSync(tmp); } catch { /* renamed */ } }
  }

  async function status(port) {
    const found = findBrowser(), current = await probe(port), remembered = readState();
    return {
      running: current.running, browser: current.browser || '', browserPath: found?.p || '', browserName: found?.name || '',
      profileDir: profileDir(), port, restoreOnLaunch: remembered?.port === port,
    };
  }

  async function launch(port, customPath, options = {}) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, error: 'Chrome 调试端口需要是 1024–65535 的整数。' };
    const already = await probe(port), remembered = readState();
    if (already.running) {
      return { ok: true, alreadyRunning: true, browser: already.browser, profileDir: profileDir(), restored: remembered?.port === port };
    }
    const found = customPath && path.isAbsolute(customPath) && io.existsSync(customPath)
      ? { name: path.basename(customPath), p: customPath }
      : findBrowser();
    if (!found) return { ok: false, error: '没找到 Chrome / Edge 的可执行文件。装一个 Chrome，或者在设置里手动选择浏览器程序。' };
    const dir = profileDir();
    try { io.mkdirSync(dir, { recursive: true }); }
    catch (error) { return { ok: false, error: `建不了专属浏览器配置目录：${error.message}` }; }
    const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'];
    try { const child = startProcess(found.p, args, { detached: true, stdio: 'ignore', windowsHide: false }); child.unref(); }
    catch (error) { return { ok: false, error: `启动失败：${error.message}` }; }
    for (let i = 0; i < 32; i++) {
      await wait(250);
      const current = await probe(port);
      if (current.running) {
        if (options.remember !== false) writeState(port, found.p);
        return { ok: true, alreadyRunning: false, browser: current.browser, browserName: found.name, profileDir: dir, restored: options.restored === true };
      }
    }
    return { ok: false, error: `${found.name} 已启动，但调试连接没有就绪。请完全退出该浏览器后再试一次。` };
  }

  async function restore() {
    const remembered = readState();
    if (!remembered) return { ok: true, skipped: true, reason: '没有保存的专属浏览器连接' };
    return launch(remembered.port, remembered.browserPath, { remember: false, restored: true });
  }

  return { launch, restore, status, profileDir, findBrowser };
}

const singleton = createChromeLaunch();
module.exports = { ...singleton, createChromeLaunch };
